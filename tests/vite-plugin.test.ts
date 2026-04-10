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

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
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
      expect(content).toContain('import type { Routes } from \'@bajustone/fetcher\'');
      expect(content).toContain('export const routes: Routes');
      // No relative paths import — eliminates SvelteKit fragility
      expect(content).not.toContain('from \'./paths\'');
    });
  });

  describe('resolveId', () => {
    it('resolves virtual:fetcher to the internal virtual ID', () => {
      const resolved = (plugin.resolveId as (source: string) => string | null)('virtual:fetcher');
      expect(resolved).toBe('\0virtual:fetcher');
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
      expect(code).toContain('import { JSONSchemaValidator } from \'@bajustone/fetcher\'');
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
      // Should contain schema fragments from the petstore fixture
      expect(code).toContain('"type":"object"');
      // Should NOT contain spec metadata (descriptions, summaries, etc.)
      expect(code).not.toContain('Petstore');
      expect(code).not.toContain('operationId');
      expect(code).not.toContain('A paged array of pets');
    });

    it('returns null for other module IDs', () => {
      const code = (plugin.load as (id: string) => string | null)('some-other-module');
      expect(code).toBeNull();
    });
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
    const pet = (result.definitions as Record<string, any>).components?.schemas?.Pet;
    expect(pet).toBeDefined();
    expect(pet.type).toBe('object');
    expect(pet.properties.name).toEqual({ type: 'string' });
  });

  it('does not include spec metadata', () => {
    const result = extractRouteSchemas(spec);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('operationId');
    expect(serialized).not.toContain('A paged array of pets');
    expect(serialized).not.toContain('Pet collection');
  });
});
