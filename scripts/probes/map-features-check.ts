/**
 * Check of the map features against the real game: the slot machine, the dojo, Hypno, Bill's fusion machine, selling
 * in the shop, rifts (Incense) and Max form. THIS ONE DOES NOT CHEAT: it only acts through the environment, as a
 * policy does, and reads only observations. It is not a baseline and its results are not stored.
 *
 * It walks a tour of map points (--tour, by kind: the nearest unused one in the observation) with the environment's
 * route planner, pressing interact in reach; between targets, and for every dialog it has no rule for, the heuristic
 * baseline plays. The rules here: spin a few times; take a dojo trial and play it (stay in the circle, stand still
 * for the statue, run to the marks); forget a vitamin and a move at Hypno and take the lesson; fuse or link at
 * Bill's machine when a pair is ready; sell one item at the shop; stand in a Power Altar and press the Max-form key;
 * from --rift-after on, burn Incense, walk into the rift, call its waves and leave through its portal.
 * What each answer changed is printed, and at the end the counters of the run.
 *
 *   node scripts/probes/map-features-check.ts [--seed=1] [--to=600] [--species=150] [--map=forest] [--quiet]
 *        [--tour=hypno,dojo,power,slots,meowth,bill] [--patience=70] [--rift-after=300] [--spins=4] [--trial=0]
 */
import { createEnvironment } from '../../src/environment/index.ts';
import type { Action, ChoiceMask, Observation, PlayAction, PlayMask } from '../../src/environment/index.ts';
import { nearestMove } from '../../src/player/adapter.ts';
import { playerPolicy } from '../../src/player/policy.ts';

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) { const m = /^--([\w-]+)(?:=(.*))?$/.exec(a); if (m) args.set(m[1], m[2] ?? 'true'); }
const num = (k: string, d: number) => (args.has(k) ? Number(args.get(k)) : d);
const say = (s: string) => process.stdout.write(s + '\n');
const env = createEnvironment({ maxGameTime: num('to', 600), species: num('species', 150), map: args.get('map') ?? 'forest', tier: 0 });
const seed = num('seed', 1);
let obs: Observation = await env.reset({ seed });
const policy = playerPolicy({ planRoute: (x, z) => env.planRoute(x, z) });
policy.reset(seed);

/** Map-point kind → the dialog its interact opens (none: the point is used by standing in it). */
const DIALOG: Record<string, string> = { slots: 'slots', hypno: 'forget', dojo: 'dojo', bill: 'fusion', meowth: 'shop' };
const tour = (args.get('tour') ?? 'hypno,dojo,power,slots,meowth,bill').split(',').filter(Boolean);
let targetSince = 0, tourWait = 0;
const seen: Record<string, number> = {};
const visitState = { spins: 0, forgotMove: false, forgotVitamin: false, sold: false };
const brief = (o: Observation) => {
  const b = o.state.build;
  return `gold ${o.state.economy.gold}, moves [${b.moves.map((m) => (m ? `${m.key}:${m.level}${m.fusion ? '*' : ''}${m.linked ? '+' + m.linked : ''}` : '-')).join(' ')}], vitamins [${b.vitamins.map((v) => `${v.key}:${v.level}`).join(' ')}], items ${b.items.reduce((a, i) => a + i.count, 0)}`;
};
const next = (why: string) => { const k = tour.shift(); if (k) say(`[${obs.snapshot.t.toFixed(1)}s] tour: done with ${k} (${why}); next ${tour[0] ?? 'none: the heuristic plays on'}`); targetSince = obs.snapshot.t; };
const later = (why: string) => {
  const k = tour.shift();
  if (k) { tour.push(k); if (tour.length > 1 || obs.snapshot.t >= tourWait) say(`[${obs.snapshot.t.toFixed(1)}s] tour: ${k} put back (${why}); next ${tour[0]}`); }
  targetSince = obs.snapshot.t;
  if (tour.length === 1) tourWait = obs.snapshot.t + 20;   // the only target left: try it again in a while
};

