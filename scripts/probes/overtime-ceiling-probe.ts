/**
 * CHEATING PROBE. Not an agent, not part of the environment, never used for training or evaluation.
 *
 * Phase 0 of the heuristic + RL refactor: what is the most a run can make in Shrine Overtime, and what does the game
 * really do there? It reaches Overtime the way scripts/probes/lifecycle-cheat-probe.ts does (full heal every step,
 * teleport to map points, guardian HP set to 1) and then plays Overtime with one of these cheats:
 *
 *   --kill=all     every enemy alive is hit for lethal damage every decision (through the game's own combat.hit, so
 *                  kills are tallied by the game with their weight): the SPAWN ceiling, nothing limits KOs but spawns
 *   --kill=moves   the Pokémon's own moves do the killing with its damage stat multiplied by --dmg (default 1e9): the
 *                  COVERAGE ceiling of the build the probe happens to have (grow one with --wake)
 *   --kill=none    no help with killing
 *   --heal=full    HP set to maximum every decision (default)       --heal=none   the tide and the hits are left alone:
 *                  for checking the survival model (docs: phase 0 report) against what the game takes
 *   --amount=3     set the spawn multiplier the game computes (difficulty x enemy amount x tier amount, clamped to
 *                  1..3) to this value by rewriting the tier amount when Overtime starts; 0 = leave what the run has
 *
 *   node scripts/probes/overtime-ceiling-probe.ts --seed=1 --kill=all --amount=3 --seals=all --offers=pleamar,dique
 *   node scripts/probes/overtime-ceiling-probe.ts --seed=1 --kill=all --heal=none --seals=none --json=out.json
 *
 * Other options: --tier=2 --species=150 --map=forest --wake=<zone seconds before waking a guardian, default 5>
 *   --rounds=<leave by the portal after this many rounds, default 24 = let it end by itself> --offers=<preference list>
 *   --maxhp=<set max HP to this at Overtime start (cheat), 0 = leave> --budget=<wall seconds, default 900>
 *   --xp=<experience given at the start (cheat): the level-ups build a full kit before Overtime>
 *   --build=<file>  a build to hand to the Pokémon at the start (cheat): a run record as the leaderboard serves it
 *       (`build.items` with counts, `build.vits` with levels, `build.held.relics`). Physical-only items and Protein are
 *       replaced by their special counterparts, since Mewtwo is a special attacker. --rarity=<0..4> of the vitamins (2).
 *   --force-stats  with --build: also write the record's own stat sheet over the Pokémon's stats every decision (cheat):
 *       what the handed-out items do not reproduce (Training levels, blessings, the player's own moves) is then covered
 *   --runtime=<s>  set the run clock to this when the shrine relights (cheat): the tide's reference HP is 400 + run seconds
 *   --god  no hit lands at all (i-frames rewritten every decision), before and during Overtime; the tide still drains
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createEnvironment, validChoices } from '../../src/environment/index.ts';
import type { Action, ChoiceMask, Observation, PlayMask } from '../../src/environment/index.ts';
import { real } from '../../src/sim/clock.ts';

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) { const m = /^--([\w-]+)(?:=(.*))?$/.exec(a); if (m) args.set(m[1], m[2] ?? 'true'); }
const num = (k: string, d: number) => (args.has(k) ? Number(args.get(k)) : d);
const say = (s: string) => process.stdout.write(s + '\n');
const SEALS = args.get('seals') ?? 'all', WAKE = num('wake', 5), KILL = args.get('kill') ?? 'all', HEAL = args.get('heal') ?? 'full';
const AMOUNT = num('amount', 0), DMG = num('dmg', 1e9), ROUNDS = num('rounds', 24), MAXHP = num('maxhp', 0);
const XP = num('xp', 0), GOD = args.has('god');
const healBy: Record<string, number> = {};
let xpGiven = false;
const BUILD = args.has('build') ? JSON.parse(readFileSync(args.get('build')!, 'utf8')) : null, RARITY = num('rarity', 2), RUNTIME = num('runtime', 0);
const SPECIAL: Record<string, string> = { 'muscle-band': 'wise-glasses', 'choice-band': 'choice-specs', protein: 'calcium' };
const VIT_VALUE = [1, 1.2, 1.45, 1.75, 2.1];
let buildGiven = false, clockSet = false;
const FORCE: Record<string, number> | null = args.has('force-stats') && BUILD ? (BUILD.build ?? BUILD).stats ?? null : null;
const OFFERS = (args.get('offers') ?? '').split(',').filter(Boolean);
const TIER = num('tier', 2);

const env = createEnvironment({ map: args.get('map') ?? 'forest', species: num('species', 150), tier: TIER, ranked: true });
const seed = num('seed', 1);
let obs: Observation = await env.reset({ seed });
const run = () => env.debug.sim!.run;
const log = (s: string) => say(`[t=${run().time.toFixed(1)} z${run().stage} zt=${run().stageTime.toFixed(0)} k=${run().stats.kills} L${run().player.level}] ${s}`);
const tp = (x: number, z: number) => { const p = run().player; p.pos.x = x; p.pos.z = z; p.pos.y = run().terrain.height(x, z); p.vel.set(0, 0, 0); };

// The game's own Overtime tables, read from the run's module for the expected figures (never written).
const W = { rate0: 30, rateGrow: 0.8, rateMax: 150, weightSecs: 45, weightMax: 7, amountMax: 3, roundSecs: 30 };
const rate = (s: number) => Math.min(W.rateMax, W.rate0 + W.rateGrow * Math.max(0, s));
const weight = (s: number) => Math.min(W.weightMax, 1 + Math.max(0, s) / W.weightSecs);

interface Round { round: number; mult: number; kos: number; spawned: number; elites: number; aliveMean: number; aliveMax: number; steps: number; wallMs: number; expected: number; drainHpPerS: number; healK: number; hp: number; maxHp: number; damageTaken: number; hits: number }
const rounds: Round[] = [];
const picks: string[] = [];
const timeline: any[] = [];
let cur: Round | null = null, aliveSum = 0, spawned = 0, elites = 0, otStart: any = null, patched = false, lastStage = 0, interactCd = 0, res: any = null, steps = 0, lastSecond = -1;
let takenAtRound = 0, hitsAtRound = 0;
const t0 = real.performanceNow();

function choose(o: Observation): Action {
  const d = o.decision!, mask = o.mask as ChoiceMask;
  const pick = (id: string): Action => ({ type: 'choice', option: d.options.findIndex((x) => x.id === id) });
  switch (d.kind) {
    case 'seals': return SEALS === 'all' ? { type: 'choice', option: d.options.length - 1 } : pick('none');
    case 'sanctuaryPath': return pick('sanct');
    case 'leaveSanctuary': return pick('ot');
    case 'overtimeStart': return { type: 'choice', option: 0 };
    case 'overtimeOffer': {
      const ids = d.options.map((x) => x.id);
      const want = OFFERS.find((k) => ids.includes(k));
      picks.push(`${want ?? 'none'} of ${ids.join('/')}`);
      return want ? pick(want) : pick('none').option >= 0 ? pick('none') : validChoices(mask).at(-1)!;
    }
    case 'shop': case 'dojo': case 'slots': case 'forget': case 'fusion': return { type: 'choice', extra: 'leave' };
    default: return validChoices(mask)[0];
  }
}

function closeRound(r: any): void {
  if (!cur) return;
  const ot = r.overtime;
  cur.kos = ot.rounds[cur.round] ?? 0; cur.spawned = spawned; cur.elites = elites; cur.aliveMean = cur.steps ? aliveSum / cur.steps : 0;
  cur.damageTaken = r.stats.damageTaken - takenAtRound; cur.hits = r.stats.hits - hitsAtRound;
  rounds.push(cur);
  say(`  round ${String(cur.round + 1).padStart(2)}  x${cur.mult.toFixed(2)}  KOs ${String(cur.kos).padStart(7)}  expected at this spawn multiplier ${String(Math.round(cur.expected)).padStart(7)}  spawned ${String(cur.spawned).padStart(5)} (+${cur.elites} elites)  alive mean ${cur.aliveMean.toFixed(0)} max ${cur.aliveMax}  ${(cur.wallMs / Math.max(1, cur.steps)).toFixed(2)} ms/decision  drain ${cur.drainHpPerS.toFixed(1)} HP/s  heal x${cur.healK.toFixed(2)}  HP ${cur.hp.toFixed(0)}/${cur.maxHp.toFixed(0)}  taken ${cur.damageTaken.toFixed(0)} in ${cur.hits} hits`);
  cur = null;
}

for (;;) {
  const r = run();
  if (res?.terminated || res?.truncated) break;
  let action: Action;
  if (obs.phase === 'choice') action = choose(obs);
  else {
    const p = r.player, ot = r.overtime, E = r.enemies;
    if (!ot.live || HEAL === 'full') p.hp = p.maxHp; // CHEAT: full heal
    if (GOD) p.iframes = Math.max(p.iframes, 1); // CHEAT: nothing lands
    if (FORCE && buildGiven) { for (const [k, v] of Object.entries(FORCE) as [string, number][]) if (k in p.stats && k !== 'maxHp') p.stats[k] = v; if (FORCE.maxHp && p.maxHp !== Math.round(FORCE.maxHp)) { p.maxHp = Math.round(FORCE.maxHp); p.stats.maxHp = FORCE.maxHp; } } // CHEAT
    if (XP > 0 && !xpGiven && r.time > 1) { xpGiven = true; p.addXp(XP); log(`CHEAT ${XP} experience`); }
    if (BUILD && !buildGiven && r.time > 1.2 && r.pendingLevels === 0) { // CHEAT: the build, through the functions the game's own build editor uses
      buildGiven = true;
      const b = BUILD.build ?? BUILD; let items = 0, refused = 0;
      for (const [key, count] of Object.entries(b.items ?? {}) as [string, number][]) for (let i = 0; i < count; i++) { if (p.$1iop5tj(SPECIAL[key] ?? key)) items++; else refused++; }
      for (const v of b.vits ?? []) { const key = SPECIAL[v.k] ?? v.k; p.vitamins.delete(key); for (let i = 0; i < v.lv; i++) p.$voqi7q(key, VIT_VALUE[RARITY]); }
      r.relicKeys = [...new Set<string>(b.held?.relics ?? b.relics ?? [])].slice(0, 3);
      p.recompute(); p.hp = p.maxHp;
      const st = p.stats;
      log(`CHEAT build: ${items} items (${refused} refused), vitamins ${JSON.stringify([...p.vitamins].map(([k, v]: any) => [k, v.level]))}, relics ${JSON.stringify(r.relicKeys)}, level ${p.level}, trained ${r.trainedLevels}`);
      log(`stats now: ${JSON.stringify(Object.fromEntries(['maxHp', 'damage', 'physical', 'special', 'attackSpeed', 'critChance', 'megaCrit', 'critDamage', 'area', 'projectiles', 'eliteDamage', 'healing', 'powerup', 'overheal', 'regen', 'lifesteal', 'armor', 'evasion', 'xpGain', 'luck', 'pickupRange', 'difficulty', 'enemyAmount'].map((k) => [k, +Number(st[k]).toFixed(2)])))}`);
    }
    if (r.stage !== lastStage) { lastStage = r.stage; log(`ZONE ${r.stage}: liveCap=${r.liveCap} maxEnemies=${r.maxEnemies} diff=${JSON.stringify(r.diff)}`); }
    const pts: any[] = r.interactables.list;
    const mask = obs.mask as PlayMask;
    let interact = false;
    interactCd--;
    const B = r.boss;
    if (B?.alive && typeof B.bossIndex === 'number' && B.bossIndex >= 0 && E.alive[B.bossIndex] && !B.immune && E.hp[B.bossIndex] > 1) E.hp[B.bossIndex] = 1; // CHEAT
    const goTo = (kind: string, pred: (i: any) => boolean = () => true) => {
      const it = pts.find((i) => i.kind === kind && pred(i));
      if (!it) return false;
      const rr = Number(it.r) || 2; if (Math.hypot(p.pos.x - it.x, p.pos.z - it.z) > Math.max(1.2, rr * 0.9)) { tp(it.x + Math.max(0.8, rr * 0.6), it.z); return true; }
      if (mask.interact && interactCd <= 0) { interact = true; interactCd = 8; }
      return true;
    };
    if (ot.live) {
      if (!patched) {
        patched = true;
        const st = p.stats;
        if (AMOUNT > 0) r.diff.enemyAmount = AMOUNT / (st.difficulty * st.enemyAmount); // CHEAT: the spawn multiplier
        if (MAXHP > 0) { p.maxHp = MAXHP; p.hp = MAXHP; } // CHEAT
        const heal = p.heal.bind(p);
        p.heal = (e: number) => { const got = heal(e); if (got > 0) { const who = (new Error().stack ?? '').split('\n')[2]?.trim().split(' ')[1] ?? '?'; healBy[who] = (healBy[who] ?? 0) + got; } return got; }; // accounting only
        const spawnOne = ot.spawnOne.bind(ot);
        ot.spawnOne = (flag: number, w: number) => { const before = E.count; spawnOne(flag, w); if (E.count > before) { if (flag) elites++; else spawned++; } }; // counts only
        otStart = { runTime: r.time, kills: r.stats.kills, level: p.level, maxHp: p.maxHp, refHp: ot.refHp, sealsKept: ot.seals, difficulty: st.difficulty, enemyAmount: st.enemyAmount, tierAmount: r.diff.enemyAmount,
          spawnMultiplier: Math.max(1, Math.min(3, st.difficulty * st.enemyAmount * r.diff.enemyAmount)), liveCap: r.liveCap, bodyCap: Math.min(350, r.$a97lzn), stats: { healing: st.healing, lifesteal: st.lifesteal, regen: st.regen, armor: st.armor, evasion: st.evasion, shieldMax: st.shieldMax, overheal: st.overheal, damage: st.damage, special: st.special } };
        log(`OVERTIME starts: ${JSON.stringify(otStart)}`);
      }
      if (!cur || cur.round !== ot.round) {
        closeRound(r);
        const m = otStart.spawnMultiplier; let expected = 0;
        for (let s = ot.round * W.roundSecs; s < (ot.round + 1) * W.roundSecs; s++) expected += rate(s + 0.5) * m * weight(s + 0.5);
        cur = { round: ot.round, mult: ot.mult(ot.round), kos: 0, spawned: 0, elites: 0, aliveMean: 0, aliveMax: 0, steps: 0, wallMs: 0, expected, drainHpPerS: ot.drainHp, healK: r.tideHealK(), hp: p.hp, maxHp: p.maxHp, damageTaken: 0, hits: 0 };
        aliveSum = 0; spawned = 0; elites = 0; takenAtRound = r.stats.damageTaken; hitsAtRound = r.stats.hits;
      }
      if (KILL === 'all') { for (let i = 0; i < E.n; i++) if (E.alive[i] && E.hp[i] > 0) r.combat.hit(i, 1e30, { type: 'psychic', cls: 'special', fixed: true, noReact: true, silent: true }); } // CHEAT
      else if (KILL === 'moves' && p.stats.damage < DMG) p.stats.damage *= DMG; // CHEAT (recompute resets it; applied again)
      cur.steps++; aliveSum += E.count; cur.aliveMax = Math.max(cur.aliveMax, E.count);
      const sec = Math.floor(ot.secs);
      if (sec !== lastSecond) {
        lastSecond = sec;
        timeline.push({ s: sec, hp: +p.hp.toFixed(1), maxHp: +p.maxHp.toFixed(1), overheal: +(p.overheal ?? 0).toFixed(1), shield: +(p.shield ?? 0).toFixed(1), leech: +(p.leechBudget ?? 0).toFixed(1), drain: +ot.drainHp.toFixed(2), healK: +r.tideHealK().toFixed(3), taken: +r.stats.damageTaken.toFixed(0), hits: r.stats.hits, alive: E.count, kills: r.stats.kills, ring: +(r.sanctuary?.ringR ?? 0).toFixed(1), level: p.level, trained: r.trainedLevels, healing: +p.stats.healing.toFixed(2), spawnMult: +Math.max(1, Math.min(3, p.stats.difficulty * p.stats.enemyAmount * r.diff.enemyAmount)).toFixed(2) });
      }
      if (ot.round >= ROUNDS) goTo('portal');
    } else if (r.regionCleared && !ot.over) {
      if (RUNTIME > 0 && !clockSet) { clockSet = true; log(`CHEAT run clock ${r.time.toFixed(0)} → ${RUNTIME}`); r.time = RUNTIME; }
      goTo('shrine', (i) => i.data?.ot && !i.used);
    } else if (r.stageCleared || (ot.over && r.state === 'play')) {
      goTo('portal');
    } else if (!r.bossSpawned && r.stageTime >= WAKE) {
      goTo('boss', (i) => !i.used) || goTo('shrine', (i) => !i.used);
    }
    action = { type: 'play', move: interact ? 0 : (r.stage === 4 && !ot.live ? 0 : 1 + (Math.floor(r.time / 3) % 8)), interact };
  }
  const w0 = real.performanceNow();
  res = await env.step(action);
  if (cur) cur.wallMs += real.performanceNow() - w0;
  obs = res.observation;
  if (++steps > 600000 || real.performanceNow() - t0 > num('budget', 900) * 1000) { log('probe stopped: budget'); break; }
}
const r = run(), ot = r.overtime, info = res?.info;
closeRound(r);
const recomputed = Math.floor(ot.rounds.reduce((s: number, k: number, i: number) => s + k * (ot.mult(i) - 1), 0));
const summary = {
  seed, tier: TIER, kill: KILL, heal: HEAL, seals: SEALS, offers: picks, start: otStart,
  end: { cause: info?.endCause, runTime: info?.time, overtimeSecs: ot.secs, roundsPlayed: ot.rounds.length, cashed: ot.cashed, lost: ot.lost },
  healedBy: Object.fromEntries(Object.entries(healBy).map(([k, v]) => [k, Math.round(v)])),
  level: r.player.level, trainedLevels: r.trainedLevels, maxHpAtEnd: r.player.maxHp,
  kills: r.stats.kills, killsInOvertime: r.stats.kills - (otStart?.kills ?? 0), bonus: ot.bonus, bonusRecomputed: recomputed, score: r.stats.kills + (ot.cashed ? ot.bonus : 0),
  expectedKillsAtThisMultiplier: Math.round(rounds.reduce((s, x) => s + x.expected, 0)), wallSeconds: (real.performanceNow() - t0) / 1000, governor: env.getMetadata().governor, rounds,
};
say(`END cause="${info?.endCause}" overtime ${ot.secs.toFixed(1)} s, ${ot.rounds.length} rounds, cashed=${ot.cashed} lost=${ot.lost}`);
say(`KOs in Overtime ${summary.killsInOvertime} (expected from the spawn formula ${summary.expectedKillsAtThisMultiplier}), bonus ${ot.bonus} (recomputed ${recomputed}), score ${summary.score}, offerings: ${picks.join('; ') || 'none offered'}`);
say(`record: ${JSON.stringify(info?.end?.record?.ot ?? null)} seals: ${JSON.stringify(info?.end?.record?.seals ?? null)}`);
if (args.has('json')) writeFileSync(args.get('json')!, JSON.stringify({ ...summary, timeline }));
await env.close();
process.exit(0);
