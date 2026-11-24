/** Print the mock API's routes as the markdown table used in docs/ENDPOINTS.md:  node scripts/endpoints.ts */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockApi } from '../src/sandbox/mockApi.ts';
import { Store } from '../src/sandbox/store.ts';

const dir = mkdtempSync(join(tmpdir(), 'pb-endpoints-'));
try {
  console.log('| Method | Path | What the sandbox does |\n|---|---|---|');
  for (const r of new MockApi(new Store(dir)).list()) console.log(`| ${r.method} | \`${r.path}\` | ${r.doc} |`);
} finally { rmSync(dir, { recursive: true, force: true }); }
