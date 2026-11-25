/**
 * Environment server for a trainer in another process (Python): one headless game environment, driven over this
 * process's stdin / stdout pipes. No socket is opened; nothing here touches the network.
 *
 *   node src/ipc/server.ts          (started by python/pokebonk_rl/bridge.py, not by hand)
 *
 * Frames, the same in both directions:
 *
 *   uint32 LE  length of the JSON header in bytes
 *   uint32 LE  length of the binary payload in bytes (0 when there is none)
 *   header     UTF-8 JSON
 *   payload    for an observation: float32[floatSize] | int32[intSize] | uint8[maskSize], little endian, sizes in the
 *              header's `n` (they are those of the layout descriptors in data/encoding/<build>/)
 *
 * Requests (header only):
 *   {cmd: 'init', env: {hz, actionRepeat, maxGameTime, maxIdleGameTime?, maxKoGapGameTime?, koGapGraceGameTime?, species, map, tier, ranked}, recordDecisions, view?}  → hello
 *       (view: every obs reply also carries `v`, a top-down picture of the moment for somebody watching)
 *   {cmd: 'reset', seed, species?, map?, tier?}                                                     → obs
 *   {cmd: 'step', a: [move, jump, dash, ultimate, interact, form, incense, fuse, choice]}                                → obs
 *   {cmd: 'close'}                                                                                  → (exit 0)
 *
 * Manager mode (`init` with `manager: {plan?, sliceSeconds?, endOnProposalChange?, fuseNeeds?}`; src/hybrid): the
 * environment is the manager's. A step is `{cmd: 'step', m: <action id>}`: a dialog answer, or a skill that the
 * heuristic's brain carries out for about a second of game time. The payload is the manager's observation
 * (data/encoding/<build>/manager-observation-layout.json) and its mask over the manager's action table; the reply also
 * carries `p` (the heuristic's proposal: an action id), `dt` (game seconds the step took), `k` (low-level decisions it
 * made) and `end` (why the step ended). The low-level `step` with `a` is refused in this mode, and `m` outside it.
 *
 * Replies:
 *   {t: 'hello', pid, protocol}     (the game is loaded by the first reset, not here)
 *   {t: 'obs', phase, step, term, trunc, n: [floatSize, intSize, maskSize], c: <counters>, ot: <overtime or null>,
 *    sw: 1 while the zone's final swarm is on (the zone clock ran out), else 0, rf: 1 while inside a rift, else 0,
 *    hp, maxHp, rss,
 *     metadata?: <BatchMetadata, with the first reset of the process>,
 *     episode?: <EpisodeRecord, with the step that ended the episode>}  + payload
 *   {t: 'error', name, message, stack, details}  then the process exits with code 1: after an error the environment's
 *     state is not trusted, the trainer starts a fresh process.
 *
 * The reward is not computed here. The reply carries the run's cumulative counters (the game's own figures); the
 * trainer turns their differences into a reward (python/pokebonk_rl/reward.py), so a reward version can change without
 * touching the environment.
 *
 * stdout carries frames only: `process.stdout.write` is pointed at stderr before anything else is loaded.
 */
import { writeSync } from 'node:fs';
import { decodeAction } from '../actions/codec.ts';
import { choiceOfId } from '../hybrid/actions.ts';
import { createEnvironment } from '../environment/index.ts';
import type { HeadlessGameEnvironment } from '../environment/GameEnvironment.ts';
import type { ChoiceMask, Observation, StepResult } from '../environment/types.ts';
import { managerActionLayout } from '../hybrid/actions.ts';
import { ManagerEnvironment } from '../hybrid/manager.ts';
import type { ManagerObservation, ManagerOptions, ManagerStep } from '../hybrid/manager.ts';
import { ManagerEncoder } from '../hybrid/observe.ts';
import { batchMetadata, chosenId, defeated, finalBuild } from '../runner/episode.ts';
import { real } from '../sim/clock.ts';
import type { DecisionRecord, EpisodeRecord } from '../storage/records.ts';

export const IPC_PROTOCOL = 1;

// ---------------------------------------------------------------- framing