function answer(o: Observation): Action | null {
  const d = o.decision!, mask = o.mask as ChoiceMask;
  const first = mask.options.indexOf(true);
  const leave = (kind: string): Action => { if (tour[0] && DIALOG[tour[0]] === kind) next('dialog closed'); return { type: 'choice', extra: 'leave' }; };
  switch (d.kind) {
    case 'slots': return mask.options[0] && visitState.spins++ < num('spins', 4) ? { type: 'choice', option: 0 } : leave('slots');
    case 'dojo': if (tour[0] === 'dojo') next('trial chosen'); return { type: 'choice', option: Math.min(num('trial', 0), d.options.length - 1) };
    case 'dojoPrize': return { type: 'choice', option: 0 };
    case 'lesson': return first >= 0 ? { type: 'choice', option: first } : { type: 'choice', extra: 'decline' };
    case 'forget': {
      const lessonAt = d.options.findIndex((x) => x.id === 'lesson');
      if (mask.options[lessonAt]) return { type: 'choice', option: lessonAt };
      const vit = d.options.findIndex((x, i) => x.data.what === 'vitamin' && mask.options[i]);
      if (vit >= 0 && !visitState.forgotVitamin) { visitState.forgotVitamin = true; return { type: 'choice', option: vit }; }
      const moves = d.options.map((x, i) => ({ x, i })).filter(({ x, i }) => x.data.what === 'move' && mask.options[i]);
      if (moves.length >= 2 && !visitState.forgotMove) { visitState.forgotMove = true; return { type: 'choice', option: moves[moves.length - 1].i }; }
      return leave('forget');
    }
    case 'fusion':
      if (first >= 0) { if (tour[0] === 'bill') next('fused'); return { type: 'choice', option: args.has('link') ? Math.max(first, d.options.findIndex((x) => x.data.how === 'link')) : first }; }
      if (tour[0] === 'bill') { later(`no pair ready: ${JSON.stringify(d.context.notReady).slice(0, 160)}`); tourWait = Math.max(tourWait, o.snapshot.t + 20); }
      return { type: 'choice', extra: 'leave' };
    case 'shop':
      if (!visitState.sold && mask.extras.sell === true) return { type: 'choice', extra: 'sell' };
      if (tour[0] === 'meowth') next('shop visited');
      return null;
    case 'shopSell': if (!visitState.sold) { visitState.sold = true; return { type: 'choice', option: 0 }; } return { type: 'choice', extra: 'leave' };
    default: return null;
  }
}

/** Walk towards a world point with the route planner. */
function walk(play: PlayAction, x: number, z: number): void {
  const nav = env.planRoute(x, z), p = obs.snapshot.player;
  const t = nav ?? { x, z };
  play.move = nearestMove({ x: t.x - p.x, z: t.z - p.z });
  play.jump = !!nav?.jump;
}

