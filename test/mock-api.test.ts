import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { MockApi } from '../src/sandbox/mockApi.ts';
import { Store } from '../src/sandbox/store.ts';

const dir = mkdtempSync(join(tmpdir(), 'pb-sandbox-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const store = new Store(dir);
const api = new MockApi(store);
const call = (method: string, path: string, token?: string, body?: unknown) =>
  api.handle(method, path, token ? { authorization: `Bearer ${token}` } : {}, body) as Promise<{ status: number; json?: any }>;

test('status: no maintenance, nothing ranked', async () => {
  const r = await call('GET', '/status');
  assert.equal(r.status, 200);
  assert.equal(r.json.maintenance.on, false);
  assert.equal(r.json.season.ranked, false);
});

test('mock login: a guest session without captcha, valid for /auth/me, 401 without it', async () => {
  const g = await call('POST', '/auth/guest', undefined, { captcha: undefined });
  assert.equal(g.status, 200);
  assert.ok(g.json.token && g.json.guest === true);
  assert.equal((await call('GET', '/auth/me', g.json.token)).json.id, g.json.id);
  assert.equal((await call('GET', '/auth/me', 'nope')).status, 401);
  assert.equal((await call('GET', '/profile')).status, 401);
});

test('a whole run: starter → ticket → checkpoint → finish → journal and profile', async () => {
  const { token, id: acc } = (await call('POST', '/auth/guest')).json;
  const p0 = (await call('GET', '/profile', token)).json.profile;
  assert.equal(p0.starter, 0);
  const chosen = (await call('POST', '/profile/starter', token, { id: 4 })).json.profile;
  assert.equal(chosen.starter, 4);
  assert.ok(chosen.league.includes(4));
  assert.equal((await call('POST', '/profile/starter', token, { id: 155 })).json.profile.starterJ, 155);

  const ticket = (await call('POST', '/runs', token, { species: 4, biome: 'forest', tier: 0, mode: 'standard', boosts: [], key: 'k1' })).json;
  assert.ok(ticket.id && Number.isInteger(ticket.seed));
  assert.equal(ticket.ranked, false);
  // The same request key gives the same ticket (the client retries on a slow connection).
  assert.equal((await call('POST', '/runs', token, { species: 4, mode: 'standard', key: 'k1' })).json.id, ticket.id);

  assert.equal((await call('POST', `/runs/${ticket.id}/checkpoint`, token, { cps: [{ t: 60, kills: 40, level: 5 }] })).status, 200);
  const draws = (await call('POST', `/runs/${ticket.id}/slots`, token, { k: 'x', n: 3 })).json.u;
  assert.equal(draws.length, 3);
  assert.ok(draws.every((u: number) => u >= 0 && u < 1));

  const result = { species: 4, finalSpecies: 5, biome: 'forest', tier: 0, mode: 'standard', stage: 2, time: 412.5, kills: 880, level: 21, victory: false, bosses: 1, end: { how: 'died', hp: 0 }, progress: { league: [16], shinies: [], classics: [], seen: [16, 19], counters: { dodges: 12 }, research: {}, forms: [] } };
  const fin = await call('POST', `/runs/${ticket.id}/finish`, token, { result, cps: [] });
  assert.equal(fin.status, 200);
  assert.equal(fin.json.record.victory, false, 'the end screen reads record.victory');
  assert.ok(fin.json.profile.league.includes(16), 'the capture joined the roster');
  assert.equal(fin.json.profile.counters.dodges, 12);
  assert.equal(fin.json.profile.runs[0].time, 412.5);
  assert.equal((await call('POST', `/runs/${ticket.id}/finish`, token, { result })).status, 409, 'a run is finished once');

  const entry = store.journal().find((e) => e.id === ticket.id)!;
  assert.deepEqual([entry.acc, entry.how, entry.level, entry.kills, entry.captures, entry.stage], [acc, 'died', 21, 880, 1, 2]);
  assert.equal(store.run(ticket.id)!.checkpoints.length, 1);
});

test('mutation mode: the ticket carries the mutation of the day', async () => {
  const { token } = (await call('POST', '/auth/guest')).json;
  const t = (await call('POST', '/runs', token, { species: 4, mode: 'mutation' })).json;
  assert.ok(t.mutation && typeof t.mutation.key === 'string');
  assert.equal((await call('GET', '/mutation', token)).json.key, t.mutation.key);
});

test('cloud save and resume: suspend → saved → download → resume; discard removes it', async () => {
  const { token } = (await call('POST', '/auth/guest')).json;
  const t = (await call('POST', '/runs', token, { species: 4, mode: 'standard' })).json;
  assert.equal((await call('GET', '/runs/saved', token)).json.saved, null);
  assert.equal((await call('PUT', `/runs/${t.id}/save`, token, { hash: 'h1', enc: 'raw', data: 'e30=' })).status, 200);
  assert.equal((await call('POST', `/runs/${t.id}/suspend`, token, { hash: 'h1', cps: [] })).status, 200);
  const saved = (await call('GET', '/runs/saved', token)).json.saved;
  assert.deepEqual([saved.id, saved.hash, saved.blob], [t.id, 'h1', true]);
  assert.deepEqual((await call('GET', `/runs/${t.id}/save`, token)).json, { hash: 'h1', enc: 'raw', data: 'e30=' });
  assert.equal((await call('POST', `/runs/${t.id}/resume`, token, { hash: 'h1' })).status, 200);
  assert.equal((await call('GET', '/runs/saved', token)).json.saved, null, 'live again');
  await call('POST', `/runs/${t.id}/suspend`, token, { hash: 'h1' });
  assert.equal((await call('POST', `/runs/${t.id}/discard`, token, {})).status, 200);
  assert.equal((await call('GET', '/runs/saved', token)).json.saved, null);
  assert.equal((await call('POST', `/runs/${t.id}/resume`, token, {})).status, 410);
});

test('runs belong to their account; unknown endpoints are a logged 404, not a crash', async () => {
  const a = (await call('POST', '/auth/guest')).json, b = (await call('POST', '/auth/guest')).json;
  const t = (await call('POST', '/runs', a.token, { species: 4, mode: 'standard' })).json;
  assert.equal((await call('POST', `/runs/${t.id}/finish`, b.token, { result: {} })).status, 404);
  assert.equal((await call('GET', '/no/such/thing', a.token)).status, 404);
});

test('state survives a restart of the host', async () => {
  const { token } = (await call('POST', '/auth/guest')).json;
  await call('POST', '/profile/starter', token, { id: 7 });
  const again = new MockApi(new Store(dir));
  const p = (await again.handle('GET', '/profile', { authorization: `Bearer ${token}` }, undefined)) as any;
  assert.equal(p.json.profile.starter, 7);
});

test('the endpoint list used by the docs is complete enough for a session', () => {
  const have = api.list().map((r) => `${r.method} ${r.path}`);
  for (const need of ['GET /status', 'POST /auth/guest', 'GET /auth/me', 'POST /runs', 'POST /runs/:id/checkpoint', 'PUT /runs/:id/save', 'POST /runs/:id/finish', 'GET /profile', 'GET /profile/stash', 'GET /runs/saved'])
    assert.ok(have.includes(need), need);
});