const out = (header: Record<string, unknown>, payload?: Uint8Array): void => {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const head = Buffer.alloc(8);
  head.writeUInt32LE(json.length, 0);
  head.writeUInt32LE(payload?.length ?? 0, 4);
  const frame = payload ? Buffer.concat([head, json, payload]) : Buffer.concat([head, json]);
  for (let off = 0; off < frame.length;) {
    try { off += writeSync(1, frame, off, frame.length - off); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EAGAIN') throw e; }
  }
};
// Anything else that prints goes to stderr: a stray line on stdout would break the framing.
process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => (process.stderr.write as (...a: unknown[]) => boolean)(chunk, ...rest)) as typeof process.stdout.write;

// ---------------------------------------------------------------- state

interface InitRequest { cmd: 'init'; env: { hz: number; actionRepeat: number; maxGameTime: number; maxIdleGameTime?: number; maxKoGapGameTime?: number; koGapGraceGameTime?: number; archive?: string; species: number; map: string; tier: number; ranked: boolean }; recordDecisions?: boolean; view?: boolean; manager?: ManagerOptions }
type Request = InitRequest | { cmd: 'reset'; seed: number; species?: number; map?: string; tier?: number } | { cmd: 'step'; a?: number[]; m?: number } | { cmd: 'close' };

let env: HeadlessGameEnvironment | null = null;
let manager: ManagerEnvironment | null = null;
let mobs: ManagerObservation | null = null;
let recordDecisions = false;
let withView = false;
let obs: Observation | null = null;
let episodes = 0;
let sentMetadata = false;
let ep: { seed: number; ranked: boolean; startedAt: string; t0: number; resetSeconds: number; firstSpecies: number; decisions: DecisionRecord[]; decisionCount: number; overtimeStarted: boolean } | null = null;

function payloadOf(o: Observation): Uint8Array {
  const e = manager ? (mobs?.obs === o && mobs.encoded ? { ...mobs.encoded, mask: mobs.mask } : null) : o.encoded;
  if (!e) throw new Error('ipc: the environment returned an observation without its encoding');
  return Buffer.concat([Buffer.from(e.float.buffer, e.float.byteOffset, e.float.byteLength), Buffer.from(e.int.buffer, e.int.byteOffset, e.int.byteLength), Buffer.from(e.mask.buffer, e.mask.byteOffset, e.mask.byteLength)]);
}

function reply(o: Observation, res: StepResult | null, extra: Record<string, unknown>): void {
  const p = o.snapshot.player, payload = payloadOf(o);
  const n = manager ? [mobs!.encoded!.float.length, mobs!.encoded!.int.length, mobs!.mask.length] : [o.encoded!.float.length, o.encoded!.int.length, o.encoded!.mask.length];
  out({
    t: 'obs', phase: o.phase, step: o.step, n, term: res?.terminated ?? false, trunc: res?.truncated ?? false,
    c: res ? res.info.counters : o.state.counters, ot: res?.info.overtime ?? null, sw: o.state.zone.finalSwarm ? 1 : 0, rf: o.snapshot.rift?.inside ? 1 : 0, hp: p.hp, maxHp: p.maxHp,
    rss: Math.round(process.memoryUsage().rss / 1048576), ...(withView ? { v: viewOf(o) } : {}), ...extra,
  }, payload);
}

/**
 * What somebody watching needs to draw the moment from above (`init` with `view: true`; python/pokebonk_rl/watch.py):
 * positions on the ground, hit points, the open dialog. Read from the frozen observation; the game is not touched.
 */
function viewOf(o: Observation): Record<string, unknown> {
  const s = o.snapshot, p = s.player, r1 = (n: number): number => Math.round(n * 10) / 10;
  return {
    time: r1(s.t), zone: s.stage, kills: s.kills, level: p.level, hp: Math.round(p.hp), maxHp: Math.round(p.maxHp), x: r1(p.x), z: r1(p.z), phase: o.phase, enemies: s.enemies.count,
    near: s.enemies.list.map((e) => [r1(e[1]), r1(e[2]), r1(e[7]), e[10]]),
    boss: s.boss && s.boss.hp > 0 ? { x: r1(s.boss.x), z: r1(s.boss.z), hp: Math.round(s.boss.hp), maxHp: Math.round(s.boss.maxHp), name: s.boss.name } : null,
    points: s.points.map((q) => [q.sub ? `${q.kind}:${q.sub}` : q.kind, r1(q.x), r1(q.z), q.used ? 1 : 0]),
    hazards: s.hazards.map((h) => [r1(h.x), r1(h.z), r1(h.r)]),
    shots: s.shots.map((h) => [r1(h[0]), r1(h[1])]),
    decision: o.decision ? { kind: o.decision.kind, options: o.decision.options.map((d) => String(d.label || d.id)) } : null,
    bounds: s.terrain?.bounds ?? null,
  };
}

