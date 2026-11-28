import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// SLOW GROUP: each run boots the real game headless in a process of its own (src/watch/game.ts), as the watch page does.

const GAME = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'watch', 'game.ts');
const GAME_SECONDS = 12;
interface Frame { t: number }
interface Played { end: Record<string, unknown>; events: unknown[]; frames: { t: number; wall: number }[]; wallMs: number; pausedFrames: number }

/** One watched run of 12 game seconds. With `pauseAt`, the run is paused at that game second for `pauseMs` of wall time. */
function watch(speed: number, pause?: { at: number; ms: number }): Promise<Played> {
  return new Promise((ok, bad) => {
    const child = fork(GAME, [JSON.stringify({ seed: 5, species: 150, map: 'forest', tier: 2, maxTime: GAME_SECONDS, speed })], { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const out: Played = { end: {}, events: [], frames: [], wallMs: 0, pausedFrames: 0 };
    let started = 0, pausedSince = 0, paused = false, done = false, err = '';
    child.stderr?.on('data', (c: Buffer) => { err += c.toString('utf8'); });
    child.on('message', (m: { type: string; frame?: Frame; event?: unknown; summary?: Record<string, unknown> }) => {
      const now = performance.now();
      if (m.type === 'ready') started = now;
      else if (m.type === 'event') out.events.push(m.event);
      else if (m.type === 'frame' && m.frame) {
        out.frames.push({ t: m.frame.t, wall: now - started });
        // A frame already on its way when the pause was sent is not a frame played during the pause.
        if (paused && now - pausedSince > 250) out.pausedFrames++;
        if (pause && !pausedSince && m.frame.t >= pause.at) {
          pausedSince = now; paused = true;
          child.send({ type: 'pause', on: true });
          setTimeout(() => { paused = false; child.send({ type: 'pause', on: false }); }, pause.ms);
        }
      } else if (m.type === 'end') { out.end = m.summary ?? {}; out.wallMs = now - started; done = true; }
    });
    child.on('exit', (code) => (done ? ok(out) : bad(new Error(`the game process stopped before the run ended (exit ${code}): ${err.slice(-600)}`))));
    setTimeout(() => { child.kill(); bad(new Error('the watched run did not end in two minutes: it is stuck')); }, 120000).unref();
  });
}

test('a watched run keeps to its speed on the wall clock, holds while paused and goes on after, and plays what an unpaced run plays', async () => {
  const fast = await watch(64);
  const slow = await watch(2, { at: 3, ms: 1500 });

  // What was played does not depend on how fast it was shown, or on a pause in the middle.
  assert.equal(fast.end.time, GAME_SECONDS);
  assert.deepEqual(slow.end, fast.end);
  assert.deepEqual(slow.events, fast.events);
  assert.ok(fast.events.length > 0, 'the run reported what the player intended');

  // 12 game seconds at 2× are 6 s of wall time, and the pause adds 1.5 s. (Unpaced, the game computes them in about a second.)
  assert.ok(slow.wallMs >= 6800, `the paced run took ${Math.round(slow.wallMs)} ms`);
  assert.ok(slow.wallMs < 30000, `the paced run took ${Math.round(slow.wallMs)} ms`);
  assert.ok(fast.wallMs < slow.wallMs / 2, `unpaced ${Math.round(fast.wallMs)} ms against paced ${Math.round(slow.wallMs)} ms`);
  assert.equal(slow.pausedFrames, 0, 'no frame is played while the run is paused');
  const last = slow.frames[slow.frames.length - 1];
  assert.ok(last.t > 10, `after the pause the run went on to its end (last frame at ${last.t} s)`);
  // Half-way through its wall time the paced run is about half-way through the game, pause included: not at the end already.
  const mid = slow.frames.filter((f) => f.wall <= slow.wallMs / 2).pop()!;
  assert.ok(mid.t > 3 && mid.t < 9, `half-way through the wall time the run was at ${mid.t} s`);
});
