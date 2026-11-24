import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.ts';
import type { SandboxBrowser } from '../cdp/browser.ts';
import { logger } from '../logger.ts';
import type { SandboxHost } from '../sandbox/server.ts';
import { buildFor, type Build } from './brain/builds.ts';
import { pickGeneric, pickLevelUp } from './brain/choices.ts';
import { decide, newMemory, type Action, type Memory } from './brain/movement.ts';
import { resolveTuning, type Tuning } from './brain/tuning.ts';
import { Executor } from './executor.ts';
import { Perception } from './perception.ts';
import type { Snapshot, UiModal, UiOption, UiState } from './snapshot.ts';

const log = logger('session');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Keys of the game's default bindings. */
const KEY = { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', jump: 'Space', dash: 'ShiftLeft', interact: 'KeyE', ult: 'KeyR' };

/** World direction → movement keys, given the camera yaw (the game moves "up" along (-sin yaw, -cos yaw)). */
export function keysFor(move: { x: number; z: number } | null, camYaw: number): string[] {
  if (!move) return [];
  const fx = -Math.sin(camYaw), fz = -Math.cos(camYaw), rx = Math.cos(camYaw), rz = -Math.sin(camYaw);
  const f = move.x * fx + move.z * fz, r = move.x * rx + move.z * rz;
  const keys: string[] = [];
  if (f > 0.38) keys.push(KEY.up); else if (f < -0.38) keys.push(KEY.down);
  if (r > 0.38) keys.push(KEY.right); else if (r < -0.38) keys.push(KEY.left);
  return keys;
}

/**
 * Runs the whole thing: brings the sandbox page from boot to a run (language, mock login, starter, menus, select),
 * plays it with the brain, handles the dialogs, sees the result screen through, and starts the next run. Also the
 * safety net: stuck-in-menu detection and recovery, and reload-and-resume when the page dies mid-run.
 */
export class Session {
  private cfg: Config;
  private host: SandboxHost;
  private browser: SandboxBrowser;
  private per: Perception;
  private ex: Executor;
  private tuning: Tuning;
  private mem: Memory = newMemory();
  private build: Build = buildFor(0);
  private names = new Map<number, string>();

  private runsStarted = 0;
  private runsFinished = 0;
  private lastSig = '';
  private lastChange = Date.now();
  private lastActAt = 0;
  private recoveries = 0;
  private lastIntent = '';
  private lastStatusLog = 0;
  private lastIntentLog = 0;
  private lastClickSig = '';
  private sameClicks = 0;
  private prevHp = 0;
  private speedNow = 1;
  private nav: Snapshot['nav'] = null;
  private navAt = 0;
  private navGoal: { x: number; z: number } | null = null;
  private mine = new Set<string>();
  private trace: { snap: Snapshot; action: Action }[] = [];
  private traces = 0;
  private lastSnap: Snapshot | null = null;
  private lastRunProgress = Date.now();
  private lastRunT = -1;
  private banked = false;
  private decisions: string[] = [];
  private modalSeen = new Set<string>();
  private stop = false;
  private recordAt = 0;

  constructor(cfg: Config, host: SandboxHost, browser: SandboxBrowser) {
    this.cfg = cfg; this.host = host; this.browser = browser;
    this.per = new Perception(browser.cdp);
    this.ex = new Executor(browser.cdp, cfg.dryRun);
    this.tuning = resolveTuning(cfg.bot.tuning);
    try {
      const list = JSON.parse(readFileSync(join(cfg.mirrorDir, 'data', 'pokemon.json'), 'utf8')) as { id: number; name: string }[];
      for (const p of list) this.names.set(p.id, p.name);
    } catch { /* names only help the select screen */ }
    host.api.onEvent = (ev) => {
      if (ev.type === 'run-start') { this.runsStarted++; if (ev.run) this.mine.add(ev.run.id); this.onRunStart(ev.run?.request ?? {}); }
      if (ev.type === 'run-finish') {
        // A run left open by an earlier session is closed by the game itself on the next boot ("rescued"): it goes
        // to the journal like any other, but it is not one of this session's runs.
        const own = !!ev.run && this.mine.has(ev.run.id);
        if (own) this.runsFinished++;
        this.note(`${own ? 'run finished' : 'earlier run closed'}: ${ev.entry?.how}, ${Math.round(ev.entry?.time ?? 0)}s, level ${ev.entry?.level}, ${ev.entry?.kills} KOs`);
      }
    };
    browser.cdp.on('Page.frameNavigated', (p) => { if (!p.frame.parentId) void this.per.reset(); });
  }

  private onRunStart(req: Record<string, unknown>) {
    this.mem = newMemory();
    this.trace = []; this.traces = 0; this.prevHp = 0; this.nav = null; this.navGoal = null;
    this.banked = false;
    this.lastRunT = -1;
    this.lastRunProgress = Date.now();
    void this.per.reset();
    const species = Number(req.species) || 0;
    this.build = buildFor(species, 0, (this.cfg.bot as any).builds ?? {});
    this.note(`run ${this.runsStarted} started: ${this.names.get(species) ?? '#' + species}, ${req.biome}, ${req.mode}, build "${this.build.name}"`);
  }

  private note(msg: string) {
    log.info(msg);
    this.decisions.push(`${new Date().toISOString().slice(11, 19)} ${msg}`);
    if (this.decisions.length > 40) this.decisions.shift();
  }

  private publish(phase: string, note?: string) {
    const s = this.lastSnap;
    this.host.botStatus = {
      phase, note, updated: Date.now(), decisions: this.decisions.slice(-14),
      run: s ? {
        time: s.t, stage: s.stage, level: s.player.level, hp: Math.round(s.player.hp), maxHp: Math.round(s.player.maxHp), kills: s.kills,
        enemies: s.enemies.count, boss: s.boss?.name ?? null, ult: s.ult.charge, intent: this.lastIntent, mode: s.mode, biome: s.biome,
        runsStarted: this.runsStarted, runsFinished: this.runsFinished,
      } : { runsStarted: this.runsStarted, runsFinished: this.runsFinished },
    };
  }

  // ---------------- input helpers ----------------

  /** Click an on-screen option, at most once every `gap` ms so a slow dialog is not clicked twice. */
  private async click(o: UiOption, why: string, gap = 450): Promise<boolean> {
    if (Date.now() - this.lastActAt < gap) return false;
    this.lastActAt = Date.now();
    log.debug(`click "${o.text.slice(0, 40)}" (${why})`);
    await this.ex.click(o.x, o.y);
    return true;
  }
  private async press(code: string, why: string, gap = 450): Promise<boolean> {
    if (Date.now() - this.lastActAt < gap) return false;
    this.lastActAt = Date.now();
    log.debug(`key ${code} (${why})`);
    await this.ex.tap(code);
    return true;
  }
  private btn(ui: UiState, re: RegExp, cls?: RegExp): UiOption | undefined {
    return ui.buttons.find((b) => re.test(b.text) && (!cls || cls.test(b.cls)));
  }

  // ---------------- the loop ----------------

  async run(): Promise<void> {
    await this.browser.navigate(`/?lang=${this.cfg.browser.lang}`);
    this.note(`${this.cfg.dryRun ? 'DRY RUN: deciding only, no input is sent. ' : ''}sandbox page opened`);
    // At N× game speed the bot ticks N× as often, so it sees and decides as often per second of game time.
    const period = 1000 / (Math.max(2, this.cfg.bot.tickHz) * this.cfg.bot.speed);
    if (this.cfg.bot.speed > 1) this.note(`game speed ×${this.cfg.bot.speed} requested (the sandbox sets the game's time scale; see README)`);
    while (!this.stop && !this.browser.cdp.closed) {
      const t0 = Date.now();
      try { await this.tick(); } catch (e) {
        const msg = (e as Error).message;
        if (/closed/.test(msg)) break;
        log.warn(`tick: ${msg}`);
      }
      if (this.cfg.bot.maxRuns > 0 && this.runsFinished >= this.cfg.bot.maxRuns) { this.note(`${this.runsFinished} runs done: stopping`); break; }
      const left = period - (Date.now() - t0);
      if (left > 0) await sleep(left);
    }
    await this.ex.releaseAll().catch(() => {});
  }

  private async tick() {
    const ui = await this.per.ui();
    if (!ui.href.startsWith(`http://localhost:${this.cfg.port}/`)) {
      // The bot acts on the sandbox origin and nowhere else.
      await this.ex.releaseAll();
      log.warn(`page left the sandbox (${ui.href}): going back`);
      await this.browser.navigate(`/?lang=${this.cfg.browser.lang}`);
      await sleep(1500);
      return;
    }
    // Twice a second, while the goal is far, the snapshot also carries a route to it (planned in the page over the
    // game's height map). Between plans the last route is reused.
    const wantRoute = this.navGoal && Date.now() - this.navAt > 450 ? this.navGoal : null;
    const snap = ui.screen === 'run' ? await this.per.snapshot(wantRoute) : null;
    if (snap) {
      if (wantRoute) { this.nav = snap.nav ?? null; this.navAt = Date.now(); }
      else if (this.nav && Date.now() - this.navAt < 1500) snap.nav = this.nav;
    }
    this.lastSnap = snap;
    this.watchdog(ui, snap);

    if (ui.screen !== 'run') {
      await this.ex.releaseAll();
      await this.menus(ui);
      this.publish(ui.screen);
      return;
    }
    await this.inRun(ui, snap);
  }

  // ---------------- menus ----------------

  private async menus(ui: UiState) {
    const m = ui.modal;
    switch (ui.screen) {
      case 'loading': return;
      case 'offline':
      case 'blocked': {
        const b = this.btn(ui, /retry|reload/i);
        if (b) await this.click(b, 'retry', 3000);
        return;
      }
      case 'auth': {
        const b = this.btn(ui, /guest/i, /big/) ?? this.btn(ui, /guest/i);
        if (b && /play/i.test(b.text)) await this.click(b, 'mock login', 2500);
        else if (b) await this.click(b, 'guest tab', 800);
        return;
      }
      case 'starter': {
        if (m && m.kind === 'confirm') { const yes = m.actions.find((a) => /yes|choose (?!again)/i.test(a.text) && !/again/i.test(a.text)); if (yes) await this.click(yes, 'confirm starter', 1200); return; }
        const cards = (await this.per.ui()).buttons.filter((b) => /sp-card/.test(b.cls));
        const want = cards.find((c) => this.cfg.bot.species.some((id) => c.text.includes('#' + String(id).padStart(3, '0'))));
        const on = cards.find((c) => /\bon\b/.test(c.cls));
        if (want && want !== on) { await this.click(want, 'starter card', 700); return; }
        await this.press('Enter', 'choose starter', 1200);
        return;
      }
      case 'menu':
      case 'playmenu': {
        if (m) { await this.dismiss(m); return; }
        if (ui.screen === 'playmenu') {
          const pill = ui.buttons.find((b) => /mh-pill/.test(b.cls) && !b.disabled);
          if (pill) await this.click(pill, 'classic', 900);
          return;
        }
        const play = ui.buttons.find((b) => /mm-item/.test(b.cls) && /\bplay\b/.test(b.cls));
        if (play) await this.click(play, 'play', 900);
        return;
      }
      case 'select': {
        if (m) { await this.dismiss(m); return; }
        const tiles = ui.buttons.filter((b) => /ls-tile/.test(b.cls) && !b.disabled);
        const wantName = this.cfg.bot.species.map((id) => this.names.get(id)).find((n) => n && tiles.some((t) => t.text === n));
        const on = tiles.find((t) => /\bon\b/.test(t.cls));
        const want = wantName ? tiles.find((t) => t.text === wantName) : undefined;
        if (want && on !== want && want.y > 60 && want.y < this.cfg.browser.height - 60) { await this.click(want, `select ${wantName}`, 700); return; }
        await this.press('Enter', 'i choose you', 1200);
        return;
      }
      case 'map': {
        if (m) { await this.dismiss(m); return; }
        await this.press('Enter', 'start', 1500);
        return;
      }
      default: {
        if (m) { await this.dismiss(m); return; }
        // A screen the bot does not use: back out.
        await this.press('Escape', `leave ${ui.screen}`, 1500);
      }
    }
  }

  /** Close a tour, an intro, a notice or a confirmation that is in the way. */
  private async dismiss(m: UiModal) {
    const skip = m.actions.find((a) => /skip|close|got it|understood|ok\b|later|no thanks|continue/i.test(a.text) && !a.disabled);
    if (skip) { await this.click(skip, `dismiss ${m.kind}`, 700); return; }
    const pick = pickGeneric(m, this.lastSnap, this.build, this.tuning);
    if (pick && pick.option < 0) { await this.click(m.actions[pick.action], `dismiss ${m.kind}`, 700); return; }
    await this.press('Escape', `dismiss ${m.kind}`, 900);
  }

  // ---------------- in a run ----------------

  private logModal(m: UiModal) {
    const sig = m.kind + '|' + m.cls + '|' + m.options.length;
    if (this.modalSeen.has(sig)) return;
    this.modalSeen.add(sig);
    try { appendFileSync(join(this.cfg.dataDir, 'logs', 'modals.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...m }) + '\n'); } catch { /* best effort */ }
  }

  private async inRun(ui: UiState, snap: Snapshot | null) {
    const m = ui.modal;

    // "Preparing the zone… Start now": sprites still arriving, the run can start without them.
    const startNow = this.btn(ui, /^start now$/i);
    if (startNow) { await this.ex.releaseAll(); await this.click(startNow, 'start now', 1500); return; }

    if (m) {
      await this.ex.releaseAll();
      this.logModal(m);
      await this.dialog(m, snap);
      this.publish('dialog', m.kind);
      return;
    }
    if (!snap) { this.publish('run', 'locating the run'); return; }

    // Bank and quit after the configured run length.
    if (this.cfg.bot.bankAfterSec > 0 && snap.state === 'play' && snap.t >= this.cfg.bot.bankAfterSec && !this.banked) {
      this.banked = true;
      this.note(`bank and quit at ${Math.round(snap.t)}s`);
      await this.ex.releaseAll();
      await this.press('Escape', 'pause to bank', 0);
      return;
    }

    if (snap.state !== 'play') { await this.ex.releaseAll(); this.publish('run', snap.state); return; }

    if (this.cfg.bot.speed > 1 && !this.cfg.dryRun) {
      // Never a bigger simulation step than the game takes on its own at 20 fps: speed is limited by frame rate.
      const want = Math.max(1, Math.min(this.cfg.bot.speed, Math.floor((snap.fps / 20) * 10) / 10));
      if (Math.abs(snap.timeScale - want) > 0.05 && snap.timeScale >= 1) await this.per.setTimeScale(want);
      if (want !== this.speedNow) { this.speedNow = want; this.note(`game speed ×${want} (${snap.fps} fps)`); }
    }

    const { action, mem, sit, goal } = decide(snap, this.mem, this.tuning);
    this.mem = mem;
    this.navGoal = goal?.far ? { x: goal.x, z: goal.z } : null;
    // Every real hit is logged with what was around: this is how the heuristics get tuned.
    const lost = this.prevHp - snap.player.hp;
    if (this.prevHp > 0 && lost > snap.player.maxHp * 0.06) {
      const near = snap.enemies.list.slice(0, 3).map((e) => `${(Math.hypot(e[1] - snap.player.x, e[2] - snap.player.z) - e[7]).toFixed(1)}m/f${e[10]}/d${Math.round(e[8])}`).join(' ');
      log.info(`hit -${Math.round(lost)} hp at ${Math.round(snap.t)}s doing "${this.lastIntent}": nearest ${near || 'none'} · shots ${snap.shots.length} hazards ${snap.hazards.length} · n3 ${sit.n3} n8 ${sit.n8} · speed ${snap.player.speed} stuck ${mem.stuck.toFixed(1)}`);
    }
    this.prevHp = snap.player.hp;
    // Hit traces: the last second and a half of what the bot saw and did, written out when it gets hurt.
    this.trace.push({ snap: { ...snap, points: [], enemies: { count: snap.enemies.count, list: snap.enemies.list.slice(0, 40) } }, action });
    if (this.trace.length > 15) this.trace.shift();
    if (lost > snap.player.maxHp * 0.06 && this.cfg.bot.traceHits && this.traces < 60) {
      this.traces++;
      const dir = join(this.cfg.dataDir, 'hits');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `run${this.runsStarted}-t${String(Math.round(snap.t)).padStart(4, '0')}-${this.traces}.json`), JSON.stringify({ lost, frames: this.trace }));
    }
    await this.act(action, snap);

    if (action.intent !== this.lastIntent) {
      // The big switches are always logged; the small ones (farm ↔ xp ↔ loot) at most every few seconds.
      const big = /boss|wake|portal|capture|flee|heal/.test(action.intent) || /boss|wake|portal|capture|flee|heal/.test(this.lastIntent);
      this.lastIntent = action.intent;
      if (big || Date.now() - this.lastIntentLog > 4000) { this.lastIntentLog = Date.now(); this.note(`[${Math.round(snap.t)}s lv${snap.player.level}] ${action.intent}: ${action.note}`); }
    }
    if (action.ult) this.note(`[${Math.round(snap.t)}s] ultimate: ${action.note}`);
    if (Date.now() - this.lastStatusLog > 10_000) {
      this.lastStatusLog = Date.now();
      log.info(`t=${Math.round(snap.t)}s zone ${snap.stage} lv ${snap.player.level} hp ${Math.round(snap.player.hp)}/${Math.round(snap.player.maxHp)} KOs ${snap.kills} enemies ${snap.enemies.count} pressure ${sit.pressure.toFixed(1)} ult ${(snap.ult.charge * 100) | 0}% · ${action.intent}: ${action.note}`);
    }
    this.record(snap, ui);
    this.publish('run', action.intent);
  }

  private async act(a: Action, s: Snapshot) {
    await this.ex.hold(keysFor(a.move, s.camYaw));
    if (a.dash) await this.ex.tap(KEY.dash, 30);
    if (a.jump) await this.ex.tap(KEY.jump, 30);
    if (a.ult) await this.ex.tap(KEY.ult, 40);
    if (a.interact) await this.ex.tap(KEY.interact, 40);
  }

  private async dialog(m: UiModal, snap: Snapshot | null) {
    if (m.kind === 'end') {
      // Result screen: the run is in the journal once the mock has answered; then go again.
      const again = m.actions.find((a) => /^again$/i.test(a.text)), menu = m.actions.find((a) => /^menu$/i.test(a.text));
      if (this.cfg.bot.maxRuns > 0 && this.runsFinished >= this.cfg.bot.maxRuns) return;
      if (this.runsFinished < this.runsStarted && Date.now() - this.lastChange < 12_000) return; // result still on its way to the journal
      const b = again ?? menu;
      if (b && await this.click(b, 'next run', 2500)) this.note(`result screen: ${b.text.toLowerCase()}`);
      return;
    }
    if (m.kind === 'pause') {
      if (this.banked) {
        const give = m.actions.find((a) => /give up/i.test(a.text));
        if (give) await this.click(give, 'bank: end the run', 1200);
        return;
      }
      const cont = m.actions.find((a) => /^continue|resume/i.test(a.text));
      if (cont) await this.click(cont, 'resume', 900); else await this.press('Escape', 'resume', 900);
      return;
    }
    if (m.kind === 'confirm' && this.banked) {
      const yes = m.actions.find((a) => /give up|yes|end|confirm/i.test(a.text));
      if (yes) { await this.click(yes, 'bank: confirm', 1200); return; }
    }
    // A dialog needs a beat to finish animating in before its buttons take clicks.
    if (Date.now() - this.lastChange < 350) return;
    const pick = m.kind === 'levelup' ? pickLevelUp(m, snap, this.build, this.tuning) : pickGeneric(m, snap, this.build, this.tuning);
    if (!pick) { await this.press('Escape', `close ${m.kind}`, 1500); return; }
    let target = pick.option >= 0 ? m.options[pick.option] : m.actions[pick.action];
    if (!target) return;
    // The same click on the same dialog several times means the click selects without confirming (or does nothing):
    // go for the dialog's own confirm/close button instead, and after that Escape.
    // How many times this same click has actually been sent (clicks, not ticks: the bot ticks many times between
    // two clicks). A click that keeps having no effect is replaced by something else.
    const sig = `${m.title}|${target.text.slice(0, 40)}`;
    const repeats = sig === this.lastClickSig ? this.sameClicks : 0;
    if (repeats >= 2 && pick.option >= 0 && pick.option < 9 && m.kind === 'levelup') {
      // Offer cards answer to their number key ([1] [2] [3]).
      if (await this.press(`Digit${pick.option + 1}`, `card ${pick.option + 1} by key`, 700)) { this.sameClicks = repeats + 1; this.lastClickSig = sig; }
      return;
    }
    if (repeats >= 3) {
      const alt = m.actions.find((x) => !x.disabled && x !== target && /confirm|accept|continue|ok\b|done|enter|choose|awaken|start|close|not now|skip/i.test(x.text) && !/give up|restart|save and quit|view my team/i.test(x.text));
      if (repeats >= 7 || !alt) {
        if (await this.press('Escape', `close ${m.kind} (clicks had no effect)`, 1500)) { this.sameClicks = repeats + 1; this.lastClickSig = sig; }
        return;
      }
      target = alt;
    }
    if (await this.click(target, pick.reason, 600)) {
      this.sameClicks = repeats + 1; this.lastClickSig = sig;
      const label = target.name ? `${target.name}${target.sub ? ` (${target.sub})` : ''}` : target.text.slice(0, 44);
      this.note(`${m.kind}${snap ? ` [lv${snap.player.level}]` : ''}: "${label}" — ${pick.reason}`);
    }
  }

  /** Optional: keep snapshots on disk (bot.recordEverySec in config.json) to build test fixtures from real play. */
  private record(snap: Snapshot, ui: UiState) {
    const every = Number((this.cfg.bot as any).recordEverySec) || 0;
    if (!every || Date.now() - this.recordAt < every * 1000) return;
    this.recordAt = Date.now();
    const dir = join(this.cfg.dataDir, 'snapshots');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `run${this.runsStarted}-t${String(Math.round(snap.t)).padStart(4, '0')}.json`), JSON.stringify({ snap, ui: { ...ui, buttons: [] } }));
  }

  // ---------------- stuck detection and recovery ----------------

  private watchdog(ui: UiState, snap: Snapshot | null) {
    // "Something changed": the screen, the dialog, or the run clock moved.
    const sig = `${ui.screen}|${ui.modal?.kind ?? ''}|${ui.modal?.title ?? ''}|${ui.modal?.options.length ?? 0}|${snap ? snap.state : ''}`;
    const clockMoved = !!snap && snap.state === 'play' && snap.t !== this.lastRunT;
    if (snap) this.lastRunT = snap.t;
    if (sig !== this.lastSig || clockMoved) {
      if (sig !== this.lastSig) log.debug(`ui: ${sig}`);
      this.lastSig = sig; this.lastChange = Date.now(); this.recoveries = 0;
      return;
    }
    const idle = (Date.now() - this.lastChange) / 1000;
    const limit = this.cfg.bot.stuckSec * (this.recoveries + 1);
    if (idle < limit || this.cfg.dryRun) return;
    this.recoveries++;
    this.lastChange = Date.now();
    void this.recover(ui, sig);
  }

  private async recover(ui: UiState, sig: string) {
    await this.ex.releaseAll().catch(() => {});
    if (this.recoveries === 1) {
      this.note(`stuck on "${sig}" — trying Escape`);
      await this.ex.tap('Escape').catch(() => {});
    } else if (this.recoveries === 2) {
      const b = ui.buttons.find((x) => /continue|close|ok|skip|accept|menu|back/i.test(x.text));
      this.note(`still stuck — ${b ? `clicking "${b.text.slice(0, 30)}"` : 'pressing Enter'}`);
      if (b) await this.ex.click(b.x, b.y).catch(() => {}); else await this.ex.tap('Enter').catch(() => {});
    } else {
      // Reload: the game restores its session, and a run that was live comes back through the saved-run flow.
      this.note('still stuck — reloading the page (the run resumes from its save)');
      await this.per.reset();
      await this.browser.cdp.send('Page.reload', {}).catch(() => {});
      this.recoveries = 0;
    }
  }
}
