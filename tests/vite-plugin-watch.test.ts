/**
 * Tests for the Vite dev-server watch flow (`configureServer`) of
 * `src/vite-plugin.ts` — previously the only untested hook.
 *
 * Uses a stub `ViteDevServer` to drive the real handler: spec saves must
 * (debounced) regenerate the outputs, invalidate BOTH virtual module IDs,
 * and trigger a full reload; failed regenerations must surface through the
 * dev-server logger with the spec named; rapid save bursts must coalesce
 * into a single regeneration.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { fetcherPlugin } from '../src/vite-plugin.ts';

const FIXTURE_SPEC = join(import.meta.dirname!, 'fixtures', 'petstore.json');

interface StubServer {
  server: {
    watcher: {
      add: (path: string) => void;
      on: (event: string, callback: (path: string) => void) => void;
    };
    moduleGraph: {
      getModuleById: (id: string) => { id: string } | undefined;
      invalidateModule: (mod: { id: string }) => void;
    };
    ws: { send: (payload: { type: string }) => void };
    config: { logger: { error: (msg: string) => void } };
  };
  watchedPaths: string[];
  invalidated: string[];
  sent: Array<{ type: string }>;
  errors: string[];
  emitChange: (path: string) => void;
}

function makeStubServer(): StubServer {
  const handlers: Record<string, (path: string) => void> = {};
  const stub: StubServer = {
    watchedPaths: [],
    invalidated: [],
    sent: [],
    errors: [],
    emitChange: (path: string) => handlers.change?.(path),
    server: {
      watcher: {
        add: path => stub.watchedPaths.push(path),
        on: (event, callback) => {
          handlers[event] = callback;
        },
      },
      moduleGraph: {
        getModuleById: id => ({ id }),
        invalidateModule: mod => stub.invalidated.push(mod.id),
      },
      ws: { send: payload => stub.sent.push(payload) },
      config: { logger: { error: msg => stub.errors.push(msg) } },
    },
  };
  return stub;
}

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs)
      throw new Error('waitFor timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe('fetcherPlugin configureServer (dev watch flow)', () => {
  let tmpDir: string;
  let specPath: string;
  let outDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fetcher-plugin-watch-'));
    // A mutable copy of the fixture so tests can edit the "spec".
    specPath = join(tmpDir, 'openapi.json');
    writeFileSync(specPath, readFileSync(FIXTURE_SPEC, 'utf-8'));
    outDir = join(tmpDir, 'out');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('adds the spec to the dev watcher', () => {
    const plugin = fetcherPlugin({ spec: specPath, output: outDir });
    const stub = makeStubServer();
    (plugin.configureServer as (s: unknown) => void)(stub.server);
    expect(stub.watchedPaths).toContain(specPath);
  });

  it('spec change regenerates, invalidates both virtual modules, and full-reloads', async () => {
    const plugin = fetcherPlugin({ spec: specPath, output: outDir });
    await (plugin.buildStart as () => Promise<void>)();
    const stub = makeStubServer();
    (plugin.configureServer as (s: unknown) => void)(stub.server);

    // Edit the spec: add a new path, then signal the watcher.
    const spec = JSON.parse(readFileSync(specPath, 'utf-8'));
    spec.paths['/new-route'] = {
      get: { responses: { 200: { description: 'ok' } } },
    };
    writeFileSync(specPath, JSON.stringify(spec));
    stub.emitChange(specPath);

    await waitFor(() => stub.sent.length > 0);

    // Both virtual module IDs invalidated, full reload sent, no errors.
    expect(stub.invalidated).toContain('\0virtual:fetcher');
    expect(stub.invalidated).toContain('\0virtual:fetcher/inlined');
    expect(stub.sent).toEqual([{ type: 'full-reload' }]);
    expect(stub.errors).toEqual([]);
    // The regenerated paths.d.ts reflects the edit.
    expect(readFileSync(join(outDir, 'paths.d.ts'), 'utf-8')).toContain('"/new-route"');
  });

  it('ignores change events for other files', async () => {
    const plugin = fetcherPlugin({ spec: specPath, output: outDir });
    const stub = makeStubServer();
    (plugin.configureServer as (s: unknown) => void)(stub.server);

    stub.emitChange(join(tmpDir, 'unrelated.json'));
    // Give the (would-be) debounce window plenty of time to fire.
    await new Promise(resolve => setTimeout(resolve, 120));

    expect(stub.sent).toEqual([]);
    expect(stub.invalidated).toEqual([]);
  });

  it('a rapid save burst coalesces into a single regeneration', async () => {
    const plugin = fetcherPlugin({ spec: specPath, output: outDir });
    await (plugin.buildStart as () => Promise<void>)();
    const stub = makeStubServer();
    (plugin.configureServer as (s: unknown) => void)(stub.server);

    // Three saves within the debounce window.
    stub.emitChange(specPath);
    stub.emitChange(specPath);
    stub.emitChange(specPath);

    await waitFor(() => stub.sent.length > 0);
    // Allow any (incorrect) extra regenerations to surface before asserting.
    await new Promise(resolve => setTimeout(resolve, 150));

    expect(stub.sent).toEqual([{ type: 'full-reload' }]);
    expect(stub.errors).toEqual([]);
  });

  it('a malformed spec save logs an error naming the file, without reloading', async () => {
    const plugin = fetcherPlugin({ spec: specPath, output: outDir });
    await (plugin.buildStart as () => Promise<void>)();
    const stub = makeStubServer();
    (plugin.configureServer as (s: unknown) => void)(stub.server);

    writeFileSync(specPath, '{"openapi": "3.0.3", "paths": {'); // mid-edit state
    stub.emitChange(specPath);

    await waitFor(() => stub.errors.length > 0);

    expect(stub.errors[0]).toContain('[fetcher] Failed to regenerate');
    // The wrapped readSpec error names the offending file inside the logged
    // message — not just a bare SyntaxError.
    expect(stub.errors[0]).toContain(specPath);
    expect(stub.errors[0]).toContain('not valid JSON');
    expect(stub.sent).toEqual([]);
  });

  it('recovers after a malformed save once the spec is fixed', async () => {
    const plugin = fetcherPlugin({ spec: specPath, output: outDir });
    await (plugin.buildStart as () => Promise<void>)();
    const stub = makeStubServer();
    (plugin.configureServer as (s: unknown) => void)(stub.server);

    const goodSpec = readFileSync(specPath, 'utf-8');
    writeFileSync(specPath, '{broken');
    stub.emitChange(specPath);
    await waitFor(() => stub.errors.length > 0);

    writeFileSync(specPath, goodSpec);
    stub.emitChange(specPath);
    await waitFor(() => stub.sent.length > 0);

    expect(stub.sent).toEqual([{ type: 'full-reload' }]);
  });
});
