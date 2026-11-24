import type { RunRecord } from './store.ts';

/**
 * Sandbox progression. The real service owns the rules for rewards; this is a small local approximation so that a
 * practice profile moves forward between runs (new picks on the select screen, a run history, a best time). The
 * numbers here are the sandbox's own and mean nothing outside it.
 */

/** A new local profile. The client fills in every field it needs that is missing here. */
export function freshProfile(name: string): Record<string, any> {
  return {
    v: 1, name, created: Date.now(),
    stardust: 0, totalStardust: 0,
    starter: 0, unlocked: [], league: [], played: [], seen: [],
    captured: {}, shinies: [], classics: [], forms: [], research: {},
    biomes: { forest: 0 },
    runs: [], best: {}, times: {}, kills: {}, counters: {},
    lastSpecies: 4, lastBiome: 'forest',
  };
}

const uniqPush = (list: any[], v: any) => { if (!list.includes(v)) list.push(v); };

/** Fold a finished run into the profile. Returns the summary sent back with the finish response. */
export function applyRunToProfile(p: Record<string, any>, r: RunRecord, family: (species: number) => number = (s) => s): Record<string, unknown> {
  const res = r.result ?? {};
  const time = Number(res.time) || 0, kills = Number(res.kills) || 0, level = Number(res.level) || 0;
  const species = Number(res.species ?? r.request.species) || 0;
  const biome = String(res.biome ?? r.request.biome ?? 'forest');
  const tier = Number(res.tier ?? r.request.tier) || 0;
  const mode = String(res.mode ?? r.request.mode ?? 'standard');

  for (const k of ['unlocked', 'league', 'played', 'seen', 'shinies', 'classics', 'runs', 'forms'])
    if (!Array.isArray(p[k])) p[k] = [];
  for (const k of ['captured', 'best', 'times', 'kills', 'counters', 'biomes', 'research'])
    if (!p[k] || typeof p[k] !== 'object') p[k] = {};

  // Captures made during the run join the local roster.
  const prog = res.progress ?? {};
  const league: number[] = Array.isArray(prog.league) ? prog.league.filter(Number.isInteger) : [];
  for (const sp of league) { uniqPush(p.league, sp); uniqPush(p.unlocked, family(sp)); p.captured[family(sp)] ??= Date.now(); }
  for (const sp of Array.isArray(prog.shinies) ? prog.shinies : []) uniqPush(p.shinies, sp);
  for (const sp of Array.isArray(prog.classics) ? prog.classics : []) uniqPush(p.classics, sp);
  for (const sp of Array.isArray(prog.seen) ? prog.seen : []) uniqPush(p.seen, sp);
  for (const f of Array.isArray(prog.forms) ? prog.forms : []) uniqPush(p.forms, f);
  // The client reports what it counted during the run (kills by type, heals, dodges...) as deltas.
  for (const [k, v] of Object.entries(prog.counters ?? {})) if (Number.isFinite(v)) p.counters[k] = (Number(p.counters[k]) || 0) + (v as number);
  for (const [k, v] of Object.entries(prog.research ?? {})) if (Number.isFinite(v)) p.research[k] = (Number(p.research[k]) || 0) + (v as number);
  if (species) uniqPush(p.played, species);

  // A small flat reward so the local shop has something to spend.
  const dust = Math.round(kills * 0.05 + time * 0.1 + (res.victory ? 100 : 0));
  p.stardust = (Number(p.stardust) || 0) + dust;
  p.totalStardust = (Number(p.totalStardust) || 0) + dust;

  // Clearing a biome tier opens the next tier of it.
  if (res.victory && mode === 'standard') p.biomes[biome] = Math.max(Number(p.biomes[biome]) || 0, tier + 1);

  const key = `${biome}:${tier}`;
  if (res.victory && (!p.times[key] || time < p.times[key])) p.times[key] = time;
  if (!p.best[mode] || time > (p.best[mode].time ?? 0)) p.best[mode] = { time, level, kills, species, at: Date.now() };
  p.kills[species] = (Number(p.kills[species]) || 0) + kills;
  p.counters.runs = (Number(p.counters.runs) || 0) + 1;

  p.runs.unshift({ id: r.id, at: Date.now(), species, biome, tier, mode, time, level, kills, victory: !!res.victory, stage: res.stage ?? 0 });
  if (p.runs.length > 30) p.runs.length = 30;
  p.lastSpecies = species || p.lastSpecies;
  p.lastBiome = biome;

  return { stardust: dust, forms: [], tasks: [] };
}
