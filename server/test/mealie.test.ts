import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.ts';
import { openDb, applyMigrations } from '../src/d1-sqlite.ts';
import type { Env } from '../src/env.ts';
import { createApiKey } from '../src/auth.ts';

function fixture() {
  const db = openDb(':memory:'); applyMigrations(db, fileURLToPath(new URL('../migrations', import.meta.url)));
  const env: Env = { DB: db, ADMIN_API_KEY: 'test-admin', ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' };
  const app = createApp();
  const req = (path: string, method = 'GET', body?: unknown, key = 'test-admin') => app.request(path, { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
  const json = async (path: string, method = 'GET', body?: unknown) => { const r = await req(path, method, body); const d = await r.json() as any; assert.ok(r.ok, JSON.stringify(d)); return d; };
  return { db, env, req, json };
}
const config = { url: 'https://mealie.example', groupSlug: 'home', token: 'obvious-fake-token' };
const range = { from: '2026-11-01', to: '2026-11-30' };
const plan = (id: number, title = 'Pasta', date = '2026-11-08') => ({ id, date, entryType: 'dinner', title: '', text: 'Mealie note', recipe: { name: title, slug: 'pasta' } });

test('Mealie stores a sealed token, pulls pages once, updates without recipes, and reconciles only its meals', async () => {
  const { env, db, json } = fixture();
  await json('/api/integrations/mealie', 'PUT', config);
  const status = await json('/api/integrations/mealie'); assert.equal(status.connected, true); assert.ok(!JSON.stringify(status).includes(config.token));
  const raw = await db.prepare('SELECT config FROM mealie_connection').first<{ config: string }>(); assert.ok(raw!.config.startsWith('v1:')); assert.ok(!raw!.config.includes(config.token));
  let entries = [plan(1), plan(2, 'Salad')]; let requests = 0;
  env.OUTBOUND_FETCH = async (url, init) => { requests++; assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${config.token}`); assert.equal(init?.redirect, 'error'); const u = new URL(String(url)); assert.equal(u.pathname, '/api/households/mealplans'); assert.equal(u.searchParams.get('start_date'), range.from); const page = Number(u.searchParams.get('page')); return Response.json({ items: entries.slice(page - 1, page), total_pages: entries.length || 1 }); };
  await json('/api/integrations/mealie/sync', 'POST', range); assert.equal(requests, 2);
  let meals = await json(`/api/meals?${new URLSearchParams(range)}`); assert.equal(meals.length, 2); assert.equal(meals[0].recipeId, null); assert.equal(meals[0].recipeSnapshot, null); assert.equal(meals[0].sourceUrl, 'https://mealie.example/g/home/r/pasta'); assert.equal((await json('/api/recipes')).length, 0);
  const first = meals.find((m: any) => m.title === 'Pasta'); await json(`/api/meals/${first.id}`, 'PATCH', { notes: 'Keep my note', status: 'prepared' });
  await json('/api/meals', 'POST', { date: '2026-11-09', slot: 'lunch', title: 'Local meal' });
  entries = [plan(1, 'Updated pasta', '2026-11-10')]; await json('/api/integrations/mealie/sync', 'POST', range);
  meals = await json(`/api/meals?${new URLSearchParams(range)}`); assert.equal(meals.length, 2); const kept = meals.find((m: any) => m.id === first.id); assert.equal(kept.title, 'Updated pasta'); assert.equal(kept.notes, 'Keep my note'); assert.equal(kept.status, 'prepared');
  await json('/api/integrations/mealie', 'DELETE'); assert.equal((await json(`/api/meals?${new URLSearchParams(range)}`)).length, 2); assert.equal((await json('/api/integrations/mealie')).connected, false);
});

test('Mealie failures and malformed pagination leave previously imported meals intact', async () => {
  const { env, json } = fixture(); await json('/api/integrations/mealie', 'PUT', config);
  env.OUTBOUND_FETCH = async () => Response.json({ items: [plan(1)], total_pages: 1 }); await json('/api/integrations/mealie/sync', 'POST', range);
  env.OUTBOUND_FETCH = async () => Response.json({ items: [], total_pages: 2 });
  const error = await (await fixtureFailure()).json() as any; assert.ok(!JSON.stringify(error).includes(config.token));
  async function fixtureFailure() { const r = await createApp().request('/api/integrations/mealie/sync', { method: 'POST', headers: { Authorization: 'Bearer test-admin', 'Content-Type': 'application/json' }, body: JSON.stringify(range) }, env); assert.equal(r.status, 502); return r; }
  assert.equal((await json(`/api/meals?${new URLSearchParams(range)}`)).length, 1);
  env.OUTBOUND_FETCH = async () => { throw new Error(`secret ${config.token}`); }; await fixtureFailure(); assert.ok(!(JSON.stringify(await json('/api/integrations/mealie'))).includes(config.token));
});

test('Mealie rejects unsafe URLs, wall devices, stale leases and changing servers in place', async () => {
  const { env, db, req, json } = fixture();
  assert.equal((await req('/api/integrations/mealie', 'PUT', { ...config, url: 'http://192.168.1.69:9925' })).status, 400);
  assert.equal((await req('/api/integrations/mealie', 'PUT', { ...config, url: 'https://user:pass@mealie.example' })).status, 400);
  const display = await createApiKey(db, 'wall', 'display'); assert.equal((await req('/api/integrations/mealie', 'GET', undefined, display.key)).status, 403);
  await json('/api/integrations/mealie', 'PUT', config);
  assert.equal((await req('/api/integrations/mealie', 'PUT', { ...config, url: 'https://other.example' })).status, 409);
  await db.prepare('UPDATE mealie_connection SET lease_until = ?').bind(Date.now() + 60000).run();
  assert.equal((await req('/api/integrations/mealie/sync', 'POST', range)).status, 409); assert.equal((await req('/api/integrations/mealie', 'DELETE')).status, 409);
  env.OUTBOUND_FETCH = async () => new Response(null, { status: 302, headers: { Location: 'https://evil.example' } });
  await db.prepare('UPDATE mealie_connection SET lease_until = 0').run(); assert.equal((await req('/api/integrations/mealie/sync', 'POST', range)).status, 502);
});

test('Mealie no-op sync preserves ids; later-page failures and duplicate ids never partially reconcile', async () => {
  const { env, json, req } = fixture(); await json('/api/integrations/mealie', 'PUT', config);
  env.OUTBOUND_FETCH = async () => Response.json({ items: [plan(1)], total_pages: 1 });
  await json('/api/integrations/mealie/sync', 'POST', range); const before = await json(`/api/meals?${new URLSearchParams(range)}`);
  assert.deepEqual(await json('/api/integrations/mealie/sync', 'POST', range), { imported: 0, removed: 0 }); assert.deepEqual(await json(`/api/meals?${new URLSearchParams(range)}`), before);
  env.OUTBOUND_FETCH = async url => new URL(String(url)).searchParams.get('page') === '1' ? Response.json({ items: [plan(2)], total_pages: 2 }) : new Response('no', { status: 503 });
  assert.equal((await req('/api/integrations/mealie/sync', 'POST', range)).status, 502); assert.deepEqual(await json(`/api/meals?${new URLSearchParams(range)}`), before);
  env.OUTBOUND_FETCH = async () => Response.json({ items: [plan(2), plan(2)], total_pages: 1 });
  assert.equal((await req('/api/integrations/mealie/sync', 'POST', range)).status, 502); assert.deepEqual(await json(`/api/meals?${new URLSearchParams(range)}`), before);
});

test('Mealie keeps completed and annotated meals when removed upstream, and refuses connected apps', async () => {
  const { env, db, json, req } = fixture(); await json('/api/integrations/mealie', 'PUT', config);
  const appKey = await createApiKey(db, 'app', 'admin', { kind: 'oauth' });
  assert.equal((await req('/api/integrations/mealie', 'GET', undefined, appKey.key)).status, 403);
  env.OUTBOUND_FETCH = async () => Response.json({ items: [plan(1), plan(2)], total_pages: 1 });
  await json('/api/integrations/mealie/sync', 'POST', range); const meals = await json(`/api/meals?${new URLSearchParams(range)}`);
  await json(`/api/meals/${meals[0].id}`, 'PATCH', { status: 'prepared' }); await json(`/api/meals/${meals[1].id}`, 'PATCH', { notes: 'Keep this' });
  env.OUTBOUND_FETCH = async () => Response.json({ items: [], total_pages: 0 });
  await json('/api/integrations/mealie/sync', 'POST', range); assert.equal((await json(`/api/meals?${new URLSearchParams(range)}`)).length, 2);
  assert.deepEqual((await db.prepare('SELECT * FROM mealie_meals').all()).results, []);
});
