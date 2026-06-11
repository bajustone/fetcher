/**
 * Guards against the `package.json` / `jsr.json` version drift that let JSR
 * publish a stale manifest (issue #2). The version-bump script
 * (`scripts/changelog.ts`) writes both; this test fails CI if they ever
 * diverge again.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';

const root = join(import.meta.dirname!, '..');

describe('manifest version sync', () => {
  it('package.json and jsr.json declare the same version', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
    const jsr = JSON.parse(readFileSync(join(root, 'jsr.json'), 'utf-8'));
    expect(jsr.version).toBe(pkg.version);
  });
});

describe('manifest exports parity', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
  const jsr = JSON.parse(readFileSync(join(root, 'jsr.json'), 'utf-8'));

  it('package.json and jsr.json expose the same subpath keys', () => {
    expect(Object.keys(pkg.exports).sort()).toEqual(Object.keys(jsr.exports).sort());
  });

  it('every npm export is the compiled dist twin of the jsr src entry', () => {
    for (const [key, srcEntry] of Object.entries(jsr.exports as Record<string, string>)) {
      const npmEntry = pkg.exports[key] as { types: string; default: string };
      // ./src/foo/bar.ts → ./dist/foo/bar.js / .d.ts
      const expectedJs = srcEntry.replace('./src/', './dist/').replace(/\.ts$/, '.js');
      const expectedDts = srcEntry.replace('./src/', './dist/').replace(/\.ts$/, '.d.ts');
      expect(npmEntry.default).toBe(expectedJs);
      expect(npmEntry.types).toBe(expectedDts);
    }
  });

  it('types condition comes first in every export (publint rule)', () => {
    for (const entry of Object.values(pkg.exports as Record<string, Record<string, string>>))
      expect(Object.keys(entry)[0]).toBe('types');
  });
});