const NEW = new Set(['slots', 'dojo', 'dojoPrize', 'lesson', 'forget', 'fusion', 'shopSell']);
const pressed = { incense: 0, fuse: 0, form: 0 };
let riftSteps = 0, lastDojo = '';
for (;;) {
  let action = policy.act(obs);
  const before = obs;
  if (obs.phase === 'choice') {
    const d = obs.decision!;
    seen[d.kind] = (seen[d.kind] ?? 0) + 1;
    action = answer(obs) ?? action;
  } else {
    const mask = obs.mask as PlayMask, play = action as PlayAction, s = obs.snapshot, st = obs.state;
    const rift = s.rift, dj = st.dojo;
    if (mask.form) { play.form = true; pressed.form++; }
    if (rift.inside) {
      // Inside: call the waves; once the way out is there, walk to it and take it.
      riftSteps++;
      const out = s.points.find((q) => q.kind === 'portal');
      if (out) { walk(play, out.x, out.z); play.interact = mask.interact && out.d <= out.r + 0.5; } else if (mask.interact) play.interact = true;
    } else if (rift.entrance) {
      walk(play, rift.entrance.x, rift.entrance.z);
      play.interact = mask.interact;
    } else if (dj) {
      // A dojo trial: the area trials are steered here, the fighting ones are left to the heuristic's movement.
      const p = s.player;
      if (dj.key === 'statue') play.move = 'none';
      else if (dj.area && dj.key === 'race') walk(play, dj.area.x, dj.area.z);
      else if (dj.area && Math.hypot(dj.area.x - p.x, dj.area.z - p.z) > dj.area.radius * 0.5) walk(play, dj.area.x, dj.area.z);
      else if (dj.nearestFighter && (dj.key === 'chain' || dj.key === 'elites' || dj.key === 'wave' || dj.key === 'master')) walk(play, dj.nearestFighter.x, dj.nearestFighter.z);
      if (dj.key === 'statue' || dj.key === 'circle') { play.dash = false; play.jump = false; }
    } else if (s.t >= num('rift-after', 300) && (mask.fuse || mask.incense)) {
      if (mask.fuse) { play.fuse = true; pressed.fuse++; } else { play.incense = true; pressed.incense++; }
    } else if (tour.length && s.t >= tourWait) {
      const kind = tour[0];
      const target = s.points.filter((q) => q.kind === kind && !q.used).sort((a, b) => a.d - b.d)[0];
      if (!target) later('none in the observation');
      else if (s.t - targetSince > num('patience', 70)) later(`not done after ${num('patience', 70)} s`);
      else if (kind === 'slots' && st.economy.gold < st.economy.slotPrice) later(`${st.economy.gold} ₽ is less than the price of a spin, ${st.economy.slotPrice} ₽`);
      else if (kind === 'power' && (st.forms.charges >= 3 || st.forms.locked)) next('charges full or the form is locked');
      else {
        walk(play, target.x, target.z);
        play.interact = !!DIALOG[kind] && mask.interact && target.d <= target.r + 0.5;
        if (!DIALOG[kind] && target.d <= target.r * 0.6) play.move = 'none';
      }
    }
  }
  const res = await env.step(action);
  obs = res.observation;
  if (before.phase === 'choice') {
    const d = before.decision!;
    const isLeave = 'extra' in action && (action.extra === 'leave' || action.extra === 'decline');
    if ((NEW.has(d.kind) || (d.kind === 'shop' && 'extra' in action && action.extra === 'sell')) && !(args.has('quiet') && isLeave)) {
      const what = 'option' in action ? `option ${action.option} (${d.options[action.option]?.id})` : `extra ${(action as { extra: string }).extra}`;
      say(`[${before.snapshot.t.toFixed(1)}s] ${d.kind}: ${d.options.length} options [${d.options.slice(0, 7).map((x, i) => `${x.id}${(before.mask as ChoiceMask).options[i] ? '' : '✗'}`).join(', ')}${d.options.length > 7 ? ', …' : ''}] → ${what}`);
      say(`      before: ${brief(before)}${d.kind === 'slots' ? `, spin price ${String(d.context.cost)}` : ''}`);
      say(`      after:  ${brief(obs)}; next ${obs.phase}${obs.decision ? ` ${obs.decision.kind}${obs.decision.kind === 'slots' ? ` (last spin ${JSON.stringify(obs.decision.context.last)})` : ''}` : ''}`);
    }
  } else {
    const dj = obs.state.dojo, key = dj ? `${dj.key} belt ${dj.belt}` : '';
    if (key !== lastDojo) { say(`[${obs.snapshot.t.toFixed(1)}s] dojo trial: ${key ? `${key}, goal ${dj!.goal}, ${dj!.timeLeft.toFixed(0)} s, area ${JSON.stringify(dj!.area)}, fighters ${dj!.fighters}` : `ended after progress ${before.state.dojo?.progress.toFixed(1)} of ${before.state.dojo?.goal}; dojo points used ${obs.state.pointsUsed.dojo ?? 0}`}`); lastDojo = key; }
    const b = before.state, a = obs.state;
    if (a.rift.incense !== b.rift.incense) say(`[${obs.snapshot.t.toFixed(1)}s] incense ${b.rift.incense} → ${a.rift.incense}; entrance ${JSON.stringify(obs.snapshot.rift.entrance)}`);
    if (obs.snapshot.rift.inside !== before.snapshot.rift.inside) say(`[${obs.snapshot.t.toFixed(1)}s] rift: ${obs.snapshot.rift.inside ? 'entered' : 'left'}; rifts cleared ${a.counters.riftsCleared}, relics ${a.build.relics.join(',') || 'none'}`);
    if (a.forms.charges !== b.forms.charges || (a.forms.active > 0) !== (b.forms.active > 0)) say(`[${obs.snapshot.t.toFixed(1)}s] Max form: charges ${b.forms.charges} → ${a.forms.charges}, active ${a.forms.active.toFixed(1)} s, used ${a.counters.formsUsed}, power altars used ${a.pointsUsed.power ?? 0}`);
    if (tour[0] === 'power' && a.forms.charges > b.forms.charges) next('a charge gained');
  }
  if (res.terminated || res.truncated) { say(`end: ${res.info.endCause}`); break; }
}
const c = obs.state.counters;
say(`dialogs seen: ${JSON.stringify(seen)}`);
say(`keys pressed: ${JSON.stringify(pressed)}; steps inside a rift ${riftSteps}; tour left: ${tour.join(',') || 'none'}`);
say(`points used by kind: ${JSON.stringify(obs.state.pointsUsed)}`);
say(`counters: kills ${c.kills}, time ${c.time.toFixed(0)}, zone ${c.zonesEntered}, mapUse ${c.mapUse} (points ${c.pointsUsed}, shop ${c.shopBought}, spins ${c.slotSpins}, lessons ${c.lessons}, rifts ${c.riftsCleared}, forms ${c.formsUsed}), sold in the shop ${c.shopSold} (all sales ${c.itemsSold}), forgets ${c.forgets}, linked ${c.movesLinked}, gold earned ${c.goldEarned} spent ${c.goldSpent}`);
say(`blocked network: ${env.getMetadata().offline.blocked.length}`);
await env.close();
