/**
 * Guards the README's bundle-size claims. Builds tree-shaken entries with
 * bun's bundler, gzips them, and fails when a budget is exceeded — so a
 * dependency-free "2.7 kB core" claim can never silently rot.
 *
 * Run: bun scripts/check-size.ts
 */

import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const root = join(import.meta.dirname, '..');

/**
 * [label, entry source, gzip budget in bytes]
 *
 * Budgets were set 2026-06 from measured sizes (+~10% headroom) after the
 * v1.0 hardening pass; the pre-1.0 core was ~2.6 kB and deliberately grew
 * to ~4 kB for correctness (lazy dispatch, real query serialization,
 * abort/timeout classification, status-preserving response handling).
 * Raising a budget is allowed — but it must be a conscious decision in the
 * same PR that needs it, with the README size claims updated to match.
 */
const BUDGETS: Array<[string, string, number]> = [
  [
    'createFetch only (tree-shaken core)',
    `import { createFetch } from '${root}/src/index.ts'; console.log(createFetch);`,
    4_400,
  ],
  [
    'schema string() only',
    `import { string } from '${root}/src/schema/index.ts'; console.log(string);`,
    800,
  ],
  [
    'full core entry (createFetch + all middleware + errors)',
    `import * as all from '${root}/src/index.ts'; console.log(all);`,
    5_700,
  ],
];

const { mkdtempSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');

let failed = false;
const workDir = mkdtempSync(join(tmpdir(), 'fetcher-size-'));
try {
  for (const [label, source, budget] of BUDGETS) {
    const entry = join(workDir, 'entry.ts');
    await Bun.write(entry, source);
    const build = await Bun.build({ entrypoints: [entry], minify: true });
    if (!build.success) {
      console.error(`build failed for: ${label}`);
      failed = true;
      continue;
    }
    const code = await build.outputs[0]!.text();
    const gzipped = gzipSync(code, { level: 9 }).byteLength;
    const ok = gzipped <= budget;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}: ${gzipped} B gzipped (budget ${budget} B)`);
    if (!ok)
      failed = true;
  }
}
finally {
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
