/**
 * End-to-end type-resolution test for the Vite/Rollup plugin.
 *
 * The "text assertions" in `vite-plugin.test.ts` confirm the plugin emits
 * the expected strings — but that alone can't catch a class of bug where
 * the emission is syntactically right yet TypeScript fails to resolve the
 * types in a consumer. This test closes that gap: it runs the plugin into
 * a tmp dir, drops in a consumer `.ts` file whose type-level assertions
 * only hold if the emitted `fetcher-env.d.ts` wires up correctly, and
 * invokes `tsc --noEmit` against the tmp project.
 *
 * Regression: in v0.8.0 the plugin emitted relative `./paths` imports
 * inside a `declare module 'virtual:fetcher' { ... }` block in a file with
 * no top-level imports. TypeScript treated the containing file as a
 * script rather than a module, and the relative import resolved to an
 * opaque type — causing `PathsToRoutes<paths>` to collapse to
 * `{ [k: string]: { [m]: { body?: Schema<never>, ... } } }` in consumers.
 * The text tests all passed because the emitted string was correct.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { fetcherPlugin } from '../src/vite-plugin.ts';

const SPEC_PATH = join(import.meta.dirname!, 'fixtures', 'petstore.json');
const REPO_ROOT = resolve(import.meta.dirname!, '..');
const TSC = join(REPO_ROOT, 'node_modules', '.bin', 'tsc');

describe('plugin output is type-resolvable by tsc (e2e)', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fetcher-e2e-'));
    const plugin = fetcherPlugin({ spec: SPEC_PATH, output: tmpDir });
    await (plugin.buildStart as () => Promise<void>)();
    // Sanity: the generated files exist.
    if (!existsSync(join(tmpDir, 'paths.d.ts')))
      throw new Error('paths.d.ts not generated');
    if (!existsSync(join(tmpDir, 'fetcher-env.d.ts')))
      throw new Error('fetcher-env.d.ts not generated');
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('consumer importing from virtual:fetcher sees narrowed path keys and slot types', () => {
    // Consumer with type-level assertions. If the emitted fetcher-env.d.ts
    // doesn't resolve `./paths` correctly, `keyof typeof routes` degenerates
    // to `string` and the `'/pets' extends Keys` assertion becomes `false`,
    // which is not assignable to `true` → tsc fails with a type error.
    const consumer = `
/* eslint-disable */
import type { routes } from 'virtual:fetcher';

// Strict Equal — distinguishes \`string\` from a literal union, and
// \`never\` from a real type (\`never extends X\` is always true, so
// \`X extends Y\` checks are useless for detecting the degenerate case).
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;

type Keys = keyof typeof routes;

// If \`./paths\` didn't resolve inside the declare-module block,
// Keys = string (not the petstore path-literal union). This catches that.
const _keysAreLiteralUnion: Equal<Keys, '/pets' | '/pets/{petId}'> = true;

type OutputOf<S> =
  S extends { '~standard': { types?: { output: infer O } } } ? O : never;

// Slot output for /pets GET — must be Pet[], not \`never\` (which is what
// you get when PathsToRoutes<opaque> collapses ResolveResponseFromPaths).
type GetPetsResp = NonNullable<(typeof routes)['/pets']['GET']['response']>;
type GetPetsOutput = OutputOf<GetPetsResp>;
const _getIsNotNever: Equal<GetPetsOutput, never> = false;

// POST /pets body output — must be a Pet-shaped object, not \`never\`.
type PostBody = NonNullable<(typeof routes)['/pets']['POST']['body']>;
type PostBodyOutput = OutputOf<PostBody>;
const _postBodyIsNotNever: Equal<PostBodyOutput, never> = false;

void _keysAreLiteralUnion; void _getIsNotNever; void _postBodyIsNotNever;
`;

    writeFileSync(join(tmpDir, 'consumer.ts'), consumer);

    // Minimal tsconfig that points `@bajustone/fetcher` (and its subpaths)
    // back at this repo's sources via path mapping — the emitted
    // fetcher-env.d.ts imports `@bajustone/fetcher` as a bare specifier.
    const tsconfig = {
      compilerOptions: {
        target: 'ESNext',
        module: 'ESNext',
        moduleResolution: 'bundler',
        lib: ['ESNext', 'DOM'],
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        allowImportingTsExtensions: true,
        baseUrl: '.',
        paths: {
          '@bajustone/fetcher': [`${REPO_ROOT}/src/index.ts`],
          '@bajustone/fetcher/openapi': [`${REPO_ROOT}/src/openapi/index.ts`],
          '@bajustone/fetcher/schema': [`${REPO_ROOT}/src/schema/index.ts`],
        },
      },
      files: ['consumer.ts', 'fetcher-env.d.ts', 'paths.d.ts'],
    };
    writeFileSync(join(tmpDir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2));

    const result = spawnSync(TSC, ['-p', tmpDir], {
      cwd: tmpDir,
      encoding: 'utf-8',
    });

    if (result.status !== 0) {
      // Print full output so CI failures are diagnosable.
      console.error(`\n[e2e] tsc stdout:\n${result.stdout}\n[e2e] tsc stderr:\n${result.stderr}`);
    }
    expect(result.status).toBe(0);
  });
});
