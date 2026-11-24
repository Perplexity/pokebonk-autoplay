import type { Summary } from '../shared/api.ts';

/** The columns of `episodes` every summary is computed from. */
export interface EpisodeLite {
  id: number; batch_id: number; seed: number; species: number;
  kills: number; overtime_bonus: number; overtime_cashed: number; overtime_started: number;
  game_time: number; level: number; zone: number; victory: number; terminated: number; truncated: number;
  guardians_defeated: number; end_cause: string;
}

export const LITE_COLUMNS = 'id, batch_id, seed, species, kills, overtime_bonus, overtime_cashed, overtime_started, game_time, level, zone, victory, terminated, truncated, guardians_defeated, end_cause';

/** The run was ended by the rule against standing still (no KO and no movement for too long): it is invalid. */
export const endedIdle = (e: { end_cause?: string | null }): boolean => (e.end_cause ?? '').startsWith('idle');

/**
 * What the ranking counts: KOs, plus the overtime bonus when overtime was cashed. An invalid run scores 0, as in the
 * evaluator (python/pokebonk_rl/evaluate.py): in the game it would never have ended, so it would never have counted.
 */
export const scoreOf = (e: { kills: number; overtime_bonus: number; overtime_cashed: number; end_cause?: string | null }): number => (endedIdle(e) ? 0 : e.kills + (e.overtime_cashed ? e.overtime_bonus : 0));

export function mean(xs: number[]): number {
  if (!xs.length) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = xs.toSorted((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function summarize(rows: EpisodeLite[]): Summary | null {
  if (!rows.length) return null;
  const kos: number[] = [], scores: number[] = [], times: number[] = [], levels: number[] = [];
  const zones: Record<string, number> = {}, guardians: Record<string, number> = {};
  let completed = 0, died = 0, truncated = 0, invalid = 0, otStarted = 0, otCashed = 0, kosMax = 0, scoreMax = 0;
  for (const r of rows) {
    const s = scoreOf(r);
    kos.push(r.kills); scores.push(s); times.push(r.game_time); levels.push(r.level);
    if (r.kills > kosMax) kosMax = r.kills;
    if (s > scoreMax) scoreMax = s;
    zones[r.zone] = (zones[r.zone] ?? 0) + 1;
    guardians[r.guardians_defeated] = (guardians[r.guardians_defeated] ?? 0) + 1;
    if (r.victory) completed++; else if (r.terminated) died++;
    if (r.truncated) truncated++;
    if (endedIdle(r)) invalid++;
    if (r.overtime_started) otStarted++;
    if (r.overtime_cashed) otCashed++;
  }
  return {
    episodes: rows.length,
    kosMean: mean(kos), kosMedian: median(kos), kosMax,
    scoreMean: mean(scores), scoreMedian: median(scores), scoreMax,
    gameTimeMean: mean(times), gameTimeMedian: median(times), levelMean: mean(levels),
    completed, died, truncated, invalid, zones, guardians, overtimeStarted: otStarted, overtimeCashed: otCashed,
  };
}

/** `"1–30"`, `"900001–900050"`, `"3 seeds"`: a short description of a seed list. */
export function seedsLabel(seeds: number[] | undefined | null): string {
  if (!seeds || !seeds.length) return '';
  const s = seeds.toSorted((a, b) => a - b);
  const contiguous = s.every((v, i) => i === 0 || v === s[i - 1] + 1);
  if (s.length === 1) return String(s[0]);
  return contiguous ? `${s[0]}–${s[s.length - 1]}` : `${s.length} seeds`;
}
