import { randomBytes, randomInt } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { logger } from '../logger.ts';
import type { Account, JournalEntry, RunRecord, Store } from './store.ts';
import { applyRunToProfile, freshProfile } from './progress.ts';

const log = logger('mock-api');

/** Everything a handler gets. `m` holds the path parameters. */
interface Ctx {
  method: string;
  path: string;
  query: URLSearchParams;
  body: any;
  acc: Account | null;
  m: Record<string, string>;
}
type Reply = { status?: number; json?: unknown } | void;
type Handler = (c: Ctx) => Reply | Promise<Reply>;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const need = (c: Ctx): Account => { if (!c.acc) throw new HttpError(401, 'No session'); return c.acc; };
const id = (n = 12) => randomBytes(n).toString('hex');
const DAY = 86_400_000;
const JOHTO_STARTERS = [152, 155, 158];
/** The sandbox has no seasons: boards and the menu show "between seasons" and nothing is ranked. */
const NO_SEASON: Season = { n: 0, name: 'Sandbox', start: 0, end: 0, live: false, dust: 1, message: '', ranked: false, maps: [], next: null };

/** What GET /status reports as the season. The client's menu only offers Ranked when `live`, `ranked` and `maps` say so. */
export interface Season { n: number; name: string; start: number; end: number; live: boolean; dust: number; message: string; ranked: boolean; maps: string[]; next: null | Record<string, unknown> }

/**
 * A local stand-in for "a Ranked season is running on these maps". Nothing is ranked anywhere: the flag only makes the
 * client show and label a run the way it does for Ranked. `end` is far in the future so no menu timer fires.
 */
export function localRankedSeason(n: number, name: string, maps: string[], now = Date.now()): Season {
  return { n, name, start: now - DAY, end: now + 3650 * DAY, live: true, dust: 1, message: '', ranked: true, maps: [...maps], next: null };
}

/** Daily arena-wide modifiers the sandbox rotates through for the mutation mode. Keys match the game's own table when it knows them. */
const MUTATIONS = ['swift', 'giants', 'frenzy', 'glass', 'horde', 'fog'];
export const mutationOfDay = (now = Date.now()) => {
  const day = Math.floor(now / DAY);
  return { day, key: MUTATIONS[day % MUTATIONS.length] };
};

/**
 * The sandbox's stand-in for the game service. Same paths and JSON shapes the client expects, backed by local
 * files only. Routes are documented in docs/ENDPOINTS.md; keep the two in sync.
 */
export class MockApi {
  private store: Store;
  private routes: { method: string; pattern: string; re: RegExp; keys: string[]; h: Handler; doc: string }[] = [];
  /** Listeners for the dashboard / session manager (run started, finished...). */
  onEvent: (ev: { type: string; run?: RunRecord; entry?: JournalEntry }) => void = () => {};
  /** Species id → evolution family id, when the mirrored data files are available. */
  family: (species: number) => number = (s) => s;
  /** The season GET /status reports. Default: none ("between seasons", nothing ranked). */
  season: Season = NO_SEASON;
  /**
   * Backs POST /dev/unlock (the client's own `devUnlock` call): given the stored profile, returns the unlocked one.
   * The mock has no copy of the game's registries, so whoever runs the game supplies this (src/environment/profile.ts
   * builds it from the registries of the running bundle). Unset: the route answers 404 like any unknown route.
   */
  unlockPreset: ((profile: Record<string, any>, account: Account) => Record<string, any>) | null = null;
  /** Fold finished runs into the profile (stardust, counters, history). Off: the profile only changes through /dev/unlock and prefs. */
  progression = true;
  /**
   * Source of account ids, session tokens and run ticket ids (hex, `bytes` bytes long). Default: the operating
   * system's randomness. The headless simulation replaces it with a fixed sequence: the game hashes the ACCOUNT ID
   * into its legendary-encounter rolls, so a random id made the same episode differ from process to process.
   */
  newId: (bytes?: number) => string = id;

