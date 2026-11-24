import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { MockApi, localRankedSeason } from '../../src/sandbox/mockApi.ts';
import { Store } from '../../src/sandbox/store.ts';

// What the headless environment added to the local stand-in for the game service: a local ranked season, the
// `competitive` run option, POST /dev/unlock and the "no progression" switch. No game is loaded in this file.

const dir = mkdtempSync(join(tmpdir(), 'pb-sandbox-ranked-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const store = new Store(dir);
const api = new MockApi(store);
const call = (method: string, path: string, token?: string, body?: unknown) =>
  api.handle(method, path, token ? { authorization: `Bearer ${token}` } : {}, body) as Promise<{ status: number; json?: any }>;
const guest = async () => (await call('POST', '/auth/guest')).json as { id: string; token: string };
const RUN = { species: 155, biome: 'forest', tier: 0, mode: 'standard', boosts: [] };

test('a competitive run is only "ranked" for a registered account in a live ranked season that has the map', async () => {
  const g = await guest();
  // No season (the default): never ranked, and the option is echoed.
  let t = (await call('POST', '/runs', g.token, { ...RUN, competitive: true, key: 'k1' })).json;
  assert.deepEqual([t.ranked, t.competitive], [false, true]);
  assert.equal(store.run(t.id)!.request.competitive, true);

  api.season = localRankedSeason(4, 'Season 4', ['forest', 'coast'], 1_000_000_000_000);
  const status = (await call('GET', '/status')).json;
  assert.deepEqual([status.season.live, status.season.ranked, status.season.maps, status.season.n], [true, true, ['forest', 'coast'], 4]);
  assert.ok(status.season.start < 1_000_000_000_000 && status.season.end > 1_000_000_000_000);

  // A guest in that season: still not ranked.
  t = (await call('POST', '/runs', g.token, { ...RUN, competitive: true, key: 'k2' })).json;
  assert.equal(t.ranked, false);

  // Registered account.
  const acc = store.accountByToken(g.token)!;
  acc.guest = false;
  store.putAccount(acc);
  t = (await call('POST', '/runs', g.token, { ...RUN, competitive: true, key: 'k3' })).json;
  assert.deepEqual([t.ranked, t.competitive], [true, true]);
  const fin = (await call('POST', `/runs/${t.id}/finish`, g.token, { result: { time: 10, kills: 3, level: 2 } })).json;
  assert.deepEqual([fin.ranked, fin.record.ranked], [true, true]);

  // Same account: a map outside the rotation, and a run without the option.
  assert.equal((await call('POST', '/runs', g.token, { ...RUN, biome: 'cave', competitive: true, key: 'k4' })).json.ranked, false);
  const classic = (await call('POST', '/runs', g.token, { ...RUN, key: 'k5' })).json;
  assert.deepEqual([classic.ranked, 'competitive' in classic], [false, false]);
});

test('POST /dev/unlock answers 404 until a preset is configured, then replaces the stored profile', async () => {
  const g = await guest();
  assert.equal((await call('POST', '/dev/unlock', g.token)).status, 404);
  assert.equal((await call('POST', '/dev/unlock')).status, 401);
  api.unlockPreset = (p, a) => ({ ...p, league: [1, 4, 7], lab: { hp: 8 }, owner: a.id });
  const r = await call('POST', '/dev/unlock', g.token);
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.profile.league, r.json.profile.lab, r.json.profile.owner], [[1, 4, 7], { hp: 8 }, g.id]);
  assert.deepEqual((await call('GET', '/profile', g.token)).json.profile.league, [1, 4, 7]);
  assert.ok(api.list().some((x) => x.method === 'POST' && x.path === '/dev/unlock'));
});

test('with progression off a finished run leaves the profile as it was; finished run files can be dropped', async () => {
  const g = await guest();
  const before = JSON.stringify((await call('GET', '/profile', g.token)).json.profile);
  api.progression = false;
  try {
    const t = (await call('POST', '/runs', g.token, { ...RUN, key: 'p1' })).json;
    const fin = (await call('POST', `/runs/${t.id}/finish`, g.token, { result: { time: 300, kills: 900, level: 20, victory: true } })).json;
    assert.equal(fin.stardust, 0);
    assert.equal(JSON.stringify(fin.profile), before);
    assert.equal(JSON.stringify((await call('GET', '/profile', g.token)).json.profile), before);
    assert.equal(store.run(t.id)!.result!.kills, 900, 'the record itself is kept');
    store.dropRun(t.id);
    assert.equal(store.run(t.id), null);
  } finally { api.progression = true; }
  // …and with it on (the default), the same run moves the profile forward.
  const t = (await call('POST', '/runs', g.token, { ...RUN, key: 'p2' })).json;
  const fin = (await call('POST', `/runs/${t.id}/finish`, g.token, { result: { time: 300, kills: 900, level: 20 } })).json;
  assert.ok(fin.stardust > 0);
  assert.equal(fin.profile.counters.runs, 1);
});
