/**
 * `npm start` — boot the sandbox host, open the sandbox browser on it and let the bot play.
 *
 *   --dry-run        perceive and decide, send no input
 *   --sandbox-only   only the host (mirror + mock API + dashboard)
 *   --manual         host + sandbox browser, no bot (play by hand)
 *   --headless       no browser window
 *   --fill           warm-up: let the mirror fetch static files it does not have yet (off by default)
 *   --runs=N --bank=SECONDS --species=4,1,7 --mode=standard --port=8080 --debug
 */
import { loadConfig, sandboxOrigin } from './config.ts';
import { initLogger, logger } from './logger.ts';
import { SandboxHost } from './sandbox/server.ts';
import { SandboxBrowser } from './cdp/browser.ts';

const cfg = loadConfig();
initLogger(cfg.logLevel, cfg.dataDir);
const log = logger('main');

const host = new SandboxHost(cfg);
await host.start();

let browser: SandboxBrowser | null = null;
let stopping = false;
const shutdown = async (code = 0) => {
  if (stopping) return;
  stopping = true;
  log.info('shutting down');
  await browser?.close().catch(() => {});
  await Promise.race([host.stop(), new Promise((r) => setTimeout(r, 1500))]);
  process.exit(code);
};
process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));

if (cfg.sandboxOnly) {
  log.info('sandbox only: open the sandbox browser with `npm run browser`, Ctrl+C to stop');
} else if (!host.mirror.hasIndex()) {
  log.error('The mirror is empty. Run `npm run mirror` once, then start again.');
  await shutdown(1);
} else {
  browser = new SandboxBrowser(cfg);
  browser.onExit = () => void shutdown(0);
  await browser.launch();
  if (cfg.manual) {
    await browser.navigate('/');
    log.info(`manual mode: the sandbox browser is on ${sandboxOrigin(cfg)}; close it or press Ctrl+C to stop`);
  } else {
    const { Session } = await import('./bot/session.ts');
    const session = new Session(cfg, host, browser);
    try {
      await session.run();
      await shutdown(0);
    } catch (e) {
      log.error('session ended with an error', String((e as Error).stack ?? e));
      await shutdown(1);
    }
  }
}
