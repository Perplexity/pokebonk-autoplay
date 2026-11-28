/**
 * Summary tables of stored batches (docs/storage.md): the numbers of a baseline.
 *
 *   node scripts/baseline-report.ts                       every batch in data/pokebonk.sqlite
 *   node scripts/baseline-report.ts --batches=3,4,5
 *   node scripts/baseline-report.ts --label=baseline      batches whose label contains the text
 *   node scripts/baseline-report.ts --preset=unlocked-v3  batches played on that account preset
 *   node scripts/baseline-report.ts --db=data/other.sqlite --markdown
 *
 * Options: --db=<file>  --batches=<ids>  --label=<text>  --preset=<name>  --all-presets
 *          --markdown (one table row per batch)  --decisions (dialog kinds met)
 *          --ends (where in the lifecycle the episodes ended, wake levels, what dealt the last hit)
 *
 * Results of different account presets are not comparable (player stats depend on the preset). When the selected
 * batches were played on more than one preset the report stops (exit code 2) and names them: choose one with --preset,
 * or pass --all-presets to get one section per preset. Every line and every table row names its preset.
 */
import { resolve } from 'node:path';
import { DEFAULT_DATABASE, EpisodeStore } from '../src/storage/database.ts';
import { groupByPreset, lifecycleEnd, summarize, summaryLines } from '../src/runner/report.ts';
import type { EpisodeRow, Stat, Wake } from '../src/runner/report.ts';

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) { const m = /^--([\w-]+)(?:=(.*))?$/.exec(a); if (m) args.set(m[1], m[2] ?? 'true'); }
const say = (s = '') => process.stdout.write(s + '\n');
const store = EpisodeStore.open(args.has('db') ? resolve(args.get('db')!) : DEFAULT_DATABASE);
type Row = Record<string, any>;
let batches = store.db.prepare('SELECT * FROM batches ORDER BY id').all() as Row[];
if (args.has('batches')) { const ids = new Set(args.get('batches')!.split(',').map(Number)); batches = batches.filter((b) => ids.has(b.id)); }
if (args.has('label')) batches = batches.filter((b) => String(b.label ?? '').includes(args.get('label')!));
if (args.has('preset')) batches = batches.filter((b) => b.profile_preset === args.get('preset'));

const groups = groupByPreset(batches);
if (groups.length > 1 && !args.has('all-presets')) {
  process.stderr.write(`baseline-report: the selected batches were played on ${groups.length} account presets (${groups.map((g) => `${g.preset}: batches ${g.batches.map((b) => b.id).join(',')}`).join('; ')}).\nTheir results are not comparable. Choose one with --preset=<name>, or pass --all-presets for one section per preset.\n`);
  store.close();
  process.exit(2);
}

