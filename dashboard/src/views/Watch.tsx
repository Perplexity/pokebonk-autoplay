import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { ActionResult, EpisodeDetail, Meta, WatchEvent, WatchFrame, WatchState } from '../../shared/api.ts';
import { Notice } from '../components/Notice.tsx';
import { Empty, Screen } from '../components/Screen.tsx';
import { useWidth } from '../components/useWidth.ts';
import { act, useApi } from '../lib/api.ts';
import { gameClock, KIND_NAMES, num, shortHash } from '../lib/format.ts';

type Start = Extract<WatchEvent, { t: 'start' }>;
type End = Extract<WatchEvent, { t: 'end' }>;

const VIEW_METRES = 46;
const SPEEDS = [{ value: 1, label: 'Real time' }, { value: 4, label: '4 × real time' }, { value: 16, label: '16 × real time' }, { value: 0, label: 'As fast as it plays' }];
// Directions of the action's move index (0 = none), as (x, z) with north = −z.
const MOVES: [number, number][] = [[0, 0], [0, -1], [0.7, -0.7], [1, 0], [0.7, 0.7], [0, 1], [-0.7, 0.7], [-1, 0], [-0.7, -0.7]];
const POINT_NAMES: Record<string, string> = { boss: 'guardian altar', portal: 'portal', chest: 'ball', freechest: 'free ball', cursedchest: 'cursed ball', slots: 'slots', bill: "Bill's machine", hypno: 'Hypno', dojo: 'dojo', berry: 'berries', cage: 'cage', ditto: 'Ditto', snorlax: 'Snorlax', altar: 'altar', shop: 'shop' };

/** The moment from above: the player in the middle, north up, 46 metres to each side. Colours come from the page's theme. */
function draw(canvas: HTMLCanvasElement, f: WatchFrame, trail: [number, number][]): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const css = getComputedStyle(canvas);
  const c = (name: string) => css.getPropertyValue(name).trim();
  const dpr = window.devicePixelRatio || 1, w = canvas.width / dpr, h = canvas.height / dpr;
  const s = Math.min(w, h) / 2 / VIEW_METRES, cx = w / 2, cy = h / 2;
  const sx = (x: number) => cx + (x - f.x) * s, sy = (z: number) => cy + (z - f.z) * s;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = c('--screen'); ctx.fillRect(0, 0, w, h);

  // Range rings every 10 m.
  ctx.strokeStyle = c('--grid'); ctx.lineWidth = 1;
  for (let r = 10; r <= 60; r += 10) { ctx.beginPath(); ctx.arc(cx, cy, r * s, 0, Math.PI * 2); ctx.stroke(); }
  if (f.bounds) { ctx.strokeStyle = c('--axis'); ctx.lineWidth = 2; ctx.strokeRect(sx(-f.bounds), sy(-f.bounds), 2 * f.bounds * s, 2 * f.bounds * s); }

  // Things on the map, named.
  ctx.font = '11px "Archivo Variable", system-ui, sans-serif'; ctx.textAlign = 'center';
  for (const [kind, x, z, used] of f.points) {
    const px = sx(x), py = sy(z);
    if (px < -40 || px > w + 40 || py < -40 || py > h + 40) continue;
    ctx.globalAlpha = used ? 0.35 : 1;
    ctx.strokeStyle = c('--ink-2'); ctx.lineWidth = 1.5; ctx.strokeRect(px - 4, py - 4, 8, 8);
    ctx.fillStyle = c('--ink-2'); ctx.fillText(POINT_NAMES[kind.split(':')[0]] ?? kind.split(':')[0], px, py - 8);
    ctx.globalAlpha = 1;
  }

  ctx.strokeStyle = c('--critical'); ctx.lineWidth = 1.5;
  for (const [x, z, r] of f.hazards) { ctx.beginPath(); ctx.arc(sx(x), sy(z), Math.max(2, r * s), 0, Math.PI * 2); ctx.stroke(); }

  if (trail.length > 1) {
    ctx.strokeStyle = c('--action'); ctx.globalAlpha = 0.35; ctx.lineWidth = 2; ctx.beginPath();
    trail.forEach(([x, z], i) => (i ? ctx.lineTo(sx(x), sy(z)) : ctx.moveTo(sx(x), sy(z))));
    ctx.stroke(); ctx.globalAlpha = 1;
  }

  // Enemies: elites (flag 1), alphas (2) and totems (4096) are drawn larger with a ring.
  const enemy = c('--series-2'), ring = c('--screen');
  for (const [x, z, r, flags] of f.near) {
    const big = (flags & (1 | 2 | 4096)) !== 0;
    ctx.beginPath(); ctx.arc(sx(x), sy(z), Math.max(big ? 4 : 2.2, r * s), 0, Math.PI * 2);
    ctx.fillStyle = enemy; ctx.fill();
    if (big) { ctx.strokeStyle = c('--ink'); ctx.lineWidth = 1.5; ctx.stroke(); }
  }
  ctx.fillStyle = c('--critical');
  for (const [x, z] of f.shots) { ctx.beginPath(); ctx.arc(sx(x), sy(z), 2, 0, Math.PI * 2); ctx.fill(); }

  if (f.boss) {
    const bx = sx(f.boss.x), by = sy(f.boss.z);
    ctx.beginPath(); ctx.arc(bx, by, 9, 0, Math.PI * 2); ctx.fillStyle = c('--ink'); ctx.fill();
    ctx.strokeStyle = c('--critical'); ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(bx, by, 13, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * f.boss.hp) / Math.max(1, f.boss.maxHp)); ctx.stroke();
    ctx.fillStyle = c('--ink'); ctx.fillText(f.boss.name, bx, by - 20);
  }

  // The player, with the direction the model is holding.
  const move = f.action ? MOVES[f.action.move] ?? MOVES[0] : MOVES[0];
  if (move[0] || move[1]) { ctx.strokeStyle = c('--action'); ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + move[0] * 22, cy + move[1] * 22); ctx.stroke(); }
  ctx.beginPath(); ctx.arc(cx, cy, 7, 0, Math.PI * 2); ctx.fillStyle = c('--action'); ctx.fill(); ctx.strokeStyle = ring; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = c('--ink-3'); ctx.fillText('north', cx, 14);
}

