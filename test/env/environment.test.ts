import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createEnvironment, idlePolicy, randomPolicy, InvalidActionError, MOVES } from '../../src/environment/index.ts';
import type { ChoiceMask, Observation, PlayMask, StepResult } from '../../src/environment/index.ts';

// SLOW GROUP: this file boots the real game bundle headless (about 2 s) and plays a few short episodes (about 30 s in
// all). One environment for the whole file: the browser shims are global to the process.

const env = createEnvironment({ maxGameTime: 0 });
after(async () => { await env.close(); });

/** Digest of everything an agent could tell two episodes apart by, one record per environment step. */
async function playAndDigest(seed: number, untilGameTime: number, reset: Parameters<typeof env.reset>[0] = {}): Promise<{ digest: string; last: StepResult; kinds: Set<string> }> {
  const hash = createHash('sha256');
  const policy = randomPolicy();
  let obs = await env.reset({ seed, ...reset });
  policy.reset(seed);
  const kinds = new Set<string>();
  let last: StepResult | null = null;
  for (;;) {
    const s = obs.snapshot;
    hash.update(JSON.stringify([obs.step, obs.simStep, s.t, s.player.x, s.player.y, s.player.z, s.player.hp, s.player.level, s.kills, s.enemies.count, obs.phase, obs.mask, obs.decision]));
    if (obs.decision) kinds.add(obs.decision.kind);
    if (last?.terminated || last?.truncated || s.t >= untilGameTime) break;
    last = await env.step(policy.act(obs));
    obs = last.observation;
  }
  return { digest: hash.digest('hex'), last: last!, kinds };
}

let firstDigest = '';

test('reset: a Ranked run of the asked species, map and tier, on a fully unlocked account', async () => {
  const first = await playAndDigest(5, 20);
  firstDigest = first.digest;
  const obs = env.getObservation();
  assert.equal(obs.snapshot.mode, 'standard');
  assert.equal(obs.snapshot.player.species, 155);
  assert.equal(obs.snapshot.biome, 'forest');
  const md = env.getMetadata();
  assert.equal(md.mode.ranked, true);
  assert.equal((md.mode.season as any).ranked, true);
  assert.equal(md.profile.registered, true);
  const sum = md.profile.summary as Record<string, any>;
  for (const k of ['leagueMembers', 'labUpgradesAtMax', 'shopItemsOwned', 'mapsAtTopTier', 'altForms', 'friendshipAtMax', 'researchComplete', 'shinyPerks', 'shinyCollection']) {
    const [have, all] = String(sum[k]).split('/').map(Number);
    assert.ok(all > 0 && have === all, `${k}: ${sum[k]}`);
  }
  assert.equal(md.profile.preset, 'unlocked-v3');
  // The complete shiny collection: every species the game's wild-shiny test admits plus its five legendary shinies.
  assert.deepEqual([sum.shinyPerks, sum.shinyCollection, sum.shinyCharm, sum.shinyBond, sum.shinyFamiliesLeft], ['5/5', '245/245', true, 2, 0]);
  assert.deepEqual([sum.shinyLegendaries, sum.shinyNotCollectable], [[144, 145, 146, 150, 151], [243, 244, 245, 249, 250, 251]]);
  // The game's own run object and profile object agree.
  const sim = env.debug.sim!;
  assert.equal(sim.run.competitive, true);
  assert.equal(sim.run.seals.enabled, true);
  assert.equal(sim.app.meta.inLeague(150), true, 'a legendary is selectable');
  assert.equal(sim.app.meta.lab('choice4'), 1);
  assert.equal(sim.run.player.moveSlots, 4, 'the Lab move slot is active in the run');
  assert.equal(sim.run.rerolls + sim.run.skips + sim.run.banishes > 3, true, 'Lab refresh / skip / banish uses reach the run');
  // Friendship at the top level and complete research, as the game's own objects see them.
  const meta = sim.app.meta;
  assert.deepEqual([meta.friendship(155).lv, meta.friendship(155).max, sim.run.friendLv], [20, true, 20]);
  assert.deepEqual(sim.run.friend(), { stats: { maxHp: 10, moveSpeed: 0.03, armor: 2, xpGain: 0.05 }, reroll: 1, skip: 1, banish: 1, ult: 0.05 });
  assert.equal(meta.researchDone(meta.family(155)), true);
  assert.equal(meta.researched().length, 129);
  // All five shiny perks, as the game computes them from the collection, and their stats in the run.
  assert.deepEqual([meta.shinyCount(), meta.shinyPerks().length, meta.hasShinyCharm(), meta.shinyBond(), meta.shinyFlee()], [245, 5, true, 2, 150]);
  assert.ok(meta.shinyRate() > 1, 'the Shiny Charm raises the shiny rate');
  assert.deepEqual([meta.labStats().luck, meta.labStats().damage, meta.labStats().xpGain].map((v: number) => Math.round(v * 100) / 100), [33, 0.35, 0.34], 'Lab 30 luck + 3, 32 % damage + 3 %, 30 % experience + 4 %');
  assert.deepEqual([meta.profile.shinies.includes(6), meta.profile.shinies.includes(150), meta.profile.shinies.includes(249)], [true, true, false], 'an evolved form and a listed legendary are in, Lugia is not');
});