function episodeRecord(o: Observation, res: StepResult): EpisodeRecord {
  const e = ep!, info = res.info, s = o.snapshot;
  const record = info.end ? (JSON.parse(JSON.stringify(info.end.record)) as Record<string, unknown>) : null;
  const ot = info.overtime, recOt = record?.ot as { rounds?: unknown[]; cashed?: boolean } | undefined;
  const beaten = defeated(info.counters);
  return {
    seed: e.seed, species: e.firstSpecies, finalSpecies: s.player.species, map: s.biome, tier: s.tier, ranked: e.ranked,
    terminated: res.terminated, truncated: res.truncated, endCause: info.endCause ?? 'unknown', endHow: info.end?.how ?? null, victory: info.end?.victory ?? false,
    gameTime: info.time, kills: info.kills,
    overtime: {
      started: e.overtimeStarted || !!recOt, bonus: ot?.bonus ?? 0,
      rounds: Array.isArray(recOt?.rounds) ? recOt.rounds.length : e.overtimeStarted ? ot?.round ?? 0 : 0, cashed: !!(ot?.cashed || recOt?.cashed),
    },
    level: info.level, zone: info.zone, guardiansDefeated: beaten.guardians, legendariesDefeated: beaten.legendaries, sealsKept: info.sealsKept,
    steps: o.step, simSteps: o.simStep, wallSeconds: (real.performanceNow() - e.t0) / 1000, resetSeconds: e.resetSeconds,
    finalBuild: finalBuild(o), counters: { ...info.counters }, record, blockedNetwork: [...info.blockedNetwork], decisions: e.decisions,
    worker: { id: 0, pid: process.pid, episode: episodes, rssMB: Math.round(process.memoryUsage().rss / 1048576) },
    startedAt: e.startedAt, finishedAt: new real.Date().toISOString(),
  };
}

/** What a trainer must match: the manager's two layouts, its options and the plan it advises with. */
function managerMetadata(): Record<string, unknown> {
  const m = manager!, L = m.encoder!.layout, A = managerActionLayout();
  return {
    observation: { version: L.version, hash: L.hash, compat: L.compat, floatSize: L.floatSize, intSize: L.intSize }, action: { version: A.version, hash: A.hash, size: A.size },
    options: m.options, plan: m.advisor.plan.version, capacities: L.capacities,
  };
}

