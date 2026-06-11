/**
 * End-to-end tests for the Vite/Rollup plugin output, in two halves:
 *
 * 1. **Type resolution** — the "text assertions" in `vite-plugin.test.ts`
 *    confirm the plugin emits the expected strings, but that alone can't
 *    catch a class of bug where the emission is syntactically right yet
 *    TypeScript fails to resolve the types in a consumer. This half runs
 *    the plugin into a tmp dir, drops in a consumer `.ts` file whose
 *    type-level assertions only hold if the emitted `fetcher-env.d.ts`
 *    wires up correctly, and invokes `tsc --noEmit` against the tmp project.
 *
 *    Regression: in v0.8.0 the plugin emitted relative `./paths` imports
 *    inside a `declare module 'virtual:fetcher' { ... }` block in a file
 *    with no top-level imports. TypeScript treated the containing file as a
 *    script rather than a module, and the relative import resolved to an
 *    opaque type — causing `PathsToRoutes<paths>` to collapse to
 *    `{ [k: string]: { [m]: { body?: Schema<never>, ... } } }` in
 *    consumers. The text tests all passed because the emitted string was
 *    correct.
 *
 * 2. **Runtime evaluation** — the virtual-module source is written to a
 *    tmp `.mjs` (with the `@bajustone/fetcher/openapi` specifier rewritten
 *    to this repo's sources), dynamically imported, and its exports
 *    exercised: `routes` validators must actually validate, lazy
 *    `validators.X` getters must build, and the inlined module's cyclic /
 *    unresolvable throwing getters must throw their documented messages.
 *    Without this, a runtime defect in `__buildRoutes`, the lazy getters,
 *    or the `Object.create(null, descriptors)` pattern would ship green.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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

// ---------------------------------------------------------------------------
// Runtime evaluation of the virtual-module code
// ---------------------------------------------------------------------------

/**
 * Rewrites the emitted virtual-module source so its bare
 * `@bajustone/fetcher/openapi` import resolves against this repo's sources,
 * writes it to a tmp `.mjs`, and dynamically imports it.
 */
async function importVirtualModule(
  dir: string,
  fileName: string,
  code: string,
): Promise<Record<string, any>> {
  const openapiEntry = pathToFileURL(join(REPO_ROOT, 'src', 'openapi', 'index.ts')).href;
  const rewritten = code.replace(/'@bajustone\/fetcher\/openapi'/g, `'${openapiEntry}'`);
  const modulePath = join(dir, fileName);
  writeFileSync(modulePath, rewritten);
  return await import(pathToFileURL(modulePath).href) as Record<string, any>;
}

/** Standard Schema helper: validate and normalize to a settled result. */
async function validate(
  schema: any,
  value: unknown,
): Promise<{ value?: unknown; issues?: ReadonlyArray<{ message: string }> }> {
  return await schema['~standard'].validate(value);
}

describe('virtual:fetcher module code executes (e2e runtime)', () => {
  let tmpDir: string;
  let mod: Record<string, any>;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fetcher-e2e-runtime-'));
    const plugin = fetcherPlugin({ spec: SPEC_PATH, output: tmpDir });
    const code = (plugin.load as (id: string) => string | null)('\0virtual:fetcher')!;
    mod = await importVirtualModule(tmpDir, 'virtual-fetcher.mjs', code);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exports a routes table keyed by path and UPPERCASE method', () => {
    expect(Object.keys(mod.routes).sort()).toEqual(['/pets', '/pets/{petId}']);
    expect(Object.keys(mod.routes['/pets']).sort()).toEqual(['GET', 'POST']);
    expect(mod.routes['/pets/{petId}'].GET).toBeDefined();
  });

  it('route body validator accepts a valid Pet and rejects an invalid one', async () => {
    const body = mod.routes['/pets'].POST.body;
    expect(body).toBeDefined();

    const ok = await validate(body, { id: 1, name: 'Rex' });
    expect(ok.issues).toBeUndefined();
    expect(ok.value).toEqual({ id: 1, name: 'Rex' });

    const bad = await validate(body, { tag: 'no-required-fields' });
    expect(bad.issues).toBeDefined();
    expect(bad.issues!.length).toBeGreaterThan(0);
  });

  it('route response validator resolves $defs refs at validation time', async () => {
    // GET /pets → 200 is array of Pet ($ref into components).
    const response = mod.routes['/pets'].GET.response;
    expect(response).toBeDefined();

    const ok = await validate(response, [{ id: 1, name: 'Rex' }, { id: 2, name: 'Fi', tag: 't' }]);
    expect(ok.issues).toBeUndefined();

    const bad = await validate(response, [{ id: 'not-a-number', name: 'Rex' }]);
    expect(bad.issues).toBeDefined();
  });

  it('route query validator validates query params', async () => {
    const query = mod.routes['/pets'].GET.query;
    expect(query).toBeDefined();
    const ok = await validate(query, { limit: 5 });
    expect(ok.issues).toBeUndefined();
    const bad = await validate(query, { limit: 'five' });
    expect(bad.issues).toBeDefined();
  });

  it('schemas export is frozen and spec-canonical', () => {
    expect(Object.keys(mod.schemas).sort()).toEqual(['Error', 'Pet']);
    expect(Object.isFrozen(mod.schemas)).toBe(true);
    expect(mod.schemas.Pet.type).toBe('object');
  });

  it('lazy validators.X getters build working validators with stable identity', async () => {
    const first = mod.validators.Pet;
    const second = mod.validators.Pet;
    expect(first).toBe(second); // memoized, not rebuilt per access

    const ok = await validate(first, { id: 7, name: 'Bo' });
    expect(ok.issues).toBeUndefined();
    const bad = await validate(first, { id: 'x', name: 42 });
    expect(bad.issues).toBeDefined();
  });
});

