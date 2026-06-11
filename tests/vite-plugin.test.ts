/**
 * Tests for the Rollup/Vite plugin (`src/vite-plugin.ts`).
 *
 * Exercises the three Rollup hooks (`buildStart`, `resolveId`, `load`) and
 * the generated output files (`paths.d.ts`, `fetcher-env.d.ts`).
 *
 * These tests require `openapi-typescript` to be available on the PATH
 * (installed via `bun add -d openapi-typescript` or resolved via `bunx`).
 * If it's not available, the `buildStart` tests will fail with a clear error.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { extractRouteSchemas } from '../src/openapi.ts';
import { fetcherPlugin } from '../src/vite-plugin.ts';

const SPEC_PATH = join(import.meta.dirname!, '..', 'tests', 'fixtures', 'petstore.json');

describe('fetcherPlugin', () => {
  let tmpDir: string;
  let plugin: ReturnType<typeof fetcherPlugin>;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fetcher-plugin-test-'));
    plugin = fetcherPlugin({
      spec: SPEC_PATH,
      output: tmpDir,
    });
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('buildStart', () => {
    it('generates paths.d.ts from the petstore fixture', async () => {
      await (plugin.buildStart as () => Promise<void>)();

      const pathsDts = join(tmpDir, 'paths.d.ts');
      expect(existsSync(pathsDts)).toBe(true);

      const content = readFileSync(pathsDts, 'utf-8');
      // Should contain the petstore paths interface.
      expect(content).toContain('"/pets"');
      expect(content).toContain('"/pets/{petId}"');
      // Should contain component schemas.
      expect(content).toContain('Pet');
      expect(content).toContain('Error');
    });

    it('generates fetcher-env.d.ts with the virtual module declaration', () => {
      // buildStart was already called above; just verify the env file.
      const envDts = join(tmpDir, 'fetcher-env.d.ts');
      expect(existsSync(envDts)).toBe(true);

      const content = readFileSync(envDts, 'utf-8');
      expect(content).toContain('declare module \'virtual:fetcher\'');
      // Imports from '@bajustone/fetcher' and its subpaths.
      expect(content).toMatch(/from '@bajustone\/fetcher(\/[a-z-]+)?'/);
      // routes is typed against the generated paths interface. The relative
      // `./paths` reference uses dynamic-import type syntax (not a bare
      // `import type` statement) so TypeScript reliably resolves it inside
      // the ambient `declare module` block — see src/vite-plugin.ts for the
      // full explanation.
      expect(content).toContain('export const routes: PathsToRoutes<import(\'./paths\').paths>');
      // Regression guard: the bare `paths` reference without dynamic-import
      // syntax does not resolve in ambient declare-module blocks, and a
      // top-level `import type` import would turn the file into a module
      // (breaking `declare module 'virtual:fetcher'`).
      expect(content).not.toContain('PathsToRoutes<paths>;');
      expect(content).not.toMatch(/^import type \{ [^}]*paths/m);
      // Components enabled by default: schemas + validators declared on
      // virtual:fetcher with literal-keyed names (not Record<string, ...>),
      // so schemas.Nonexistent is a compile error and IDEs autocomplete
      // component names. Validator outputs narrow to the matching
      // components['schemas'][Name] type.
      expect(content).toContain('export const schemas: {');
      expect(content).toContain('"Pet": JSONSchemaDefinition;');
      expect(content).toContain('"Error": JSONSchemaDefinition;');
      expect(content).toContain('export const validators: {');
      // Validator output types use dynamic-import type syntax for the
      // `components` reference — same reason as `paths`.
      expect(content).toContain('"Pet": StandardSchemaV1<unknown, import(\'./paths\').components[\'schemas\']["Pet"]>;');
      expect(content).toContain('"Error": StandardSchemaV1<unknown, import(\'./paths\').components[\'schemas\']["Error"]>;');
      // Regression guard: the old Record<...> shape is gone
      expect(content).not.toContain('Record<string, JSONSchemaDefinition>');
      expect(content).not.toContain('Record<string, StandardSchemaV1<unknown, unknown>>');
      // Regression guard: the old bare Routes type is gone
      expect(content).not.toContain('export const routes: Routes');
      expect(content).toContain('declare module \'virtual:fetcher/inlined\'');
    });
  });

  describe('resolveId', () => {
    it('resolves virtual:fetcher to the internal virtual ID', () => {
      const resolved = (plugin.resolveId as (source: string) => string | null)('virtual:fetcher');
      expect(resolved).toBe('\0virtual:fetcher');
    });

    it('resolves virtual:fetcher/inlined to its sentinel', () => {
      const resolved = (plugin.resolveId as (source: string) => string | null)('virtual:fetcher/inlined');
      expect(resolved).toBe('\0virtual:fetcher/inlined');
    });

    it('returns null for other imports', () => {
      const resolved = (plugin.resolveId as (source: string) => string | null)('lodash');
      expect(resolved).toBeNull();
    });
  });

  describe('load', () => {
    it('returns the virtual module code for the resolved virtual ID', () => {
      const code = (plugin.load as (id: string) => string | null)('\0virtual:fetcher');
      expect(code).not.toBeNull();
      expect(code).toContain('import { fromJSONSchema } from \'@bajustone/fetcher/openapi\'');
      expect(code).toContain('export const routes');
      expect(code).toContain('__buildRoutes');
      // Should NOT contain a pre-built client — user creates their own
      expect(code).not.toContain('createFetch');
      expect(code).not.toContain('export const api');
      expect(code).not.toContain('baseUrl');
    });

    it('does not import the full spec JSON', () => {
      const code = (plugin.load as (id: string) => string | null)('\0virtual:fetcher');
      expect(code).not.toContain('import spec from');
      expect(code).not.toContain('fromOpenAPI');
      expect(code).not.toContain('export { spec }');
    });

    it('inlines only extracted schemas, not the full spec', () => {
      const code = (plugin.load as (id: string) => string | null)('\0virtual:fetcher')!;
      // Should contain schema fragments from the petstore fixture. Data is
      // emitted through JSON.parse("...") (own-property semantics for
      // __proto__ keys), so the fragments appear escaped.
      expect(code).toContain(String.raw`\"type\":\"object\"`);
      // Should NOT contain spec metadata (descriptions, summaries, etc.)
      expect(code).not.toContain('Petstore');
      expect(code).not.toContain('operationId');
      expect(code).not.toContain('A paged array of pets');
    });

    it('returns null for other module IDs', () => {
      const code = (plugin.load as (id: string) => string | null)('some-other-module');
      expect(code).toBeNull();
    });

    it('emits schemas and validators by default on virtual:fetcher', () => {
      const code = (plugin.load as (id: string) => string | null)('\0virtual:fetcher')!;
      expect(code).toContain('export const schemas');
      expect(code).toContain('export const validators');
      expect(code).toContain('__components');
      // Validators should use lazy getters, not a Proxy
      expect(code).toContain('__validatorCache');
      expect(code).not.toContain('new Proxy');
    });

    it('emits virtual:fetcher/inlined with schemas and cyclic/acyclic partitioning', () => {
      const code = (plugin.load as (id: string) => string | null)('\0virtual:fetcher/inlined')!;
      expect(code).toContain('export const schemas');
      expect(code).toContain('__inlined');
      expect(code).toContain('__cyclic');
      // Cyclic getter should throw with the canonical message prefix
      expect(code).toContain('is recursive and cannot be inlined');
    });

    it('inlined module output contains no $ref from the petstore fixture', () => {
      const code = (plugin.load as (id: string) => string | null)('\0virtual:fetcher/inlined')!;
      // petstore has no cyclic types — after inlining, no $ref should appear
      // (ignore $schema / $defs checks; $ref is the critical one)
      expect(code.includes('"$ref"')).toBe(false);
    });

    it('canonical module preserves $ref shape for consumers that resolve them', () => {
      const code = (plugin.load as (id: string) => string | null)('\0virtual:fetcher')!;
      // petstore Pet is referenced from routes — it may appear in __defs or inlined
      // into __components; either way the bundled component form keeps $ref.
      expect(code).toContain('$defs');
    });
  });
});

describe('fetcherPlugin with components: false', () => {
  let tmpDir: string;
  let plugin: ReturnType<typeof fetcherPlugin>;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fetcher-plugin-test-off-'));
    plugin = fetcherPlugin({
      spec: SPEC_PATH,
      output: tmpDir,
      components: false,
    });
    await (plugin.buildStart as () => Promise<void>)();
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('omits schemas and validators from virtual:fetcher', () => {
    const code = (plugin.load as (id: string) => string | null)('\0virtual:fetcher')!;
    expect(code).not.toContain('export const schemas');
    expect(code).not.toContain('export const validators');
    // routes still exported
    expect(code).toContain('export const routes');
  });

  it('emits an empty virtual:fetcher/inlined module', () => {
    const code = (plugin.load as (id: string) => string | null)('\0virtual:fetcher/inlined')!;
    expect(code).toContain('export {}');
  });

  it('omits schemas/validators declarations from fetcher-env.d.ts', () => {
    const envDts = join(tmpDir, 'fetcher-env.d.ts');
    const content = readFileSync(envDts, 'utf-8');
    expect(content).toContain('declare module \'virtual:fetcher\'');
    // routes is still typed against the generated paths interface, even
    // when components are off — only the component-derived exports are
    // suppressed.
    expect(content).toContain('export const routes: PathsToRoutes<import(\'./paths\').paths>');
    // With components off, the `components` side of ./paths isn't referenced.
    expect(content).not.toContain('import(\'./paths\').components');
    expect(content).not.toContain('export const schemas');
    expect(content).not.toContain('export const validators');
    expect(content).not.toContain('virtual:fetcher/inlined');
  });
});

describe('extractRouteSchemas', () => {
  const spec = JSON.parse(readFileSync(SPEC_PATH, 'utf-8'));

  it('extracts route schemas from the petstore fixture', () => {
    const result = extractRouteSchemas(spec);

    expect(result.routes['/pets']).toBeDefined();
    expect(result.routes['/pets']!.GET).toBeDefined();
    expect(result.routes['/pets']!.POST).toBeDefined();
    expect(result.routes['/pets/{petId}']).toBeDefined();
    expect(result.routes['/pets/{petId}']!.GET).toBeDefined();
  });

  it('extracts query params for GET /pets', () => {
    const result = extractRouteSchemas(spec);
    const query = result.routes['/pets']!.GET!.query;
    expect(query).toBeDefined();
    expect(query!.properties!.limit).toEqual({ type: 'integer' });
  });

  it('extracts body schema for POST /pets', () => {
    const result = extractRouteSchemas(spec);
    const body = result.routes['/pets']!.POST!.body;
    expect(body).toBeDefined();
    expect(body!.$ref).toBe('#/components/schemas/Pet');
  });

  it('extracts definitions from components.schemas', () => {
    const result = extractRouteSchemas(spec);
    const pet = result.definitions.Pet;
    expect(pet).toBeDefined();
    expect(pet!.type).toBe('object');
    expect(pet!.properties!.name).toEqual({ type: 'string' });
  });

  it('does not include spec metadata', () => {
    const result = extractRouteSchemas(spec);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('operationId');
    expect(serialized).not.toContain('A paged array of pets');
    expect(serialized).not.toContain('Pet collection');
  });
});

describe('fetcherPlugin remote url (issue #5)', () => {
  let tmpDir: string;
  let srcSpec: string;
  const realFetch = globalThis.fetch;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fetcher-plugin-url-'));
    // A committed source spec the plugin must NOT overwrite.
    srcSpec = join(tmpDir, 'openapi.json');
    writeFileSync(srcSpec, '{"committed":"do-not-touch"}');
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes the fetched spec to a cache file and leaves the source spec untouched', async () => {
    const remoteBody = readFileSync(SPEC_PATH, 'utf-8');
    globalThis.fetch = (async () =>
      new Response(remoteBody, { status: 200 })) as unknown as typeof fetch;

    const outDir = join(tmpDir, 'out');
    const plugin = fetcherPlugin({
      spec: srcSpec,
      url: 'https://example.com/openapi.json',
      output: outDir,
    });
    await (plugin.buildStart as () => Promise<void>)();

    // Source spec is byte-for-byte unchanged.
    expect(readFileSync(srcSpec, 'utf-8')).toBe('{"committed":"do-not-touch"}');
    // Cache file holds the fetched spec and generation succeeded from it.
    expect(existsSync(join(outDir, '.fetcher-spec-cache.json'))).toBe(true);
    expect(readFileSync(join(outDir, 'paths.d.ts'), 'utf-8')).toContain('"/pets"');
  });
});

describe('fetcherPlugin OpenAPI guard (issue #7)', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fetcher-plugin-guard-'));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects valid JSON that is not an OpenAPI 3.x document', async () => {
    const badSpec = join(tmpDir, 'not-openapi.json');
    writeFileSync(badSpec, '{"swagger":"2.0","paths":{}}');
    const plugin = fetcherPlugin({ spec: badSpec, output: join(tmpDir, 'out') });
    await expect((plugin.buildStart as () => Promise<void>)()).rejects.toThrow(/not a valid OpenAPI 3\.x/);
  });

  it('malformed spec JSON surfaces an error naming the spec file path', async () => {
    const badJson = join(tmpDir, 'mid-edit.json');
    writeFileSync(badJson, '{"openapi": "3.0.3", "paths": {');
    const plugin = fetcherPlugin({ spec: badJson, output: join(tmpDir, 'out2') });
    const promise = (plugin.buildStart as () => Promise<void>)();
    // The error must name the offending file (not a bare SyntaxError) so the
    // Vite overlay / CI log points at the spec the user is mid-editing.
    await expect(promise).rejects.toThrow(/not valid JSON/);
    await expect((plugin.buildStart as () => Promise<void>)()).rejects.toThrow(badJson);
  });
});

describe('fetcherPlugin remote url — timeout and fallback chain', () => {
  let tmpDir: string;
  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  let warnings: string[];

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fetcher-plugin-fallback-'));
  });

  beforeEach(() => {
    warnings = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('passes an abort signal to fetch (timeout wired up)', async () => {
    let seenSignal: unknown;
    const remoteBody = readFileSync(SPEC_PATH, 'utf-8');
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      seenSignal = init?.signal;
      return new Response(remoteBody, { status: 200 });
    }) as unknown as typeof fetch;

    const plugin = fetcherPlugin({
      spec: SPEC_PATH,
      url: 'https://example.com/openapi.json',
      output: join(tmpDir, 'signal'),
    });
    await (plugin.buildStart as () => Promise<void>)();

    expect(seenSignal).toBeInstanceOf(AbortSignal);
  });

  it('falls back to the local spec on timeout with a warning naming the URL', async () => {
    // Simulate a server that accepts the connection but never responds:
    // the promise settles only when the plugin's timeout signal aborts it.
    globalThis.fetch = ((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      })) as unknown as typeof fetch;

    const outDir = join(tmpDir, 'timeout');
    const plugin = fetcherPlugin({
      spec: SPEC_PATH,
      url: 'https://stalled.example.com/openapi.json',
      output: outDir,
      fetchTimeoutMs: 10,
    });
    await (plugin.buildStart as () => Promise<void>)();

    // Generation completed from the local file despite the stalled remote.
    expect(readFileSync(join(outDir, 'paths.d.ts'), 'utf-8')).toContain('"/pets"');
    const warning = warnings.find(w => w.includes('stalled.example.com'));
    expect(warning).toBeDefined();
    expect(warning).toContain('timed out after 10ms');
    expect(warning).toContain('using local file');
  });

  it('prefers the cached copy over the local file when the fetch fails', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const outDir = join(tmpDir, 'cached');
    mkdirSync(outDir, { recursive: true });
    // Pre-seed the cache with a valid spec; point `spec` at a file that
    // would fail generation, proving the cache (not the local file) was used.
    writeFileSync(join(outDir, '.fetcher-spec-cache.json'), readFileSync(SPEC_PATH, 'utf-8'));
    const localSpec = join(tmpDir, 'not-openapi-local.json');
    writeFileSync(localSpec, '{"committed":"do-not-touch"}');

    const plugin = fetcherPlugin({
      spec: localSpec,
      url: 'https://down.example.com/openapi.json',
      output: outDir,
    });
    await (plugin.buildStart as () => Promise<void>)();

    expect(readFileSync(join(outDir, 'paths.d.ts'), 'utf-8')).toContain('"/pets"');
    const warning = warnings.find(w => w.includes('down.example.com'));
    expect(warning).toBeDefined();
    expect(warning).toContain('using cached copy');
  });

  it('throws an error naming the URL when no cache or local file exists', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const plugin = fetcherPlugin({
      spec: join(tmpDir, 'does-not-exist.json'),
      url: 'https://gone.example.com/openapi.json',
      output: join(tmpDir, 'nothing'),
    });
    await expect((plugin.buildStart as () => Promise<void>)()).rejects.toThrow(
      /gone\.example\.com.*no cached or local file exists/,
    );
  });

  it('does not rewrite the cache file when the fetched content is unchanged', async () => {
    const remoteBody = readFileSync(SPEC_PATH, 'utf-8');
    globalThis.fetch = (async () =>
      new Response(remoteBody, { status: 200 })) as unknown as typeof fetch;

    const outDir = join(tmpDir, 'stable-cache');
    const plugin = fetcherPlugin({
      spec: SPEC_PATH,
      url: 'https://example.com/openapi.json',
      output: outDir,
    });
    await (plugin.buildStart as () => Promise<void>)();
    const cachePath = join(outDir, '.fetcher-spec-cache.json');
    const firstMtime = statSync(cachePath).mtimeMs;

    await (plugin.buildStart as () => Promise<void>)();
    // Same content → no write → mtime unchanged. This keeps the addWatchFile
    // registration of the cache file from looping rollup watch mode.
    expect(statSync(cachePath).mtimeMs).toBe(firstMtime);
  });
});

describe('fetcherPlugin buildStart registers watch files (rollup watch mode)', () => {
  let tmpDir: string;
  const realFetch = globalThis.fetch;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fetcher-plugin-watchfiles-'));
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('calls this.addWatchFile(specPath) so `vite build --watch` sees spec changes', async () => {
    const watched: string[] = [];
    const plugin = fetcherPlugin({ spec: SPEC_PATH, output: join(tmpDir, 'local') });
    await (plugin.buildStart as (this: unknown) => Promise<void>).call({
      addWatchFile: (id: string) => watched.push(id),
    });
    expect(watched).toContain(SPEC_PATH);
  });

  it('also watches the cache file when `url` is set', async () => {
    const remoteBody = readFileSync(SPEC_PATH, 'utf-8');
    globalThis.fetch = (async () =>
      new Response(remoteBody, { status: 200 })) as unknown as typeof fetch;

    const outDir = join(tmpDir, 'remote');
    const watched: string[] = [];
    const plugin = fetcherPlugin({
      spec: SPEC_PATH,
      url: 'https://example.com/openapi.json',
      output: outDir,
    });
    await (plugin.buildStart as (this: unknown) => Promise<void>).call({
      addWatchFile: (id: string) => watched.push(id),
    });
    expect(watched).toContain(SPEC_PATH);
    expect(watched).toContain(join(outDir, '.fetcher-spec-cache.json'));
  });

  it('tolerates being invoked without a plugin context', async () => {
    const plugin = fetcherPlugin({ spec: SPEC_PATH, output: join(tmpDir, 'no-ctx') });
    // Unit-test style invocation: no `this`. Must not throw.
    await (plugin.buildStart as () => Promise<void>)();
  });
});

describe('fetcherPlugin single-flight generate()', () => {
  let tmpDir: string;
  const realFetch = globalThis.fetch;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fetcher-plugin-serial-'));
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
    const start = Date.now();
    while (!condition()) {
      if (Date.now() - start > timeoutMs)
        throw new Error('waitFor timed out');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }

  it('never runs two generate() calls concurrently and coalesces queued callers', async () => {
    const remoteBody = readFileSync(SPEC_PATH, 'utf-8');
    const resolvers: Array<(response: Response) => void> = [];
    let fetchCalls = 0;
    // The remote fetch is the controllable async gap inside generate():
    // while it is pending, generate() is provably "in flight".
    globalThis.fetch = (() => {
      fetchCalls++;
      return new Promise<Response>((resolve) => {
        resolvers.push(resolve);
      });
    }) as unknown as typeof fetch;

    const plugin = fetcherPlugin({
      spec: SPEC_PATH,
      url: 'https://example.com/openapi.json',
      output: join(tmpDir, 'out'),
    });
    const buildStart = plugin.buildStart as () => Promise<void>;

    // Three overlapping triggers while the first run is blocked on fetch.
    const first = buildStart();
    const second = buildStart();
    const third = buildStart();
    await waitFor(() => fetchCalls === 1);
    // Nothing else may start while run #1 is in flight.
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(fetchCalls).toBe(1);

    resolvers[0]!(new Response(remoteBody, { status: 200 }));
    await first;

    // The two queued callers coalesce into exactly ONE follow-up run.
    await waitFor(() => fetchCalls === 2);
    resolvers[1]!(new Response(remoteBody, { status: 200 }));
    await Promise.all([second, third]);
    expect(fetchCalls).toBe(2);
  });

  it('a queued run still executes after the in-flight run fails', async () => {
    let fetchCalls = 0;
    const resolvers: Array<{ resolve: (r: Response) => void; reject: (e: unknown) => void }> = [];
    globalThis.fetch = (() => {
      fetchCalls++;
      return new Promise<Response>((resolve, reject) => {
        resolvers.push({ resolve, reject });
      });
    }) as unknown as typeof fetch;

    // No cache and no local file: a failed fetch makes generate() throw.
    const plugin = fetcherPlugin({
      spec: join(tmpDir, 'missing.json'),
      url: 'https://example.com/openapi.json',
      output: join(tmpDir, 'fail-out'),
    });
    const buildStart = plugin.buildStart as () => Promise<void>;

    const first = buildStart();
    const second = buildStart();
    await waitFor(() => fetchCalls === 1);
    resolvers[0]!.reject(new Error('boom'));
    await expect(first).rejects.toThrow(/no cached or local file exists/);

    // The queued follow-up still runs (and fails on its own terms).
    await waitFor(() => fetchCalls === 2);
    resolvers[1]!.reject(new Error('boom again'));
    await expect(second).rejects.toThrow(/no cached or local file exists/);
  });
});

describe('fetcherPlugin inlined module — unresolvable component refs', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fetcher-plugin-unresolved-'));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits a throwing getter naming the unresolvable ref, not a bogus "recursive" message', async () => {
    const specPath = join(tmpDir, 'dangling.json');
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

    // Note: buildStart is deliberately NOT called — openapi-typescript's
    // bundled validator rejects dangling refs outright, but load() reads the
    // spec directly and must still degrade gracefully per-component.
    const plugin = fetcherPlugin({ spec: specPath, output: join(tmpDir, 'out') });
    const code = (plugin.load as (id: string) => string | null)('\0virtual:fetcher/inlined')!;

    // Fine inlines; Broken lands in the __failed map with the real reason.
    // (JSON.parse emission → the key appears escaped inside the literal.)
    expect(code).toContain(String.raw`\"Fine\"`);
    expect(code).toContain('__failed');
    expect(code).toContain('could not be inlined');
    expect(code).toContain('Missing');
  });
});
