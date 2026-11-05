// One-way planned meals only. Recipe bodies, images and ingredients stay in Mealie.
import { z } from '@hono/zod-openapi';
import type { Env, WaitCtx } from './env.ts';
import { decryptConfig } from './crypto.ts';
import { isSafeOutboundUrl, outboundFetch } from './outbound.ts';
import { MealDateSchema, type Meal } from './meal-schemas.ts';
import { mealWrite, mealApi, type MealRow } from './meals.ts';
import { readFeatures } from './routes/settings.ts';
import { publish } from './bus.ts';
import { stored } from './i18n.ts';
import { householdTz } from './sync.ts';

export type MealieConfig = { url: string; groupSlug: string; token: string };
export type MealieRow = { config: string; last_synced_at: string | null; last_error: string | null; lease_until: number; lease: string | null };
export const mealieRow = (env: Env) => env.DB.prepare('SELECT * FROM mealie_connection WHERE id = 1').first<MealieRow>();
export const MEALIE_BUSY = stored('error', 'Mealie is syncing. Try again in a few minutes.');
export const MEALIE_FAILED = stored('error', 'Could not sync Mealie. Check its address, API token and availability.');
export const MEALIE_URL = stored('error', 'Use a public HTTPS Mealie address. For a local server, enable ALLOW_PRIVATE_MEALIE_URLS=1 on self-hosted Kinwall.');
const DEFAULT_SERVINGS = 4;
export class MealieError extends Error {
  status: 400 | 409 | 502;
  constructor(status: 400 | 409 | 502, message: string) { super(message); this.status = status; }
}
export function mealieUrl(env: Env, raw: string): string {
  try {
    const u = new URL(raw);
    if (u.username || u.password || u.search || u.hash || !['http:', 'https:'].includes(u.protocol)) throw new Error();
    if (env.ALLOW_PRIVATE_MEALIE_URLS !== '1' && (u.protocol !== 'https:' || !isSafeOutboundUrl(u.href))) throw new Error();
    return u.href.replace(/\/+$/, '');
  } catch { throw new MealieError(400, MEALIE_URL); }
}
const Entry = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), date: MealDateSchema,
  entryType: z.enum(['breakfast', 'lunch', 'dinner', 'side', 'snack', 'drink', 'dessert']),
  title: z.string().max(10000).default(''), endDate: z.string().nullable().optional(),
  recipe: z.object({ name: z.string().min(1).max(10000), slug: z.string().min(1).max(1000) }).nullable().optional(),
});
// Bound headers and streamed body; never forward provider error bodies (may contain secrets).
async function page(env: Env, cfg: MealieConfig, from: string, to: string, n: number) {
  const url = new URL(`${mealieUrl(env, cfg.url)}/api/households/mealplans`);
  // Mealie 3.29 only permits filterable columns here; its inherited id is not one.
  url.search = new URLSearchParams({ start_date: from, end_date: to, page: String(n), perPage: '100', orderBy: 'date', orderDirection: 'asc' }).toString();
  const res = await outboundFetch(env, env.ALLOW_PRIVATE_MEALIE_URLS === '1')(url, {
    // The Node address-checking transport requires manual mode. Non-2xx responses below
    // reject redirects, so neither Node nor Workers forwards the token to another URL.
    headers: { Authorization: ['Bearer', cfg.token].join(' '), Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(10000),
  });
  if (!res.ok || !res.body || Number(res.headers.get('content-length')) > 2_000_000) { await res.body?.cancel(); throw new Error(); }
  const reader = res.body.getReader(); const decoder = new TextDecoder(); let size = 0, text = '';
  for (let part = await reader.read(); !part.done; part = await reader.read()) {
    size += part.value.length; if (size > 2_000_000) { await reader.cancel(); throw new Error(); }
    text += decoder.decode(part.value, { stream: true });
  }
  text += decoder.decode();
  const result = z.object({ items: z.array(Entry).max(1000), total_pages: z.number().int().min(0).max(20) }).parse(JSON.parse(text));
  if ((result.total_pages > 1 && !result.items.length) || (result.total_pages === 0 && result.items.length)) throw new Error();
  return result;
}
/** Lease serializes manual/background sync and connection changes across isolates. */
export async function syncMealie(env: Env, from: string, to: string, ctx?: WaitCtx): Promise<{ imported: number; removed: number }> {
  if (!(await readFeatures(env.DB)).meals) throw new MealieError(400, stored('error', 'Turn on Meals before syncing Mealie.'));
  const lease = crypto.randomUUID();
  const lock = await env.DB.prepare('UPDATE mealie_connection SET lease = ?, lease_until = ? WHERE id = 1 AND lease_until < ?').bind(lease, Date.now() + 300000, Date.now()).run();
  if (!lock.meta.changes) throw new MealieError(409, MEALIE_BUSY);
  try {
    const row = (await mealieRow(env))!; const cfg = await decryptConfig(env, 'mealie', row.config) as MealieConfig;
    const entries: z.infer<typeof Entry>[] = []; let pages = 1;
    for (let n = 1; n <= pages; n++) {
      const result = await page(env, cfg, from, to, n);
      if (n > 1 && result.total_pages !== pages) throw new Error();
      pages = Math.max(1, result.total_pages); entries.push(...result.items);
    }
    const ids = new Set<number>();
    for (const e of entries) {
      if (ids.has(e.id) || e.endDate || e.date < from || e.date > to || !(e.title.trim() || e.recipe?.name.trim())) throw new Error();
      ids.add(e.id);
    }
    const links = (await env.DB.prepare('SELECT mealie_meals.remote_id, meals.* FROM mealie_meals JOIN meals ON meals.id = mealie_meals.meal_id').all<MealRow & { remote_id: number }>()).results;
    const existing = new Map(links.map(l => [l.remote_id, mealApi(l)]));
    const writes = []; const now = new Date().toISOString(); let imported = 0, removed = 0;
    for (const e of entries) {
      const old = existing.get(e.id) ?? null;
      const title = (e.title.trim() || e.recipe!.name.trim()).slice(0, 200);
      const slot: Meal['slot'] = ['breakfast', 'lunch', 'dinner'].includes(e.entryType) ? e.entryType as Meal['slot'] : 'snack';
      const sourceUrl = e.recipe ? `${cfg.url}/g/${encodeURIComponent(cfg.groupSlug)}/r/${encodeURIComponent(e.recipe.slug)}` : null;
      if (sourceUrl && sourceUrl.length > 2000) throw new Error();
      if (old?.calendarEventId) continue; // a calendar-linked meal is pinned to avoid changing its event behind its back
      if (old && old.date === e.date && old.title === title && old.slot === slot && old.sourceUrl === sourceUrl) continue;
      const meal = { servings: DEFAULT_SERVINGS, assigneeMemberId: null, eaterIds: [], notes: null, plannedTime: null, calendarEventId: null, calendarEventStart: null, status: 'planned' as const, createdAt: now, ...old,
        id: old?.id ?? crypto.randomUUID(), date: e.date, title, slot, mealKind: 'freeform' as const, sourceUrl, recipeId: null, recipeSnapshot: null, restaurantId: null, orderType: null, updatedAt: now };
      writes.push(mealWrite(env.DB, meal), env.DB.prepare('INSERT INTO mealie_meals(remote_id,meal_id) VALUES (?,?) ON CONFLICT(remote_id) DO UPDATE SET meal_id=excluded.meal_id').bind(e.id, meal.id)); imported++;
    }
    for (const link of links) {
      if (ids.has(link.remote_id)) continue;
      const meal = existing.get(link.remote_id);
      if (!meal || meal.date < from || meal.date > to) continue;
      // Local planning belongs to Kinwall too: don't discard a cook, eaters, servings or time
      // merely because Mealie removed the entry. Keep that meal and detach it from sync.
      const untouched = meal.status === 'planned' && !meal.notes && !meal.calendarEventId
        && !meal.assigneeMemberId && !meal.eaterIds.length && meal.servings === DEFAULT_SERVINGS && !meal.plannedTime;
      if (untouched) { writes.push(env.DB.prepare('DELETE FROM meals WHERE id = ?').bind(meal.id)); removed++; }
      writes.push(env.DB.prepare('DELETE FROM mealie_meals WHERE remote_id = ?').bind(link.remote_id));
    }
    writes.push(env.DB.prepare('UPDATE mealie_connection SET last_synced_at = ?, last_error = NULL WHERE id = 1 AND lease = ?').bind(now, lease));
    await env.DB.batch(writes);
    if (imported || removed) publish(env, ctx, 'meal.changed', { source: 'mealie' });
    return { imported, removed };
  } catch {
    await env.DB.prepare('UPDATE mealie_connection SET last_error = ? WHERE id = 1 AND lease = ?').bind(MEALIE_FAILED, lease).run();
    throw new MealieError(502, MEALIE_FAILED);
  } finally { await env.DB.prepare('UPDATE mealie_connection SET lease_until = 0, lease = NULL WHERE id = 1 AND lease = ?').bind(lease).run(); }
}
export async function syncDueMealie(env: Env, ctx?: WaitCtx): Promise<void> {
  const row = await mealieRow(env); if (!row || row.lease_until >= Date.now() || (row.last_synced_at && Date.now() - Date.parse(row.last_synced_at) < 900000) || !(await readFeatures(env.DB)).meals) return;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: await householdTz(env.DB), year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const part = (key: string) => parts.find(p => p.type === key)!.value;
  const day = Date.parse(`${part('year')}-${part('month')}-${part('day')}`);
  try { await syncMealie(env, new Date(day - 7 * 86400000).toISOString().slice(0, 10), new Date(day + 35 * 86400000).toISOString().slice(0, 10), ctx); } catch { /* redacted status; next tick retries */ }
}
