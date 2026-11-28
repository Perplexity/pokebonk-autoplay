import { existsSync } from 'node:fs';
import type { Config } from '../config.ts';

const CANDIDATES = [
  process.env.CHROME_PATH ?? '',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
];

/** The local Chrome or Edge to start: `browser.path` of config.json, CHROME_PATH, or a usual install place. */
export function findBrowser(cfg: Config): string {
  const p = [cfg.browser.path, ...CANDIDATES].find((c) => c && existsSync(c));
  if (!p) throw new Error('No Chrome/Edge found. Set browser.path in config.json or the CHROME_PATH environment variable.');
  return p;
}