export default function Watch({ query }: { arg: string | null; query: URLSearchParams }) {
  const meta = useApi<Meta>('/meta', 30_000);
  const state = useApi<WatchState>('/watch', 4_000);
  const episodeId = query.get('episode');
  // A training episode played again by a checkpoint of its run: the same seed, not the same episode.
  const likeId = query.get('like');
  const storedId = episodeId ?? likeId;
  const stored = useApi<EpisodeDetail>(storedId && /^\d+$/.test(storedId) ? `/episodes/${storedId}` : null, 300_000);
  const [model, setModel] = useState<string | null>(null);
  const [seed, setSeed] = useState(() => query.get('seed') ?? '5');
  const [speed, setSpeed] = useState(4);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [start, setStart] = useState<Start | null>(null);
  const [end, setEnd] = useState<End | null>(null);
  const [hud, setHud] = useState<WatchFrame | null>(null);
  const [dialog, setDialog] = useState<{ kind: string; options: string[]; chosen: string | null; time: number } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [wrap, width] = useWidth<HTMLDivElement>(900);
  const canvas = useRef<HTMLCanvasElement>(null);
  // Frames arrive up to thirty times a second: they are drawn straight to the canvas and never go through React.
  const frame = useRef<WatchFrame | null>(null), trail = useRef<[number, number][]>([]), hudAt = useRef(0);
  const height = Math.round(Math.min(600, Math.max(280, width * 0.6)));

  useEffect(() => {
    const source = new EventSource('/api/watch/stream');
    let raf = 0;
    const paint = () => { raf = 0; if (canvas.current && frame.current) draw(canvas.current, frame.current, trail.current); };
    source.onmessage = (m) => {
      const e = JSON.parse(m.data as string) as WatchEvent;
      if (e.t === 'start') { setStart(e); setEnd(null); setFailure(null); setDialog(null); trail.current = []; }
      else if (e.t === 'frame') {
        frame.current = e;
        const t = trail.current, lastPoint = t.at(-1);
        if (!lastPoint || Math.hypot(lastPoint[0] - e.x, lastPoint[1] - e.z) > 0.5) { t.push([e.x, e.z]); if (t.length > 240) t.shift(); }
        if (!raf) raf = requestAnimationFrame(paint);
        if (e.decision) setDialog({ kind: e.decision.kind, options: e.decision.options, chosen: e.action?.choice ?? null, time: e.time });
        const now = performance.now();
        if (now - hudAt.current > 200 || e.phase !== 'play') { hudAt.current = now; setHud(e); }
      } else if (e.t === 'end') setEnd(e);
      else if (e.t === 'error') setFailure(e.message);
    };
    return () => { source.close(); if (raf) cancelAnimationFrame(raf); };
  }, []);

  // The canvas is sized in device pixels; a resize repaints the newest frame.
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const dpr = window.devicePixelRatio || 1;
    el.width = Math.round(width * dpr); el.height = Math.round(height * dpr);
    if (frame.current) draw(el, frame.current, trail.current);
  }, [width, height]);

  const choices = meta.data?.modelChoices ?? [];
  const chosen = model ?? query.get('model') ?? choices[0]?.ref ?? '';
  const active = state.data?.active ?? false;
  const begin = async (e: FormEvent) => {
    e.preventDefault();
    const like = likeId && stored.data ? { stochastic: true, species: stored.data.species, map: stored.data.map, tier: stored.data.tier } : {};
    setResult(await act('watch/start', episodeId ? { episode: Number(episodeId), speed } : { model: chosen, seed: Number(seed), speed, ...like }));
  };
  const same = end && stored.data && episodeId ? end.kills === stored.data.kills && Math.abs(end.gameTime - stored.data.gameTime) < 0.01 : null;

  return (
    <div className="grid grid-cols-1 gap-5">
      <header>
        <h1 className="type-display">Watch</h1>
        <p className="mt-2 max-w-[78ch] text-base text-ink-2">
          A stored model plays one episode in a game process of its own, and this page draws it from above as it happens. Training itself cannot be looked into while it runs; to see what it has learned so far, watch its newest checkpoint.
        </p>
      </header>
      <Notice result={result} onDismiss={() => setResult(null)} />
      {likeId ? (
        <p className="max-w-[78ch] border-l-2 border-action pl-3">
          Episode {likeId}{stored.data ? ` (seed ${stored.data.seed}: ${num(stored.data.kills)} KOs in ${gameClock(stored.data.gameTime)}, it ended: ${stored.data.endCause})` : ''} was a training episode, and those are not recorded move by move.
          This is its seed played again by the model its run had then, with sampled actions: the same map and start, a different run.
        </p>
      ) : null}
      <form onSubmit={begin} className="flex flex-wrap items-end gap-3">
        {episodeId ? (
          <p className="max-w-[60ch] self-center">Episode {episodeId}{stored.data ? ` (seed ${stored.data.seed}, ${num(stored.data.kills)} KOs when it was stored)` : ''} is played again from its own model file and seed, which gives the same episode.</p>
        ) : (
          <>
            <label className="field min-w-0 flex-1 basis-64"><span>Model</span>
              <select value={chosen} onChange={(e) => setModel(e.target.value)}>
                {chosen && !choices.some((c) => c.ref === chosen) ? <option value={chosen}>The selected checkpoint</option> : null}
                {choices.length ? choices.map((c) => <option key={c.ref} value={c.ref}>{c.label} ({c.detail})</option>) : <option value="">No checkpoint yet</option>}
              </select></label>
            <label className="field w-32"><span>Seed</span><input type="number" min={0} required value={seed} onChange={(e) => setSeed(e.target.value)} /></label>
          </>
        )}
        <label className="field w-48"><span>Speed</span><select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>{SPEEDS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select></label>
        <button type="submit" className="btn btn-primary" disabled={!episodeId && !chosen}>{active ? 'Start over' : episodeId ? 'Watch it again' : 'Watch it play'}</button>
        {active ? <button type="button" className="btn" onClick={() => void act('watch/stop', {}).then(setResult)}>Stop</button> : null}
      </form>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section className="screen overflow-hidden p-0" aria-label="The game from above">
          <div ref={wrap} className="relative">
            <canvas ref={canvas} style={{ width: '100%', height }} className="block" role="img"
              aria-label={hud ? `Game time ${gameClock(hud.time)}, ${hud.kills} KOs, level ${hud.level}, ${hud.enemies} enemies alive` : 'Nothing is being played'} />
            {!start ? <div className="absolute inset-0 grid place-items-center p-6"><Empty>Nothing is being played. Choose a model and a seed above; the first frame arrives a few seconds after the game has loaded.</Empty></div> : null}
          </div>
          {hud ? (
            <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 border-t border-grid px-4 py-2">
              <span className="type-label">Hit points</span>
              <span className="flex items-center gap-2"><span className="h-2 flex-1 overflow-hidden rounded-full bg-screen-2"><span className="block h-2 bg-good" style={{ width: `${Math.max(0, Math.min(100, (hud.hp / Math.max(1, hud.maxHp)) * 100))}%` }} /></span>
                <span className="type-num w-24 text-right">{num(hud.hp)} of {num(hud.maxHp)}</span></span>
            </div>
          ) : null}
        </section>

        <div className="grid content-start gap-5">
          <Screen title={end ? 'It ended' : start ? 'Playing now' : 'The session'}>
            {start ? (
              <>
                <p className="mb-3 text-ink-2">{start.run ?? 'A model'} at {num(start.timesteps)} decisions (file {shortHash(start.sha256)}), seed {start.seed}, {start.deterministic ? 'most probable action' : 'sampled actions'}.</p>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                  <dt className="text-ink-2">Game time</dt><dd className="type-num text-right">{gameClock(end?.gameTime ?? hud?.time ?? 0)}</dd>
                  <dt className="text-ink-2">KOs</dt><dd className="type-num text-right">{num(end?.kills ?? hud?.kills ?? 0)}</dd>
                  <dt className="text-ink-2">Level</dt><dd className="type-num text-right">{end?.level ?? hud?.level ?? 1}</dd>
                  <dt className="text-ink-2">Zone</dt><dd className="type-num text-right">{end?.zone ?? hud?.zone ?? 1}</dd>
                  <dt className="text-ink-2">Enemies alive</dt><dd className="type-num text-right">{num(hud?.enemies ?? 0)}</dd>
                  <dt className="text-ink-2">Buttons</dt><dd className="text-right">{hud?.action?.buttons.length ? hud.action.buttons.join(', ') : 'none'}</dd>
                </dl>
                {end ? <p className="mt-3 font-semibold">Score {num(end.score)}. It ended: {end.endCause}.</p> : null}
                {same != null ? <p className="mt-1 text-ink-2">{same ? 'The same episode as the stored one: KOs and game time match.' : `Not the stored episode: it had ${num(stored.data!.kills)} KOs in ${gameClock(stored.data!.gameTime)}.`}</p> : null}
              </>
            ) : <p className="text-ink-2">Not started.</p>}
            {failure ? <p role="alert" className="mt-3 border-l-2 border-critical pl-3 text-critical-ink">{failure}</p> : null}
          </Screen>
          <Screen title="Last dialog">
            {dialog ? (
              <>
                <p className="mb-2"><span className="font-semibold">{KIND_NAMES[dialog.kind] ?? dialog.kind}</span> <span className="type-num text-ink-2">at {gameClock(dialog.time)}</span></p>
                <ul className="grid gap-1">{dialog.options.slice(0, 10).map((o, i) => (
                  <li key={i} className={`border-l-2 pl-2 ${o === dialog.chosen ? 'border-action font-semibold' : 'border-grid text-ink-2'}`}>{o}</li>
                ))}</ul>
                {dialog.chosen && !dialog.options.includes(dialog.chosen) ? <p className="mt-2">Answer: <span className="font-semibold">{dialog.chosen}</span></p> : null}
              </>
            ) : <p className="text-ink-2">The model has not been asked anything yet. Level-ups, items and shops appear here with what it chose.</p>}
          </Screen>
        </div>
      </div>
    </div>
  );
}
