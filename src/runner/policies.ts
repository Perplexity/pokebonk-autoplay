import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLAYER_VERSION, playerPolicy } from '../player/policy.ts';
import type { HeadlessGameEnvironment } from '../environment/GameEnvironment.ts';
import { idlePolicy, randomPolicy } from '../environment/policies.ts';
import type { Policy } from '../environment/policies.ts';

/**
 * The policies the runner can play, by name. A policy is built inside the worker process that owns the environment:
 * the player takes the environment's read-only route planner, the others take nothing.
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface PolicySpec {
  /** Bumped by hand when the policy's behaviour is changed on purpose. */
  version: string;
  /** Source files whose content defines the policy's behaviour (folders: every .ts file in them). */
  sources: string[];
  make(env: HeadlessGameEnvironment, options: Record<string, unknown>): Policy;
}

const SPECS: Record<string, PolicySpec> = {
  random: { version: '1', sources: ['environment/policies.ts'], make: () => randomPolicy() },
  idle: { version: '1', sources: ['environment/policies.ts'], make: () => idlePolicy() },
  player: { version: PLAYER_VERSION, sources: ['player', 'player/brain'], make: (env, o) => playerPolicy({ planRoute: (x, z) => env.planRoute(x, z), build: () => env.getMetadata().game.build, plan: o.plan as Record<string, unknown> | undefined }) },
};

export const POLICY_NAMES = Object.keys(SPECS);

/** `options` are the policy's own settings (player: `{ plan }`, keys of the plan to replace; the others take none). */
export function makePolicy(name: string, env: HeadlessGameEnvironment, options: Record<string, unknown> = {}): Policy {
  const spec = SPECS[name];
  if (!spec) throw new Error(`unknown policy "${name}": use one of ${POLICY_NAMES.join(', ')}`);
  validatePolicyOptions(name, options);
  return spec.make(env, options);
}

/** Refuse settings the policy does not have (checked by the parent before any worker starts, and again by the worker). */
export function validatePolicyOptions(name: string, options: Record<string, unknown>): void {
  if (!SPECS[name]) throw new Error(`unknown policy "${name}": use one of ${POLICY_NAMES.join(', ')}`);
  const known = name === 'player' ? ['plan'] : [];
  for (const k of Object.keys(options)) {
    if (!known.includes(k)) throw new Error(`policy "${name}" has no option "${k}"${known.length ? ` (it has: ${known.join(', ')})` : ''}`);
    const v = options[k];
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`policy option "${k}" must be an object of settings`);
  }
}

/**
 * `<version>+<first 12 hex digits of the sha256 over the policy's source files>`: two batches with the same value were
 * played by the same policy code.
 */
export function policyVersion(name: string): string {
  const spec = SPECS[name];
  if (!spec) throw new Error(`unknown policy "${name}": use one of ${POLICY_NAMES.join(', ')}`);
  const hash = createHash('sha256');
  for (const rel of spec.sources) {
    const path = join(SRC, rel);
    const files = rel.endsWith('.ts') ? [path] : readdirSync(path).filter((f) => f.endsWith('.ts')).sort().map((f) => join(path, f));
    // Line endings are normalised so that a checkout with another setting hashes the same.
    for (const f of files) hash.update(f.slice(SRC.length).replace(/\\/g, '/')).update(readFileSync(f, 'utf8').replace(/\r\n/g, '\n'));
  }
  return `${spec.version}+${hash.digest('hex').slice(0, 12)}`;
}