const md = args.has('markdown');
const cell = (s: Stat, d = 0) => (s.n ? `${s.mean.toFixed(d)} / ${s.median.toFixed(d)} / ${s.min.toFixed(d)} / ${s.max.toFixed(d)}` : '–');
const dist = (o: Record<string, number>) => Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, n]) => `${k}: ${n}`).join(', ');
for (const g of groups) {
  if (groups.length > 1 || md) say(`${md ? '\n**' : '=== '}Account preset ${g.preset}${md ? '**\n' : ' ==='}`);
  if (md) {
    say('| Batch | Policy | Setup | Preset | Episodes | KOs mean / median / min / max | KOs + cashed overtime bonus | Game time (s) | Level | Zone reached | Guardians beaten | Legendary beaten / overtime started / cashed | Causes of end | Errors |');
    say('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  }
  for (const b of g.batches) {
    const rows = store.episodes(b.id) as unknown as EpisodeRow[];
    const cfg = JSON.parse(b.config_json) as Row;
    const s = summarize(rows);
    // The seeds the batch was given; a batch written by other code may not list them: then the seeds it has.
    const list: number[] = Array.isArray(cfg.seeds) && cfg.seeds.length ? cfg.seeds : rows.map((r) => r.seed);
    const seeds = list.length ? `${list[0]}–${list[list.length - 1]}` : '?';
    const setup = `#${cfg.species ?? '?'} ${cfg.map ?? '?'} t${cfg.tier ?? '?'}${cfg.maxGameTime ? ` ≤${cfg.maxGameTime}s` : ''}${cfg.policyOptions && Object.keys(cfg.policyOptions).length ? ' +options' : ''}`;
    if (md) say(`| ${b.id}${b.label ? ` ${b.label}` : ''} | ${b.policy_name} ${b.policy_version} | ${setup}, seeds ${seeds} | ${g.preset} | ${s.episodes}/${b.episodes_planned} | ${cell(s.kills)} | ${cell(s.killsWithBonus)} | ${cell(s.gameTime)} | ${cell(s.level, 1)} | ${dist(s.reachedZone)} | ${dist(s.beatGuardians)} | ${s.legendaries} / ${s.overtimeStarted} / ${s.overtimeCashed} | ${dist(s.causes)} | ${b.error_count} |`);
    else {
      say(`batch ${b.id}${b.label ? ` "${b.label}"` : ''}: ${b.policy_name} ${b.policy_version}, ${setup}, seeds ${seeds}, ${cfg.workers ?? '?'} worker(s), preset ${g.preset}, build ${b.game_build ?? '?'}, ${b.status}, ${s.episodes}/${b.episodes_planned} episodes, ${b.error_count} error(s), ${Number(b.wall_seconds ?? 0).toFixed(0)} s wall`);
      if (rows.length) for (const l of summaryLines(s)) say(`  ${l}`);
      for (const e of store.errors(b.id)) say(`  ERROR [${e.kind}] seed ${e.seed ?? '?'}: ${e.message}`);
    }
    if (args.has('decisions')) {
      const kinds = store.db.prepare('SELECT d.kind, COUNT(*) AS n, COUNT(DISTINCT d.episode_id) AS eps FROM decisions d JOIN episodes e ON e.id = d.episode_id WHERE e.batch_id = ? GROUP BY d.kind ORDER BY n DESC').all(b.id) as Row[];
      say(`  ${md ? '' : 'dialogs        '}${kinds.map((k) => `${k.kind} ×${k.n} (${k.eps} ep.)`).join(', ')}`);
    }
    if (args.has('ends') && rows.length) {
      // Where in the lifecycle the episodes ended, at which level each guardian was woken, and what the game says dealt the last hit.
      const wakesOf = store.db.prepare("SELECT zone, game_time AS gameTime, level FROM decisions WHERE episode_id = ? AND kind = 'seals' AND chosen_id NOT LIKE 'extra:%' ORDER BY serial");
      const ends: Record<string, number> = {}, by: Record<string, number> = {}, levels: Record<number, number[]> = {}, lost: number[] = [];
      for (const r of rows as unknown as Row[]) {
        const wakes = wakesOf.all(r.id) as unknown as Wake[];
        const end = lifecycleEnd(r as never, wakes);
        ends[end] = (ends[end] ?? 0) + 1;
        for (const w of wakes) (levels[w.zone] ??= []).push(w.level);
        if (end.startsWith('fainted fighting')) lost.push(r.game_time - wakes[wakes.length - 1].gameTime);
        const rec = r.record_json ? (JSON.parse(r.record_json) as Row) : null;
        if (rec && !r.victory) { const k = `${rec.end?.by ?? '?'}${rec.end?.swarm ? ' in the final swarm' : ''}`; by[k] = (by[k] ?? 0) + 1; }
      }
      const mean = (a: number[]) => (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1);
      const lines = [
        `ended          ${Object.entries(ends).sort((a, b2) => b2[1] - a[1]).map(([k, n]) => `${n} × ${k}`).join('; ')}`,
        `woken at       ${Object.entries(levels).map(([z, a]) => `${Number(z) >= 4 ? 'legendary' : `zone ${z}`}: ${a.length} wakes, mean level ${mean(a)}`).join('; ') || 'nothing was woken'}${lost.length ? `; lost fights lasted ${mean(lost)} s on average` : ''}`,
        `last hit by    ${Object.entries(by).sort((a, b2) => b2[1] - a[1]).map(([k, n]) => `${k}: ${n}`).join(', ') || '–'}`,
      ];
      for (const l of lines) say(`  ${l}`);
    }
  }
}
store.close();
