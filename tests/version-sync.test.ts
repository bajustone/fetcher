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