test('metadata: build, rates, schemas, instrumentation, shims and the offline guard', () => {
  const md = env.getMetadata();
  assert.match(md.game.build, /^[a-z0-9]{6,}$/);
  assert.match(md.game.version ?? '', /^\d+\.\d+\.\d+$/);
  assert.match(md.game.bundleSha256, /^[0-9a-f]{64}$/);
  assert.ok(md.game.chunks > 10);
  assert.deepEqual(md.sim, { hz: 60, dt: 1 / 60, actionRepeat: 3, decisionsPerSecond: 20, render: false });
  assert.deepEqual(md.schema, { observation: 3, action: 2, decision: 2, snapshot: 1 });
  // Learning-side formats: the state extractor and the action codec always; the observation layout only with `encode: true`.
  assert.deepEqual([md.encoding.state, md.encoding.action.version, md.encoding.action.nvec, md.encoding.action.maskSize, md.encoding.observation], [2, 2, [9, 2, 2, 2, 2, 2, 2, 2, 89], 112, null]);
  assert.match(md.encoding.action.hash, /^[0-9a-f]{64}$/);
  assert.ok(md.instrumentation.some((i) => i.includes('observation.state')), 'the state extractor is a declared instrumentation point');
  assert.ok(md.instrumentation.length >= 6);
  for (const needle of ['fetch layer', 'module load hook', 'app.launch', 'entropy', 'HUD instance']) assert.ok(md.instrumentation.some((i) => i.includes(needle)), `no instrumentation entry about "${needle}"`);
  assert.match(md.shimHash, /^[0-9a-f]{64}$/);
  assert.ok(md.shims.includes('src/sim/browser.ts') && md.shims.includes('src/sim/guard.ts'));
  assert.equal(md.offline.guardInstalled, true);
  assert.equal(md.offline.selfTest?.ok, true);
  assert.deepEqual(md.offline.blocked, []);
  assert.ok(md.offline.primitives.includes('net.Socket.connect'));
  assert.deepEqual({ low: md.governor!.low, high: md.governor!.high, cut: md.governor!.cut, everCut: md.governor!.everCut, liveMax: md.governor!.liveMax }, { low: 45, high: 55, cut: false, everCut: false, liveMax: 800 });
  assert.ok(md.dialogs.handled.includes('showLevelUp') && md.dialogs.refused.includes('showPact'));
});

