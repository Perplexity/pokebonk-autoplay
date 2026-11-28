/**
 * `npm run mirror` — copy the game's public static files into ./mirror, where the headless environment reads them.
 *
 *   npm run mirror            page shell, JS/CSS chunks, data files, files named in the bundles
 *   npm run mirror -- --deep  also the per-species sprites, portraits, icons and cries
 *
 * This is the only command that talks to the public site, and it only issues plain GETs for static files: no login,
 * no API calls. Run it again when the live build changes.
 */
import { loadConfig } from '../config.ts';
import { initLogger } from '../logger.ts';
import { Mirror } from './mirror.ts';

const cfg = loadConfig();
initLogger(cfg.logLevel);
const mirror = new Mirror({ dir: cfg.mirrorDir, upstream: cfg.upstream, fillMisses: true });
const deep = process.argv.includes('--deep');
let last = 0;
console.log(`Copying static files from ${cfg.upstream} into ${cfg.mirrorDir}${deep ? ' (deep)' : ''} ...`);
const out = await mirror.crawl({
  deep,
  onProgress: (done, total, file) => {
    if (Date.now() - last < 500) return;
    last = Date.now();
    process.stdout.write(`\r  ${done}/${total}  ${file.slice(-60).padEnd(60)}`);
  },
});
console.log(`\nDone: ${out.files} files known, ${out.downloaded} downloaded this time.`);