describe('virtual:fetcher/inlined module code executes (e2e runtime)', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fetcher-e2e-inlined-'));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('acyclic schemas are plain inlined values with no $ref', async () => {
    const plugin = fetcherPlugin({ spec: SPEC_PATH, output: join(tmpDir, 'acyclic') });
    const code = (plugin.load as (id: string) => string | null)('\0virtual:fetcher/inlined')!;
    const mod = await importVirtualModule(tmpDir, 'inlined-acyclic.mjs', code);

    expect(Object.keys(mod.schemas).sort()).toEqual(['Error', 'Pet']);
    expect(mod.schemas.Pet.type).toBe('object');
    expect(JSON.stringify(mod.schemas.Pet)).not.toContain('$ref');
  });

  it('cyclic components throw the documented message on access; others still work', async () => {
    const specPath = join(tmpDir, 'cyclic-spec.json');
    writeFileSync(specPath, JSON.stringify({
      openapi: '3.0.3',
      info: { title: 't', version: '1' },
      paths: {},
      components: {
        schemas: {
          Tree: {
            type: 'object',
            properties: {
              value: { type: 'string' },
              children: { type: 'array', items: { $ref: '#/components/schemas/Tree' } },
            },
          },
          Plain: { type: 'object', properties: { ok: { type: 'boolean' } } },
        },
      },
    }));

    const plugin = fetcherPlugin({ spec: specPath, output: join(tmpDir, 'cyclic') });
    const code = (plugin.load as (id: string) => string | null)('\0virtual:fetcher/inlined')!;
    const mod = await importVirtualModule(tmpDir, 'inlined-cyclic.mjs', code);

    // The acyclic sibling inlines normally.
    expect(mod.schemas.Plain.type).toBe('object');
    // The cyclic one throws on ACCESS (not import) with the actionable message.
    expect(() => mod.schemas.Tree).toThrow(/schemas\.Tree is recursive and cannot be inlined/);
    expect(() => mod.schemas.Tree).toThrow(/virtual:fetcher/);
  });

  it('components with unresolvable refs throw the real reason on access', async () => {
    const specPath = join(tmpDir, 'dangling-spec.json');
    writeFileSync(specPath, JSON.stringify({
      openapi: '3.0.3',
      info: { title: 't', version: '1' },
      paths: {},
      components: {
        schemas: {
          Broken: {
            type: 'object',
            properties: { x: { $ref: '#/components/schemas/Missing' } },
          },
          Fine: { type: 'object', properties: { y: { type: 'string' } } },
        },
      },
    }));

    const plugin = fetcherPlugin({ spec: specPath, output: join(tmpDir, 'dangling') });
    const code = (plugin.load as (id: string) => string | null)('\0virtual:fetcher/inlined')!;
    const mod = await importVirtualModule(tmpDir, 'inlined-dangling.mjs', code);

    expect(mod.schemas.Fine.type).toBe('object');
    expect(() => mod.schemas.Broken).toThrow(/schemas\.Broken could not be inlined/);
    expect(() => mod.schemas.Broken).toThrow(/Missing/);
  });
});