  constructor(store: Store) {
    this.store = store;
    this.define();
  }

  private on(method: string, pattern: string, doc: string, h: Handler) {
    const keys: string[] = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_s, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    this.routes.push({ method, pattern, re, keys, h, doc });
  }

  /** Every route with its one-line description: the source of docs/ENDPOINTS.md and of the dashboard's list. */
  list() { return this.routes.map((r) => ({ method: r.method, path: r.pattern, doc: r.doc })); }

  private session(a: Account) { return { id: a.id, name: a.name, guest: a.guest, token: a.token }; }

  private profileOf(a: Account): Record<string, any> {
    let p = this.store.profile(a.id);
    if (!p) { p = freshProfile(a.name); this.store.putProfile(a.id, p); }
    return p;
  }

  private ownRun(c: Ctx): RunRecord {
    const a = need(c), r = this.store.run(c.m.id);
    if (!r || r.acc !== a.id) throw new HttpError(404, 'Unknown run');
    return r;
  }

  private define() {
    // ---------- service status ----------
    this.on('GET', '/status', 'Service flags: no maintenance, open registration, no live events.', () => ({
      json: { maintenance: { on: false }, registration: { inviteOnly: false }, events: [], season: this.season, now: Date.now(), sandbox: true },
    }));

    // ---------- auth: local sessions, no captcha ----------
    this.on('POST', '/auth/guest', 'Issue a local guest session (the captcha field is ignored).', () => {
      const n = this.store.accounts().length + 1;
      const a: Account = { id: this.newId(8), name: `Sandbox${String(n).padStart(3, '0')}`, token: this.newId(24), guest: true, created: Date.now() };
      this.store.putAccount(a);
      this.profileOf(a);
      log.info(`guest session ${a.name}`);
      return { json: this.session(a) };
    });
    this.on('GET', '/auth/me', 'Validate the bearer token of a local session.', (c) => ({ json: this.session(need(c)) }));
    this.on('POST', '/auth/logout', 'No-op.', () => ({ status: 204 }));
    this.on('GET', '/auth/name', 'Name availability (always free).', () => ({ json: { ok: true, free: true } }));

    // ---------- profile ----------
    this.on('GET', '/profile', 'The local profile plus server time.', (c) => ({ json: { profile: this.profileOf(need(c)), now: Date.now() } }));
    this.on('PUT', '/profile/prefs', 'Store settings and last picks.', (c) => {
      const a = need(c), p = this.profileOf(a);
      for (const k of ['settings', 'lastSpecies', 'lastBiome', 'avatar', 'frame', 'title', 'banner', 'skins', 'team'])
        if (c.body?.[k] !== undefined) p[k] = c.body[k];
      this.store.putProfile(a.id, p);
      return { status: 204 };
    });
    this.on('POST', '/profile/starter', 'Choose the starter of a new profile.', (c) => {
      const a = need(c), p = this.profileOf(a), s = Number(c.body?.id);
      if (!Number.isInteger(s) || s < 1) throw new HttpError(400, 'Bad starter');
      // The second-region partners are a separate pick; everything else is the first starter.
      if (JOHTO_STARTERS.includes(s)) p.starterJ = s;
      else { p.starter = s; p.lastSpecies = s; }
      for (const k of ['unlocked', 'league']) { if (!Array.isArray(p[k])) p[k] = []; if (!p[k].includes(s)) p[k].push(s); }
      this.store.putProfile(a.id, p);
      return { json: { profile: p } };
    });
    this.on('POST', '/dev/unlock', 'The client\'s devUnlock call: replace the profile with the configured unlocked preset.', (c) => {
      const a = need(c);
      if (!this.unlockPreset) throw new HttpError(404, 'Not available in the sandbox');
      const p = this.unlockPreset(structuredClone(this.profileOf(a)), a);
      this.store.putProfile(a.id, p);
      return { json: { profile: p } };
    });
    this.on('POST', '/profile/actions', 'Loadout toggles (stored, not validated).', (c) => ({ json: { profile: this.profileOf(need(c)) } }));
    this.on('GET', '/profile/stash', 'Local key/value stash.', (c) => ({ json: this.profileOf(need(c)).__stash ?? {} }));
    this.on('PUT', '/profile/stash/:key', 'Write one stash entry.', (c) => {
      const a = need(c), p = this.profileOf(a);
      (p.__stash ??= {})[c.m.key] = { data: c.body?.data, updated: c.body?.updated ?? Date.now() };
      this.store.putProfile(a.id, p);
      return { json: { ok: true, updated: p.__stash[c.m.key].updated } };
    });

    // ---------- runs ----------
    this.on('POST', '/runs', 'Issue a run ticket: random seed, mode config, mutation of the day.', (c) => {
      const a = need(c), b = c.body ?? {};
      const again = typeof b.key === 'string' ? this.store.runByKey(a.id, b.key) : null;
      if (again) return { json: again.ticket };
      const mode = String(b.mode ?? 'standard');
      // "Ranked" in the client is the run option `competitive` (set by its Ranked map screen). The reply mirrors what
      // that screen requires: a registered account and a live ranked season that has the map in rotation. Local only:
      // the flag changes labels in the client, nothing is submitted anywhere.
      const competitive = b.competitive === true;
      const ranked = competitive && !a.guest && this.season.live && this.season.ranked && this.season.maps.includes(String(b.biome));
      const ticket: Record<string, unknown> = { id: this.newId(), seed: randomInt(0, 2 ** 32 - 1), ranked, boosts: [], sandbox: true };
      if (competitive) ticket.competitive = true;
      if (mode === 'mutation') ticket.mutation = mutationOfDay();
      const run: RunRecord = {
        id: ticket.id as string, acc: a.id, key: b.key, status: 'live', started: Date.now(),
        request: { species: b.species, biome: b.biome, tier: b.tier, mode, boosts: b.boosts ?? [], ...(competitive ? { competitive: true } : {}) }, ticket, checkpoints: [],
      };
      this.store.putRun(run);
      log.info(`run ${run.id.slice(0, 8)} started`, run.request);
      this.onEvent({ type: 'run-start', run });
      return { json: ticket };
    });
    this.on('POST', '/runs/:id/slots', 'Uniform random draws for the in-run slot machine.', (c) => {
      this.ownRun(c);
      const n = Math.max(0, Math.min(64, Number(c.body?.n) | 0));
      return { json: { u: Array.from({ length: n }, () => Math.random()) } };
    });
    this.on('POST', '/runs/:id/checkpoint', 'Append progress checkpoints to the run file.', (c) => {
      const r = this.ownRun(c);
      if (Array.isArray(c.body?.cps)) r.checkpoints.push(...c.body.cps);
      if (r.checkpoints.length > 2000) r.checkpoints.splice(0, r.checkpoints.length - 2000);
      if (typeof c.body?.auto === 'string') r.saveHash = c.body.auto;
      this.store.putRun(r);
      return { json: { ok: true } };
    });
    this.on('PUT', '/runs/:id/save', 'Store the suspend blob for a run (cloud save).', (c) => {
      const r = this.ownRun(c), b = c.body ?? {};
      if (typeof b.hash !== 'string' || typeof b.data !== 'string') throw new HttpError(400, 'Bad save');
      this.store.putSave(r.id, { hash: b.hash, enc: b.enc === 'gz' ? 'gz' : 'raw', data: b.data });
      r.saveHash = b.hash;
      this.store.putRun(r);
      return { json: { ok: true } };
    });
    this.on('GET', '/runs/:id/save', 'Return the stored suspend blob.', (c) => {
      const s = this.store.save(this.ownRun(c).id);
      if (!s) throw new HttpError(404, 'No save');
      return { json: s };
    });
    this.on('POST', '/runs/:id/suspend', 'Mark the run as suspended ("save and quit").', (c) => {
      const r = this.ownRun(c);
      r.status = 'suspended';
      r.suspendHash = c.body?.hash;
      if (Array.isArray(c.body?.cps)) r.checkpoints.push(...c.body.cps);
      this.store.putRun(r);
      return { json: { ok: true } };
    });
    for (const verb of ['resume', 'recover'])
      this.on('POST', `/runs/:id/${verb}`, `Mark a suspended run as live again (${verb}).`, (c) => {
        const r = this.ownRun(c);
        if (r.status === 'finished' || r.status === 'discarded') throw new HttpError(410, 'Run already closed');
        r.status = 'live';
        this.store.putRun(r);
        return { json: { ok: true } };
      });
    this.on('POST', '/runs/:id/discard', 'Drop a suspended run and its save.', (c) => {
      const r = this.ownRun(c);
      r.status = 'discarded';
      this.store.putRun(r);
      this.store.dropSave(r.id);
      return { json: { ok: true } };
    });
    this.on('GET', '/runs/saved', 'The account\'s suspended run, if any, so resume works.', (c) => {
      const a = need(c);
      const r = this.store.runs().filter((x) => x.acc === a.id && x.status === 'suspended').sort((x, y) => y.started - x.started)[0];
      if (!r) return { json: { saved: null } };
      const s = this.store.save(r.id);
      return { json: { saved: { id: r.id, at: r.started, hash: s?.hash ?? r.suspendHash, blob: !!s, ...r.request } } };
    });
    this.on('POST', '/runs/:id/finish', 'Accept the result, store it in the run journal, return the updated profile.', (c) => {
      const a = need(c), r = this.ownRun(c), result = c.body?.result ?? {};
      if (r.status === 'finished') throw new HttpError(409, 'Run already finished');
      if (Array.isArray(c.body?.cps)) r.checkpoints.push(...c.body.cps);
      r.status = 'finished';
      r.ended = Date.now();
      r.result = result;
      this.store.putRun(r);
      this.store.dropSave(r.id);
      const p = this.profileOf(a), gained = this.progression ? applyRunToProfile(p, r, this.family) : { stardust: 0, forms: [], tasks: [] };
      if (this.progression) this.store.putProfile(a.id, p);
      const ranked = r.ticket.ranked === true;
      const entry: JournalEntry = {
        id: r.id, acc: a.id, at: r.ended, mode: String(result.mode ?? r.request.mode ?? 'standard'),
        species: Number(result.species ?? r.request.species ?? 0), biome: String(result.biome ?? r.request.biome ?? ''),
        tier: Number(result.tier ?? r.request.tier ?? 0), time: Number(result.time ?? 0), level: Number(result.level ?? 0),
        kills: Number(result.kills ?? 0), stage: Number(result.stage ?? 0), victory: !!result.victory,
        how: String(result.end?.how ?? (result.victory ? 'won' : 'unknown')), bosses: Number(result.bosses ?? 0),
        captures: (result.progress?.league?.length ?? 0), shinies: (result.progress?.shinies?.length ?? 0) + (result.progress?.classics?.length ?? 0),
        score: typeof result.score === 'number' ? result.score : undefined,
      };
      this.store.appendJournal(entry);
      log.info(`run ${r.id.slice(0, 8)} finished: ${entry.how}, ${Math.round(entry.time)}s, level ${entry.level}, ${entry.kills} kills`);
      this.onEvent({ type: 'run-finish', run: r, entry });
      // `record` is what the end-of-run screen renders: the run as the service stored it.
      return { json: { profile: p, record: { ...result, id: r.id, ranked }, ...gained, ranked } };
    });

    // ---------- read-only views the menus ask for: empty in the sandbox ----------
    const empty: [string, string, unknown][] = [
      ['/news', 'No news.', []],
      ['/mail', 'Empty mailbox.', { mail: [], unread: 0 }],
      ['/friends', 'No friends list.', { friends: [], requests: [], sent: [] }],
      ['/records', 'No records.', { records: [] }],
      ['/records/endless', 'No records.', { records: [] }],
      ['/leaderboard', 'Empty board (nothing is ranked here).', { entries: [], players: 0, me: null, cutoff: null, info: NO_SEASON }],
      ['/clans/board', 'Empty board.', { entries: [], players: 0, me: null, info: NO_SEASON }],
      ['/leaderboard/pokemon', 'Empty board.', { entries: [], boards: [], info: NO_SEASON }],
      ['/seasons/awards', 'No season awards.', { awards: [] }],
      ['/clans/status', 'No clan.', { clan: null, invites: [], requests: [] }],
      ['/clans/mates', 'No clan.', { mates: [] }],
      ['/duels', 'No duels.', { duels: [] }],
      ['/builds/rents', 'No rentals.', { rents: [] }],
      ['/coop/invites', 'No co-op.', { invites: [] }],
      ['/coop/seeking', 'No co-op.', { rooms: [] }],
      ['/coop/access', 'Co-op is off in the sandbox.', { ok: false }],
    ];
    for (const [path, doc, json] of empty) this.on('GET', path, doc, () => ({ json }));
    this.on('GET', '/mutation', 'Mutation of the day and an empty daily board.', () => ({ json: { ...mutationOfDay(), mutation: mutationOfDay(), entries: [], players: 0, me: null, info: NO_SEASON } }));
    this.on('POST', '/feedback', 'Dropped.', () => ({ status: 204 }));
    this.on('POST', '/mail/read', 'No-op.', () => ({ json: { ok: true } }));
  }

