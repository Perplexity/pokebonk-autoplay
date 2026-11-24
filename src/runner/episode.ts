import type { Policy } from '../environment/policies.ts';
import type { ChoiceAction, ChoiceMask, Decision, GameEnvironment, GameMetadata, Observation, ResetOptions, StepResult } from '../environment/types.ts';
import type { Counters } from '../observations/state.ts';
import { real } from '../sim/clock.ts';
import type { BatchMetadata, DecisionRecord, EpisodeRecord, FinalBuild } from '../storage/records.ts';

/**
 * One episode, start to end, in the calling process: reset, let the policy act until the environment says the episode
 * is over, and summarise it as an `EpisodeRecord`. Nothing is caught here: an error leaves this function as it is and
 * the caller (the worker) reports it.
 */

export interface EpisodeSetup extends ResetOptions { seed: number }

export interface EpisodeProgress { seed: number; step: number; simStep: number; gameTime: number; kills: number; zone: number; phase: string }

/** The pick in words (`DecisionRecord.chosenId`). */
export function chosenId(d: Decision, a: ChoiceAction): string {
  if ('option' in a) return d.options[a.option]?.id ?? `option:${a.option}`;
  return a.target === undefined ? `extra:${a.extra}` : `extra:${a.extra}>${d.options[a.target]?.id ?? a.target}`;
}

export function finalBuild(obs: Observation): FinalBuild {
  const b = obs.state.build, p = obs.snapshot.player;
  const name = new Map(p.moves.map((m) => [m.key, m.name]));
  return {
    species: b.species, startSpecies: b.startSpecies, evoStage: b.evoStage, passive: b.passive, level: b.level, maxHp: p.maxHp, moveSlots: b.moveSlots,
    moves: b.moves.flatMap((m) => (m ? [{ slot: m.slot, key: m.key, id: m.id, name: name.get(m.key) ?? m.key, level: m.level, type: m.type, arch: m.arch, cls: m.cls, damageDone: m.damageDone, fusion: m.fusion, linked: m.linked }] : [])),
    vitaminSlots: b.vitaminSlots, vitamins: b.vitamins.map((v) => ({ ...v })), items: b.items.map((i) => ({ ...i })), relics: [...b.relics],
    refreshes: b.refreshes, skips: b.skips, banishes: b.banishes, revives: b.revives, stats: { ...p.stats },
  };
}

/** The columns a batch keeps of the environment's metadata. */
export function batchMetadata(md: GameMetadata): BatchMetadata {
  return {
    gameBuild: md.game.build, gameVersion: md.game.version, bundleSha256: md.game.bundleSha256, shimHash: md.shimHash,
    observationSchema: md.schema.observation, actionSchema: md.schema.action, decisionSchema: md.schema.decision, snapshotSchema: md.schema.snapshot,
    profilePreset: md.profile.preset, ranked: md.mode.ranked, full: JSON.parse(JSON.stringify(md)) as Record<string, unknown>,
  };
}

/**
 * Zone guardians and legendaries beaten, from the run's own counters: the game counts both in one figure
 * (`stats.bosses`, here `counters.guardiansDefeated`) and the legendaries again on their own.
 */
export function defeated(c: Pick<Counters, 'guardiansDefeated' | 'legendariesDefeated'>): { guardians: number; legendaries: number } {
  return { guardians: Math.max(0, c.guardiansDefeated - c.legendariesDefeated), legendaries: c.legendariesDefeated };
}

export async function runEpisode(
  env: GameEnvironment, policy: Policy, setup: EpisodeSetup,
  worker: { id: number; pid: number; episode: number } = { id: 0, pid: process.pid, episode: 1 },
  onProgress?: (p: EpisodeProgress) => void,
): Promise<EpisodeRecord> {
  const startedAt = new real.Date().toISOString();
  const t0 = real.performanceNow();
  let obs: Observation = await env.reset(setup);
  const resetSeconds = (real.performanceNow() - t0) / 1000;
  const first = obs.snapshot;
  policy.reset(setup.seed);

  const decisions: DecisionRecord[] = [];
  const t1 = real.performanceNow();
  let res: StepResult | null = null, overtimeStarted = false, lastReport = t1;
  for (;;) {
    const action = policy.act(obs);
    if (obs.phase === 'choice' && action.type === 'choice') {
      const d = obs.decision!, s = obs.snapshot;
      decisions.push({
        serial: d.serial, step: obs.step, gameTime: s.t, zone: s.stage, level: s.player.level, kind: d.kind, method: d.method,
        options: d.options as DecisionRecord['options'], context: d.context, mask: obs.mask as ChoiceMask, chosen: action, chosenId: chosenId(d, action),
      });
    }
    res = await env.step(action);
    obs = res.observation;
    if (res.info.overtime?.live) overtimeStarted = true;
    if (res.terminated || res.truncated) break;
    if (onProgress && (obs.step & 255) === 0) {
      const now = real.performanceNow();
      if (now - lastReport >= 5000) { lastReport = now; onProgress({ seed: setup.seed, step: obs.step, simStep: obs.simStep, gameTime: res.info.time, kills: res.info.kills, zone: res.info.zone, phase: obs.phase }); }
    }
  }

  const info = res.info, s = obs.snapshot;
  const record = info.end ? (JSON.parse(JSON.stringify(info.end.record)) as Record<string, unknown>) : null;
  const ot = info.overtime, recOt = record?.ot as { rounds?: unknown[]; cashed?: boolean } | undefined;
  const beaten = defeated(info.counters);
  return {
    seed: setup.seed, species: first.player.species, finalSpecies: s.player.species, map: s.biome, tier: s.tier, ranked: setup.ranked ?? true,
    terminated: res.terminated, truncated: res.truncated, endCause: info.endCause ?? 'unknown', endHow: info.end?.how ?? null, victory: info.end?.victory ?? false,
    gameTime: info.time, kills: info.kills,
    overtime: {
      started: overtimeStarted || !!recOt, bonus: ot?.bonus ?? 0,
      rounds: Array.isArray(recOt?.rounds) ? recOt.rounds.length : overtimeStarted ? ot?.round ?? 0 : 0, cashed: !!(ot?.cashed || recOt?.cashed),
    },
    level: info.level, zone: info.zone, guardiansDefeated: beaten.guardians, legendariesDefeated: beaten.legendaries, sealsKept: info.sealsKept,
    steps: obs.step, simSteps: obs.simStep, wallSeconds: (real.performanceNow() - t1) / 1000, resetSeconds,
    finalBuild: finalBuild(obs), counters: { ...info.counters }, record, blockedNetwork: [...info.blockedNetwork], decisions,
    worker: { ...worker, rssMB: Math.round(process.memoryUsage().rss / 1048576) },
    startedAt, finishedAt: new real.Date().toISOString(),
  };
}
