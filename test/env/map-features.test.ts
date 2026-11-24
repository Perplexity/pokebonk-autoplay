import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The map features against the REAL game (one headless game process per test, about 20 s each): Hypno and its lesson,
// a dojo trial, Incense and a rift with its relic. The check script (scripts/probes/map-features-check.ts) acts only
// through the environment; what is asserted here is what the game did, read from the observations it printed.
// The slot machine, the shop's sell list, Bill's machine and Max form need more game time to reach; they are covered
// by the stand-in tests (test/env/dialogs.test.ts) and by the recorded checks of docs/baseline.md §12.

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO, 'scripts', 'probes', 'map-features-check.ts');

function check(...args: string[]): string {
  const r = spawnSync(process.execPath, [SCRIPT, '--seed=1', '--species=150', ...args], { cwd: REPO, encoding: 'utf8', timeout: 240_000 });
  assert.equal(r.status, 0, `the check script failed:\n${r.stderr}\n${r.stdout.slice(-2000)}`);
  assert.match(r.stdout, /encoder unknown keys: \{\}; blocked network: 0/, 'every observation could be encoded, and nothing reached the network');
  return r.stdout;
}
/** The "before" and "after" build lines of the first answer whose headline matches. */
function effect(out: string, headline: RegExp): { before: string; after: string } {
  const lines = out.split('\n');
  const i = lines.findIndex((l) => headline.test(l));
  assert.ok(i >= 0, `no line matches ${headline} in:\n${out.slice(0, 3000)}`);
  return { before: lines[i + 1] ?? '', after: lines[i + 2] ?? '' };
}
const movesHeld = (line: string): number => (/moves \[([^\]]*)\]/.exec(line)?.[1] ?? '').split(' ').filter((m) => m && m !== '-').length;
const gold = (line: string): number => Number(/gold (\d+)/.exec(line)?.[1] ?? NaN);

test('Hypno and the dojo in the real game: a lesson is learned, a move forgotten for Pokédollars, a trial played', () => {
  const out = check('--to=40', '--tour=hypno,dojo', '--rift-after=99999');
  // The lesson: one of three offers is taken into the free slot, through the game's own offer function.
  const lesson = effect(out, /\] lesson: 3 options .*→ option 0/);
  assert.equal(movesHeld(lesson.after), movesHeld(lesson.before) + 1, 'a move was learned');
  assert.match(lesson.after, /next choice forget/, 'back at Hypno');
  // Forgetting it again pays what the game's price function says, and the slot is free.
  const forget = effect(out, /\] forget: 3 options \[move:0, move:1, lesson✗\] → option 1/);
  assert.equal(movesHeld(forget.after), movesHeld(forget.before) - 1);
  assert.ok(gold(forget.after) > gold(forget.before), 'Hypno paid for it');
  // With one move left nothing can be forgotten, and the lesson of the zone is used.
  assert.match(out, /\] forget: 2 options \[move:0✗, lesson✗\] → extra leave/);
  // The dojo: three trials offered, 21 blessings to fight for; the trial is then live on the map and ends.
  assert.match(out, /\] dojo: 3 options \[[a-z]+:1, [a-z]+:2, [a-z]+:3\] → option 0/);
  assert.match(out, /\] dojoPrize: 21 options \[damage, /);
  assert.match(out, /dojo trial: [a-z]+ belt 1, goal \d+, \d+ s/);
  assert.match(out, /dojo trial: ended after progress [\d.]+ of \d+; dojo points used 1/, 'the game marked the dojo used when the trial ended');
  assert.match(out, /lessons 1, .*forgets 1/, 'the run\'s own counters');
});

test('Incense in the real game: a rift is opened, entered, cleared, its relic taken, and left through its portal', () => {
  const out = check('--to=80', '--tour=', '--rift-after=0');
  assert.match(out, /incense 1 → 0; entrance \{"x":/, 'the key burned the Incense and the game opened an entrance');
  assert.match(out, /rift: entered; rifts cleared 0, relics none/);
  const left = /rift: left; rifts cleared (\d+), relics ([\w,-]+)/.exec(out);
  assert.ok(left, `the rift was not left:\n${out.slice(-1500)}`);
  assert.equal(left![1], '1');
  assert.notEqual(left![2], 'none', 'a relic is held: the relic dialog met the real game');
  assert.match(out, /dialogs seen: \{[^}]*"relic":1/);
  assert.match(out, /mapUse \d+ \(points \d+, shop 0, spins 0, lessons 0, rifts 1, forms 0\)/);
});