  /** Answer one API call. Used by the HTTP server (under /__api) and, through it, by the sandbox browser's request router. */
  async handle(method: string, url: string, headers: Record<string, string | undefined>, body: unknown): Promise<{ status: number; json?: unknown }> {
    const u = new URL(url, 'http://sandbox');
    const auth = headers.authorization ?? headers.Authorization;
    const acc = this.store.accountByToken(auth?.replace(/^Bearer\s+/i, ''));
    if (method === 'OPTIONS') return { status: 204 };
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(u.pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      try {
        const out = (await r.h({ method, path: u.pathname, query: u.searchParams, body, acc, m: params })) ?? {};
        return { status: out.status ?? (out.json === undefined ? 204 : 200), json: out.json };
      } catch (e) {
        if (e instanceof HttpError) return { status: e.status, json: { error: e.message } };
        log.error(`${method} ${u.pathname} failed`, String((e as Error).stack ?? e));
        return { status: 500, json: { error: 'Sandbox error' } };
      }
    }
    this.store.noteUnhandled(method, u.pathname);
    log.debug(`unhandled ${method} ${u.pathname}`);
    return { status: 404, json: { error: 'Not available in the sandbox' } };
  }

  /** Node http adapter. */
  async serve(req: IncomingMessage, res: ServerResponse, path: string) {
    const chunks: Buffer[] = [];
    for await (const ch of req) chunks.push(ch as Buffer);
    let body: unknown;
    if (chunks.length) { try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = undefined; } }
    const out = await this.handle(req.method ?? 'GET', path, req.headers as Record<string, string>, body);
    const cors = {
      'Access-Control-Allow-Origin': req.headers.origin ?? '*',
      'Access-Control-Allow-Headers': 'authorization, content-type, x-device, x-client, x-admin-token',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Max-Age': '600',
      'Cache-Control': 'no-store',
    };
    if (out.json === undefined) { res.writeHead(out.status, cors); res.end(); return; }
    res.writeHead(out.status, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(out.json));
  }
}