async function handle(req: Request): Promise<void> {
  if (req.cmd === 'init') {
    if (env) throw new Error('ipc: init was sent twice');
    recordDecisions = !!req.recordDecisions;
    withView = !!req.view;
    env = createEnvironment({ ...req.env, encode: !req.manager });
    if (req.manager) manager = new ManagerEnvironment(env, req.manager);
    out({ t: 'hello', protocol: IPC_PROTOCOL, pid: process.pid });
    return;
  }
  if (req.cmd === 'close') {
    try { await env?.close(); } catch { /* leaving anyway */ }
    process.exit(0);
  }
  if (!env) throw new Error(`ipc: "${req.cmd}" was sent before init`);
  if (req.cmd === 'reset') {
    const startedAt = new real.Date().toISOString(), t0 = real.performanceNow();
    const { cmd: _cmd, ...setup } = req;
    if (manager) { mobs = await manager.reset(setup); obs = mobs.obs; } else obs = await env.reset(setup);
    episodes++;
    const md = env.getMetadata();
    // The manager's encoder needs the running build, which is known once the game is loaded.
    if (manager && !manager.encoder) { manager.encoder = new ManagerEncoder(md.game.build); mobs = { ...mobs!, encoded: manager.encoder.encode(mobs!, manager) }; }
    ep = { seed: req.seed, ranked: md.mode.ranked, startedAt, t0: real.performanceNow(), resetSeconds: (real.performanceNow() - t0) / 1000, firstSpecies: obs.snapshot.player.species, decisions: [], decisionCount: 0, overtimeStarted: false };
    reply(obs, null, { ...(manager ? { p: mobs!.proposal, dt: 0, k: 0 } : {}), ...(sentMetadata ? {} : { metadata: batchMetadata(md), ...(manager ? { manager: managerMetadata() } : {}) }) });
    sentMetadata = true;
    return;
  }
  if (req.cmd === 'step') {
    if (!obs || !ep) throw new Error('ipc: step was sent before reset');
    if (manager ? req.m === undefined : !req.a) throw new Error(manager ? 'ipc: manager mode takes {cmd: "step", m: <action id>}' : 'ipc: a step needs the action vector `a` (the manager\'s `m` needs init with `manager`)');
    const action = manager ? (obs.phase === 'choice' ? choiceOfId(req.m!) : null) : decodeAction(req.a!, obs);
    if (obs.phase === 'choice' && action?.type === 'choice') {
      ep.decisionCount++;
      if (recordDecisions) {
        const d = obs.decision!, s = obs.snapshot;
        ep.decisions.push({
          serial: d.serial, step: obs.step, gameTime: s.t, zone: s.stage, level: s.player.level, kind: d.kind, method: d.method,
          options: d.options as DecisionRecord['options'], context: d.context, mask: obs.mask as ChoiceMask, chosen: action, chosenId: chosenId(d, action),
        });
      }
    }
    let res: StepResult, ms: ManagerStep | null = null;
    if (manager) { ms = await manager.step(req.m!); mobs = ms.observation; res = { observation: mobs.obs, terminated: ms.terminated, truncated: ms.truncated, info: ms.info } as StepResult; } else res = await env.step(action!);
    obs = res.observation;
    if (res.info.overtime?.live) ep.overtimeStarted = true;
    const over = res.terminated || res.truncated;
    reply(obs, res, { ...(ms ? { p: mobs!.proposal, dt: ms.dt, k: ms.ticks, end: ms.ended } : {}), ...(over ? { episode: { ...episodeRecord(obs, res), decisionCount: ep.decisionCount } } : {}) });
    if (over) { obs = null; ep = null; mobs = null; }
    return;
  }
  throw new Error(`ipc: unknown command ${JSON.stringify((req as { cmd?: unknown }).cmd)}`);
}

// ---------------------------------------------------------------- request loop

function fail(e: unknown): never {
  const err = e instanceof Error ? e : new Error(String(e));
  const details = (err as { details?: unknown }).details;
  let plain: unknown = null;
  try { plain = details && typeof details === 'object' ? JSON.parse(JSON.stringify(details)) : null; } catch { /* not serialisable */ }
  out({ t: 'error', name: err.name, message: err.message.split('\n')[0], stack: String(err.stack ?? err.message), details: plain, seed: ep?.seed ?? null, step: obs?.step ?? null });
  process.exit(1);
}

let buffered: Buffer = Buffer.alloc(0);
const queue: Request[] = [];
let busy = false;

async function drain(): Promise<void> {
  if (busy) return;
  busy = true;
  try { for (let r = queue.shift(); r; r = queue.shift()) await handle(r); } catch (e) { fail(e); }
  busy = false;
}

process.stdin.on('data', (chunk: Buffer) => {
  buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
  for (;;) {
    if (buffered.length < 8) break;
    const jsonLen = buffered.readUInt32LE(0), binLen = buffered.readUInt32LE(4);
    if (buffered.length < 8 + jsonLen + binLen) break;
    try { queue.push(JSON.parse(buffered.subarray(8, 8 + jsonLen).toString('utf8')) as Request); } catch (e) { fail(e); }
    buffered = buffered.subarray(8 + jsonLen + binLen);
  }
  void drain();
});
// The trainer went away: there is nobody to play for.
process.stdin.on('end', () => process.exit(0));
process.on('uncaughtException', fail);
// A rejected promise nobody handles is NOT an error here, as in the Stage 1 runner: src/sim/browser.ts records it as a
// page problem, the way a browser prints a console message. The first training run met the case that matters: once a
// Pokémon has learned everything, each level-up calls the HUD's `trained`, which cancels a running Web Animation; the
// DOM library then rejects that animation's `finished` promise, which nobody awaits. (A browser marks that promise as
// handled and prints nothing.) Ending the episode for it lost two long episodes of that run.
