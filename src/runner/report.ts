/**
 * Summary statistics over a set of episodes: what a baseline table shows. Works on database rows (snake_case columns
 * of `episodes`) so that the same code summarises a batch that just ran and one read back from the file.
 */

export interface Stat { n: number; mean: number; median: number; min: number; max: number }

export function stat(values: number[]): Stat {
  if (!values.length) return { n: 0, mean: NaN, median: NaN, min: NaN, max: NaN };
  const v = [...values].sort((a, b) => a - b), mid = v.length >> 1;
  return { n: v.length, mean: v.reduce((a, b) => a + b, 0) / v.length, median: v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2, min: v[0], max: v[v.length - 1] };
}

export interface EpisodeRow {
  seed: number; kills: number; game_time: number; level: number; zone: number; guardians_defeated: number; legendaries_defeated: number;
  end_cause: string; victory: number; overtime_started: number; overtime_bonus: number; overtime_cashed: number; sim_steps: number; wall_seconds: number;
}

export interface Summary {
  episodes: number;
  kills: Stat;
  /** KOs plus the overtime bonus of the episodes that cashed it. */
  killsWithBonus: Stat;
  gameTime: Stat;
  level: Stat;
  zone: Stat;
  guardians: Stat;
  /** How many episodes reached each zone (index = zone), beat each number of guardians, beat a legendary, started / cashed overtime. */
  reachedZone: Record<number, number>;
  beatGuardians: Record<number, number>;
  legendaries: number;
  overtimeStarted: number;
  overtimeCashed: number;
  victories: number;
  causes: Record<string, number>;
}

export function summarize(rows: EpisodeRow[]): Summary {
  const count = (key: (r: EpisodeRow) => number | string): Record<string, number> => { const out: Record<string, number> = {}; for (const r of rows) out[key(r)] = (out[key(r)] ?? 0) + 1; return out; };
  return {
    episodes: rows.length,
    kills: stat(rows.map((r) => r.kills)),
    killsWithBonus: stat(rows.map((r) => r.kills + (r.overtime_cashed ? r.overtime_bonus : 0))),
    gameTime: stat(rows.map((r) => r.game_time)),
    level: stat(rows.map((r) => r.level)),
    zone: stat(rows.map((r) => r.zone)),
    guardians: stat(rows.map((r) => r.guardians_defeated)),
    reachedZone: count((r) => r.zone), beatGuardians: count((r) => r.guardians_defeated),
    legendaries: rows.filter((r) => r.legendaries_defeated > 0).length,
    overtimeStarted: rows.filter((r) => r.overtime_started).length, overtimeCashed: rows.filter((r) => r.overtime_cashed).length,
    victories: rows.filter((r) => r.victory).length,
    // Truncation reasons carry the cap; they are one cause.
    causes: count((r) => (r.end_cause.startsWith('truncated') ? 'truncated' : r.end_cause)),
  };
}

/** A guardian or the legendary being woken: a `seals` decision answered with a set of seals (any, or none) rather than "not now". */
export interface Wake { zone: number; gameTime: number; level: number }

/**
 * Where in the run's lifecycle an episode ended, from its row and its wakes (docs/game-mechanics.md §1): which fight it
 * was lost in, or between which two steps of a zone (before the wake, after the guardian's fall) the player fainted.
 * An episode that ended in a victory or was truncated keeps its cause of end.
 */
export function lifecycleEnd(e: Pick<EpisodeRow, 'end_cause' | 'victory' | 'zone' | 'guardians_defeated' | 'legendaries_defeated'>, wakes: Wake[]): string {
  if (e.end_cause.startsWith('truncated')) return 'truncated';
  if (e.victory) return e.end_cause;
  const who = (zone: number): string => (zone >= 4 ? 'the legendary' : `the zone-${zone} guardian`);
  const last = wakes[wakes.length - 1];
  if (last && wakes.length > e.guardians_defeated + e.legendaries_defeated) return `fainted fighting ${who(last.zone)}`;
  if (!wakes.some((w) => w.zone === e.zone)) return `fainted in zone ${e.zone} before waking ${who(e.zone)}`;
  return `fainted in zone ${e.zone} after ${who(e.zone)} fell, before the portal`;
}

/** Preset name shown for a batch that never learnt its preset (no worker loaded the game). */
export const NO_PRESET = '(unknown: no episode ran)';

/**
 * Batches by the account preset they were played on (`batches.profile_preset`), in order of first appearance. Results
 * of different presets are not comparable: a report shows them apart or not at all (scripts/baseline-report.ts).
 */
export function groupByPreset<T extends { profile_preset?: unknown }>(batches: T[]): { preset: string; batches: T[] }[] {
  const out: { preset: string; batches: T[] }[] = [];
  for (const b of batches) {
    const preset = typeof b.profile_preset === 'string' && b.profile_preset ? b.profile_preset : NO_PRESET;
    const g = out.find((x) => x.preset === preset);
    if (g) g.batches.push(b); else out.push({ preset, batches: [b] });
  }
  return out;
}

const f = (x: number, digits = 0): string => (Number.isFinite(x) ? x.toFixed(digits) : '–');
export const statLine = (s: Stat, digits = 0): string => `mean ${f(s.mean, digits)}, median ${f(s.median, digits)}, min ${f(s.min, digits)}, max ${f(s.max, digits)}`;

/** A few readable lines for the end of a batch. */
export function summaryLines(s: Summary): string[] {
  const dist = (o: Record<string, number>) => Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, n]) => `${k}: ${n}`).join(', ');
  return [
    `KOs            ${statLine(s.kills)}`,
    `KOs + cashed   ${statLine(s.killsWithBonus)}`,
    `game time (s)  ${statLine(s.gameTime)}`,
    `level          ${statLine(s.level, 1)}`,
    `zone reached   ${dist(s.reachedZone)}`,
    `guardians      ${dist(s.beatGuardians)} (episodes by number beaten); legendary beaten in ${s.legendaries}; overtime started ${s.overtimeStarted}, cashed ${s.overtimeCashed}; victories ${s.victories}`,
    `causes of end  ${dist(s.causes)}`,
  ];
}
