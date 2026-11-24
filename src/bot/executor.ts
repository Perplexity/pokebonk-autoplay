import type { Cdp } from '../cdp/client.ts';
import { logger } from '../logger.ts';

const log = logger('executor');

/** `KeyboardEvent.code` → what CDP needs to produce that key. Letters, digits and the keys the game binds. */
function keyInfo(code: string): { key: string; code: string; vk: number; text?: string } {
  const named: Record<string, { key: string; vk: number; text?: string }> = {
    Space: { key: ' ', vk: 32, text: ' ' }, Enter: { key: 'Enter', vk: 13, text: '\r' }, Escape: { key: 'Escape', vk: 27 },
    Tab: { key: 'Tab', vk: 9 }, ShiftLeft: { key: 'Shift', vk: 16 }, ControlLeft: { key: 'Control', vk: 17 }, AltLeft: { key: 'Alt', vk: 18 },
    ArrowLeft: { key: 'ArrowLeft', vk: 37 }, ArrowUp: { key: 'ArrowUp', vk: 38 }, ArrowRight: { key: 'ArrowRight', vk: 39 }, ArrowDown: { key: 'ArrowDown', vk: 40 },
    Backspace: { key: 'Backspace', vk: 8 },
  };
  if (named[code]) return { code, ...named[code] };
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return { code, key: m[1].toLowerCase(), vk: m[1].charCodeAt(0), text: m[1].toLowerCase() };
  m = /^Digit(\d)$/.exec(code);
  if (m) return { code, key: m[1], vk: 48 + Number(m[1]), text: m[1] };
  m = /^F(\d{1,2})$/.exec(code);
  if (m) return { code, key: code, vk: 111 + Number(m[1]) };
  throw new Error(`Unknown key code ${code}`);
}

/**
 * Sends input to the sandbox page through the browser (CDP Input domain): key presses, mouse moves and clicks. The
 * executor keeps the set of held keys so the policy can say "hold these" every tick and only the changes are sent.
 */
export class Executor {
  private cdp: Cdp;
  private held = new Set<string>();
  readonly dryRun: boolean;
  /** Counters for the log and the dashboard. */
  sent = { keys: 0, clicks: 0, moves: 0 };

  constructor(cdp: Cdp, dryRun: boolean) { this.cdp = cdp; this.dryRun = dryRun; }

  private async key(type: 'keyDown' | 'keyUp', code: string) {
    const k = keyInfo(code);
    this.sent.keys++;
    if (this.dryRun) return;
    await this.cdp.send('Input.dispatchKeyEvent', {
      type: type === 'keyDown' ? (k.text ? 'keyDown' : 'rawKeyDown') : 'keyUp',
      key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk,
      ...(type === 'keyDown' && k.text ? { text: k.text, unmodifiedText: k.text } : {}),
    });
  }

  /** Make exactly this set of keys held: releases what is no longer wanted, presses what is new. */
  async hold(codes: Iterable<string>) {
    const want = new Set(codes);
    for (const c of [...this.held]) if (!want.has(c)) { this.held.delete(c); await this.key('keyUp', c).catch((e) => log.debug(e.message)); }
    for (const c of want) if (!this.held.has(c)) { this.held.add(c); await this.key('keyDown', c).catch((e) => log.debug(e.message)); }
  }

  async releaseAll() { await this.hold([]); }

  async tap(code: string, ms = 50) {
    if (this.held.has(code)) { this.held.delete(code); await this.key('keyUp', code); }
    await this.key('keyDown', code);
    await new Promise((r) => setTimeout(r, ms));
    await this.key('keyUp', code);
  }

  async move(x: number, y: number) {
    this.sent.moves++;
    if (this.dryRun) return;
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  }

  async click(x: number, y: number) {
    this.sent.clicks++;
    if (this.dryRun) return;
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await new Promise((r) => setTimeout(r, 40));
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  }
}
