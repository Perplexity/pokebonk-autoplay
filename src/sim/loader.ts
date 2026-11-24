import { registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';
import { ORIGIN } from './net.ts';
import { sfc32 } from './rng.ts';

/**
 * Node module hooks that make the game's ES module chunks importable under their browser URLs
 * (`http://localhost:8080/assets/<chunk>.js`), served from the files in mirror/. Keeping the http URL means
 * `import.meta.url`, relative chunk imports, `import.meta.resolve` and dynamic `import()` all behave as in the page.
 *
 * Nothing is written to disk. One chunk is changed IN MEMORY: the main game chunk gets a single statement appended
 * after `var <app>=new <App>;` that publishes the app instance and the App/Run classes on `globalThis.__pb`
 * (the classes are module-private otherwise). It runs before `await <app>.boot()`.
 *
 * A second chunk is changed in memory: three.js. Its `generateUUID` draws four numbers from `Math.random` for every
 * object, texture, material and geometry it creates, i.e. from the same stream the game's rules draw from, and the game
 * creates many of those lazily and keeps them in module-level caches. A process that had already built, say, the
 * texture of the "guardian fell" effect drew 24 numbers fewer at that moment than a fresh one, and the episode went
 * another way from there. The four calls are pointed at a private stream (`globalThis.__pbUuidRandom`), so creating
 * a three.js object no longer moves the game's random numbers. UUID values themselves are never read by game rules.
 */

export interface LoaderInfo {
  /** Chunks served, in load order. */
  loaded: string[];
  /** The exact statement injected into the main chunk (empty until that chunk is loaded). */
  injected: string;
  /** Minified identifiers found in the main chunk tail. */
  ids: { app: string; App: string; Run: string } | null;
  /** How many chunks had three.js' UUID generator redirected to a private random stream (must end up exactly 1). */
  uuidPatched: number;
}

/** `var QE=new ZE;On(ZE.prototype,xw.prototype,…),await QE.boot();` at the very end of the main chunk. */
/** three.js `generateUUID`: `function ke(){let e=Math.random()*4294967295|0,t=Math.random()*4294967295|0,n=…,r=…;return(…`. */
const UUID = /function ([\w$]+)\(\)\{let ([\w$]+)=Math\.random\(\)\*4294967295\|0,([\w$]+)=Math\.random\(\)\*4294967295\|0,([\w$]+)=Math\.random\(\)\*4294967295\|0,([\w$]+)=Math\.random\(\)\*4294967295\|0;/g;

const TAIL = /var ([\w$]+)=new ([\w$]+);([\w$]+)\(\2\.prototype,([\w$]+)\.prototype((?:,[\w$]+\.prototype)*)\),await \1\.boot\(\);?\s*$/;

export function installLoader(mirrorDir: string): LoaderInfo {
  const info: LoaderInfo = { loaded: [], injected: '', ids: null, uuidPatched: 0 };
  // The private stream three.js' UUIDs are drawn from. Fixed seed, never restarted: its values reach no game rule.
  (globalThis as any).__pbUuidRandom = sfc32(0x7e3d1f05);
  const root = normalize(mirrorDir + sep);

  registerHooks({
    resolve(specifier, context, nextResolve) {
      const parent = context.parentURL ?? '';
      if (specifier.startsWith(ORIGIN + '/') || (parent.startsWith(ORIGIN + '/') && /^(\.{1,2}\/|\/)/.test(specifier))) {
        const url = new URL(specifier, parent.startsWith(ORIGIN) ? parent : ORIGIN + '/').href;
        return { url, format: 'module', shortCircuit: true };
      }
      if (parent.startsWith(ORIGIN + '/')) throw new Error(`[sim] the bundle imports something outside the mirror: ${specifier}`);
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (!url.startsWith(ORIGIN + '/')) return nextLoad(url, context);
      const u = new URL(url);
      const file = normalize(join(mirrorDir, decodeURIComponent(u.pathname)));
      if (!file.startsWith(root) || !existsSync(file)) throw new Error(`[sim] chunk not in the mirror: ${u.pathname}`);
      let source = readFileSync(file, 'utf8');
      const m = TAIL.exec(source);
      if (m) {
        const [, app, App, , Run] = m;
        info.ids = { app, App, Run };
        info.injected = `globalThis.__pb={app:${app},App:${App},Run:${Run}};`;
        // Insert right after `var <app>=new <App>;` so the handle exists while boot() is still running.
        const at = m.index + `var ${app}=new ${App};`.length;
        // …and mark the end of boot() (the chunk's top-level await) so the driver knows when the menu is up.
        source = source.slice(0, at) + info.injected + source.slice(at) + ';globalThis.__pb.booted=true;';
      }
      const uuid = [...source.matchAll(UUID)];
      if (uuid.length > 1) throw new Error(`[sim] ${u.pathname}: ${uuid.length} functions look like three.js' generateUUID; expected one`);
      if (uuid.length === 1) {
        const [all, fn, a, b, c, d] = uuid[0];
        const R = 'globalThis.__pbUuidRandom()*4294967295|0';
        source = source.replace(all, () => `function ${fn}(){let ${a}=${R},${b}=${R},${c}=${R},${d}=${R};`);
        info.uuidPatched++;
      }
      info.loaded.push(u.pathname);
      return { format: 'module', source, shortCircuit: true };
    },
  });
  return info;
}
