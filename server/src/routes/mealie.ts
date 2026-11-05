import { createRoute, z } from '@hono/zod-openapi';
import { createRouter } from '../router.ts';
import { ErrorSchema } from '../schemas.ts';
import { requestKey, isConnectedApp } from '../auth.ts';
import { encryptConfig, decryptConfig } from '../crypto.ts';
import { MealDateSchema } from '../meal-schemas.ts';
import { browseMealieRecipes, MealieRecipesSchema, mealieRow, mealieUrl, syncMealie, MealieError, MEALIE_BUSY, type MealieConfig } from '../mealie.ts';
import { requestLang, translateError, stored } from '../i18n.ts';

export const mealieRoutes = createRouter();
const Input = z.object({ url: z.string().trim().max(2000), groupSlug: z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/), token: z.string().trim().min(1).max(4096).regex(/^[^\r\n]+$/).optional() }).strict();
const Range = z.object({ from: MealDateSchema, to: MealDateSchema }).strict().refine(r => r.from <= r.to && Date.parse(r.to) - Date.parse(r.from) <= 90 * 86400000, 'choose an ordered range of up to 91 days');
const Status = z.object({ connected: z.boolean(), url: z.string().nullable(), groupSlug: z.string().nullable(), lastSyncedAt: z.string().nullable(), lastError: z.string().nullable() });
const Result = z.object({ imported: z.number(), removed: z.number() });
const ok = { description: 'ok', content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } } };
const error = { description: 'invalid request, forbidden, busy or Mealie unavailable', content: { 'application/json': { schema: ErrorSchema } } };
const errors = { 400: error, 403: error, 409: error, 502: error };
const security = [{ Bearer: [] }];
mealieRoutes.use('/api/integrations/mealie*', async (c, next) => {
  if ((await requestKey(c))?.scope !== 'admin' || await isConnectedApp(c)) return c.json({ error: stored('error', "Manage Mealie from a parent's device.") }, 403);
  c.header('Cache-Control', 'no-store');
  await next();
});
mealieRoutes.openapi(createRoute({ method: 'get', path: '/api/integrations/mealie', tags: ['Meals'], security, summary: 'Read Mealie connection status (parent; never returns the token)', responses: { 200: { description: 'status', content: { 'application/json': { schema: Status } } }, ...errors } }), async c => {
  const row = await mealieRow(c.env); const cfg = row ? await decryptConfig(c.env, 'mealie', row.config) as MealieConfig : null;
  return c.json({ connected: !!row, url: cfg?.url ?? null, groupSlug: cfg?.groupSlug ?? null, lastSyncedAt: row?.last_synced_at ?? null, lastError: row?.last_error ? translateError(await requestLang(c), row.last_error) : null }, 200);
});
mealieRoutes.openapi(createRoute({ method: 'put', path: '/api/integrations/mealie', tags: ['Meals'], security, summary: 'Save an encrypted Mealie API token (parent). Disconnect before changing server or group; omitted token keeps the existing one', request: { body: { content: { 'application/json': { schema: Input } } } }, responses: { 200: ok, ...errors } }), async c => {
  const input = c.req.valid('json'); let url: string;
  try { url = mealieUrl(c.env, input.url); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
  const old = await mealieRow(c.env); const cfg = old ? await decryptConfig(c.env, 'mealie', old.config) as MealieConfig : null;
  if (cfg && (cfg.url !== url || cfg.groupSlug !== input.groupSlug)) return c.json({ error: stored('error', 'Disconnect Mealie before changing its server or group.') }, 409);
  const token = input.token ?? cfg?.token; if (!token) return c.json({ error: stored('error', 'Add a Mealie API token.') }, 400);
  const sealed = await encryptConfig(c.env, 'mealie', { url, groupSlug: input.groupSlug, token });
  const changed = await c.env.DB.prepare('INSERT INTO mealie_connection(id,config) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config,last_error=NULL,last_synced_at=NULL WHERE mealie_connection.lease_until < ?').bind(sealed, Date.now()).run();
  return changed.meta.changes ? c.json({ ok: true }, 200) : c.json({ error: MEALIE_BUSY }, 409);
});
mealieRoutes.openapi(createRoute({ method: 'delete', path: '/api/integrations/mealie', tags: ['Meals'], security, summary: 'Disconnect Mealie, retaining imported meals as ordinary local meals', responses: { 200: ok, ...errors } }), async c => {
  const result = await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM mealie_connection WHERE id = 1 AND lease_until < ?').bind(Date.now()),
    c.env.DB.prepare('DELETE FROM mealie_meals WHERE NOT EXISTS (SELECT 1 FROM mealie_connection)'),
  ]);
  if (!result[0].results.length && await mealieRow(c.env)) return c.json({ error: MEALIE_BUSY }, 409);
  return c.json({ ok: true }, 200);
});
mealieRoutes.openapi(createRoute({ method: 'post', path: '/api/integrations/mealie/sync', tags: ['Meals'], security, summary: 'Pull dated Mealie meal plans for an inclusive range (parent); never writes to Mealie', request: { body: { content: { 'application/json': { schema: Range } } } }, responses: { 200: { description: 'counts', content: { 'application/json': { schema: Result } } }, ...errors } }), async c => {
  const { from, to } = c.req.valid('json');
  try { return c.json(await syncMealie(c.env, from, to), 200); }
  catch (e) { if (e instanceof MealieError) return c.json({ error: e.message }, e.status); throw e; }
});

mealieRoutes.openapi(createRoute({ method: 'get', path: '/api/integrations/mealie/recipes', tags: ['Meals'], security, summary: 'Browse Mealie recipe names and links for local meal planning (parent; read-only)', request: { query: z.object({ search: z.string().trim().max(200).default(''), page: z.coerce.number().int().min(1).max(100000).default(1) }) }, responses: { 200: { description: 'recipes', content: { 'application/json': { schema: MealieRecipesSchema } } }, ...errors } }), async c => {
  const { search, page } = c.req.valid('query');
  try { return c.json(await browseMealieRecipes(c.env, search, page), 200); }
  catch (e) { if (e instanceof MealieError) return c.json({ error: e.message }, e.status); throw e; }
});