test('observations are frozen copies: nothing in them reaches or changes the game', async () => {
  let obs = await env.reset({ seed: 21 });
  assert.equal(obs.phase, 'play');
  assert.equal(obs.schema, 3);
  assert.equal(obs.encoded, undefined, 'the numeric encoding is off by default');
  assert.ok(Object.isFrozen(obs.state) && Object.isFrozen(obs.state.build.moves) && Object.isFrozen(obs.state.counters));
  assert.deepEqual([obs.state.schema, obs.state.counters.kills, obs.state.zone.zone, obs.state.build.moves[0]?.key], [2, 0, 1, obs.snapshot.player.moves[0].key]);
  assert.deepEqual([obs.step, obs.simStep, obs.snapshot.t], [0, 0, 0]);
  assert.deepEqual(obs.mask, { phase: 'play', move: MOVES.map(() => true), jump: true, dash: true, ultimate: false, interact: false, form: false, incense: true, fuse: false });   // a run starts with one Incense: a rift can be opened at once
  assert.ok(Object.isFrozen(obs) && Object.isFrozen(obs.snapshot) && Object.isFrozen(obs.snapshot.player) && Object.isFrozen(obs.snapshot.player.moves) && Object.isFrozen(obs.mask));
  assert.throws(() => { (obs.snapshot.player as any).hp = 1; }, TypeError);
  assert.throws(() => { (obs.snapshot.enemies.list as any).push([]); }, TypeError);
  const live = env.debug.sim!.run;
  const seen = new Set<unknown>();
  const walk = (v: unknown) => {
    if (!v || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    assert.notEqual(v, live); assert.notEqual(v, live.player); assert.notEqual(v, live.player.pos);
    const proto = Object.getPrototypeOf(v);
    assert.ok(proto === Object.prototype || proto === Array.prototype, 'only plain objects and arrays');
    for (const x of Object.values(v)) { assert.notEqual(typeof x, 'function'); walk(x); }
  };
  walk(obs);
  // Two reads are two separate copies, and neither changes when the game moves on.
  const again = env.getObservation();
  assert.notEqual(again, obs);
  assert.deepEqual(again, obs);
  const res = await env.step({ type: 'play', move: 'n' });
  assert.equal(obs.snapshot.t, 0);
  assert.ok(res.observation.snapshot.t > 0);
  assert.ok(Object.isFrozen(res.info) && Object.isFrozen(res.observation.snapshot.terrain));
  obs = res.observation;
});

test('play step: three simulation steps of 1/60 s, movement by world direction, reward 0', async () => {
  await env.reset({ seed: 21 });
  const a = env.getObservation();
  // The unlocked profile at the start of a run: 2 + 6 (Lab) + 1 (friendship) refreshes and skips, 1 + 6 + 1 banishes;
  // Cyndaquil's 109 max HP + 64 (Lab) + 10 (friendship).
  const fresh = env.debug.sim!.run;
  assert.deepEqual([fresh.rerolls, fresh.skips, fresh.banishes, a.snapshot.player.maxHp], [9, 9, 8, 183]);
  let res = await env.step({ type: 'play', move: 'none' });
  assert.deepEqual([res.reward, res.terminated, res.truncated, res.info.simSteps, res.info.idleSteps], [0, false, false, 3, 0]);
  assert.ok(Math.abs(res.info.time - 0.05) < 1e-9, `run clock ${res.info.time}`);
  assert.deepEqual([res.observation.step, res.observation.simStep], [1, 3]);
  assert.deepEqual([res.observation.snapshot.player.x, res.observation.snapshot.player.z], [a.snapshot.player.x, a.snapshot.player.z]);
  for (let i = 0; i < 20; i++) res = await env.step({ type: 'play', move: 'e' });
  const p = res.observation.snapshot.player;
  assert.ok(p.x - a.snapshot.player.x > 4 && Math.abs(p.z - a.snapshot.player.z) < 0.6, `moved to ${p.x}, ${p.z}`);
  for (let i = 0; i < 20; i++) res = await env.step({ type: 'play', move: MOVES.indexOf('s') });
  assert.ok(res.observation.snapshot.player.z - p.z > 4);
  assert.deepEqual(res.info.blockedNetwork, []);
  assert.equal(res.info.zone, 1);
  // Jump is taken on the key-down edge of the first simulation step.
  res = await env.step({ type: 'play', move: 'none', jump: true });
  assert.equal(res.observation.snapshot.player.grounded, false);
});

test('invalid actions are rejected by name: thrown by default, flagged with invalidAction: "penalty"', async () => {
  await env.reset({ seed: 21 });
  const before = env.getObservation();
  await assert.rejects(env.step({ type: 'play', move: 12 }), InvalidActionError);
  await assert.rejects(env.step({ type: 'play', move: 'n', ultimate: true }), /ultimate is masked/);
  await assert.rejects(env.step({ type: 'choice', option: 0 }), /a "choice" action was sent in the play phase/);
  await assert.rejects(env.step(null as never), /not an object/);
  assert.deepEqual(env.getObservation(), before, 'a rejected action changes nothing');
  (env.options as { invalidAction: string }).invalidAction = 'penalty';
  try {
    const res = await env.step({ type: 'play', move: 'n', interact: true });
    assert.match(res.info.invalidAction!, /interact is masked/);
    assert.deepEqual([res.info.simSteps, res.observation.snapshot.t, res.observation.step, res.reward], [0, 0, 1, 0]);
  } finally { (env.options as { invalidAction: string }).invalidAction = 'throw'; }
});

test('level-up arrives as a structured decision and is answered through the game\'s callback', async () => {
  let obs: Observation = await env.reset({ seed: 21 });
  const idle = idlePolicy();
  let res: StepResult | null = null;
  while (obs.phase === 'play') { res = await env.step(idle.act(obs)); obs = res.observation; assert.equal(res.terminated, false, 'died before the first level-up'); }
  const d = obs.decision!;
  assert.equal(d.kind, 'levelup');
  assert.equal(d.method, 'showLevelUp');
  assert.equal(obs.snapshot.state, 'modal');
  assert.equal(d.options.length, 4, 'the Lab\'s fourth choice is unlocked');
  for (const o of d.options) assert.match(o.id, /^(newMove|upMove|newVit|upVit|[a-zA-Z]+):/);
  assert.deepEqual(Object.keys(d.extras).sort(), ['banish', 'banishKit', 'refresh', 'skip']);
  const mask = obs.mask as ChoiceMask;
  assert.deepEqual(mask.options, [true, true, true, true]);
  assert.equal(mask.extras.refresh, true);
  const run = env.debug.sim!.run;
  const { rerolls, banishes } = run;
  assert.equal(d.context.rerolls, rerolls);
  await assert.rejects(env.step({ type: 'play', move: 0 }), /a "play" action was sent in the choice phase/);
  await assert.rejects(env.step({ type: 'choice', option: 4 }), /out of range/);
  await assert.rejects(env.step({ type: 'choice', extra: 'sell' }), /no extra action "sell"/);
  await assert.rejects(env.step({ type: 'choice', extra: 'banish' }), /needs a target/);

  // Refresh: the game takes one use and offers again, without game time passing.
  const t = obs.snapshot.t;
  res = await env.step({ type: 'choice', extra: 'refresh' });
  assert.equal(res.observation.phase, 'choice');
  assert.equal(res.observation.decision!.serial, d.serial + 1);
  assert.equal(run.rerolls, rerolls - 1);
  assert.deepEqual([res.info.simSteps, res.observation.snapshot.t], [0, t]);
  // Banish the second offer: one use gone, its key banned in the game, new offers.
  const banned = res.observation.decision!.options[1].data.key as string;
  res = await env.step({ type: 'choice', extra: 'banish', target: 1 });
  assert.equal(run.banishes, banishes - 1);
  assert.ok(run.banished.has(banned));
  assert.ok(!res.observation.decision!.options.some((o) => o.data.key === banned));
  // Take the first offer: back to play, the player's build changed.
  const pick = res.observation.decision!.options[0];
  const level = run.pendingLevels;
  res = await env.step({ type: 'choice', option: 0 });
  assert.equal(res.observation.phase, 'play');
  assert.equal(res.observation.decision, null);
  assert.equal(run.pendingLevels, level - 1);
  const pl = res.observation.snapshot.player;
  const got = pick.data.kind === 'newVit' || pick.data.kind === 'upVit' ? Object.keys(pl.vitamins).includes(String(pick.data.vit)) : pl.moves.length + Object.keys(pl.items).length > 1 || pl.moves[0].level > 1;
  assert.ok(got, `the picked offer ${pick.id} is in the build`);
  assert.deepEqual(env.debug.dialogsSeen, { levelup: 3 });
});

test('truncation: only by the configured cap on game time; the next reset closes the open run', async () => {
  (env.options as { maxGameTime: number }).maxGameTime = 3;
  try {
    let obs = await env.reset({ seed: 33 });
    let res: StepResult | null = null;
    for (;;) { res = await env.step({ type: 'play', move: 'w' }); obs = res.observation; if (res.terminated || res.truncated) break; }
    assert.deepEqual([res.terminated, res.truncated, obs.phase], [false, true, 'over']);
    assert.match(res.info.endCause!, /truncated: game time reached the cap of 3 s/);
    assert.equal(res.info.end, undefined);
    assert.ok(res.info.time >= 3 && res.info.time < 3.06);
    assert.deepEqual(obs.mask, { phase: 'over' });
    await assert.rejects(env.step({ type: 'play', move: 0 }), /the episode is over/);
  } finally { (env.options as { maxGameTime: number }).maxGameTime = 0; }
});

test('terminal: a fainted run ends the episode with the game\'s own record; another species, map and tier start', async () => {
  const { last, kinds } = await playAndDigest(11, Infinity, { species: 25, map: 'coast', tier: 2 });
  assert.deepEqual([last.terminated, last.truncated, last.observation.phase], [true, false, 'over']);
  assert.equal(last.info.state, 'over');
  assert.equal(last.info.endCause, 'died');
  const end = last.info.end!;
  assert.deepEqual([end.how, end.victory], ['died', false]);
  assert.deepEqual([end.record.species, end.record.biome, end.record.tier, end.record.mode], [25, 'coast', 2, 'standard']);
  assert.equal(end.record.kills, last.info.kills);
  assert.equal(end.record.level, last.info.level);
  assert.ok(Math.abs((end.record.time as number) - last.info.time) < 1e-6);
  assert.equal(last.observation.snapshot.player.species, 25);
  assert.ok(last.info.idleSteps > 0, 'the fainting sequence ran without input');
  assert.ok(kinds.has('levelup'));
  assert.deepEqual(last.info.blockedNetwork, []);
  await assert.rejects(env.step({ type: 'play', move: 0 }), /the episode is over/);
});

test('reset is reproducible: the same seed gives the same episode as the first one of this process', async () => {
  // Several episodes have run since (other seeds, species, a truncated run, a death). Seed 5 again:
  const again = await playAndDigest(5, 20);
  assert.equal(again.digest, firstDigest);
  // …and a different seed is a different episode.
  const other = await playAndDigest(6, 20);
  assert.notEqual(other.digest, firstDigest);
  assert.equal(env.getMetadata().governor!.everCut, false);
  assert.deepEqual(env.getMetadata().offline.blocked, []);
});

test('nothing an episode depends on is random per process: account id, hunt counters, real-time counter', async () => {
  await env.reset({ seed: 77 });
  const sim = env.debug.sim!;
  // The game hashes the account id into its legendary-encounter roll: it must be the same in every process.
  const expected = createHash('sha256').update('pb-sim-id|0').digest('hex').slice(0, 16);
  assert.equal(sim.session!.id, expected);
  assert.equal(sim.app.meta.account.id, expected);
  // …and the per-run counter of that roll follows the episode seed.
  const hunt = sim.app.meta.profile.hunt as Record<string, { k: number; m: number }>;
  assert.deepEqual(Object.keys(hunt).map(Number).sort((a, b) => a - b), [144, 145, 146, 150, 151]);
  for (const h of Object.values(hunt)) assert.deepEqual(h, { k: 77, m: 0 });
  // Loading frames (their number depends on the process's caches) are not counted by the run.
  assert.equal(sim.run.realTime, 0);
  await env.reset({ seed: 78 });
  assert.equal((sim.app.meta.profile.hunt as Record<string, { k: number }>)['151'].k, 78);
  assert.equal(sim.run.realTime, 0);
  // The game caps the counter at 1,000,000: larger seeds wrap around instead of being refused.
  await env.reset({ seed: 2_500_003 });
  assert.equal((sim.app.meta.profile.hunt as Record<string, { k: number }>)['151'].k, 2_500_003 % 1_000_001);
  await env.reset({ seed: 2_500_004 });
  assert.equal((sim.app.meta.profile.hunt as Record<string, { k: number }>)['151'].k, 2_500_004 % 1_000_001);
});

test('reset refuses what the game would not offer', async () => {
  await assert.rejects(env.reset({ seed: 1, map: 'nowhere' }), /unknown map "nowhere"/);
  await assert.rejects(env.reset({ seed: 1, tier: 3 }), /tier 3 does not exist/);
  await assert.rejects(env.reset({ seed: 1, species: 2 }), /species 2 is not a League member/);
});

test('Classic can be asked for: same rules object, without the competitive flag', async () => {
  const obs = await env.reset({ seed: 5, ranked: false });
  assert.equal(obs.snapshot.mode, 'standard');
  assert.equal(env.debug.sim!.run.competitive, false);
  assert.equal(env.debug.sim!.run.seals.enabled, true, 'seals belong to the standard mode, not to Ranked');
  assert.equal(env.getMetadata().mode.ranked, false);
});
