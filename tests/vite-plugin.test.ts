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
import { fetcherPlugin } from '../src/vite-plugin.ts';

const SPEC_PATH = join(import.meta.dirname!, '..', 'tests', 'fixtures', 'petstore.json');

describe('fetcherPlugin', () => {
  let tmpDir: string;
  let plugin: ReturnType<typeof fetcherPlugin>;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fetcher-plugin-test-'));
    plugin = fetcherPlugin({
      spec: SPEC_PATH,
      baseUrl: 'https://api.example.com',
      output: tmpDir,
    });
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('buildStart', () => {
    it('generates paths.d.ts from the petstore fixture', () => {
      // buildStart is synchronous in our implementation (execSync).
      (plugin.buildStart as () => void)();

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
      expect(content).toContain('import type { paths } from \'./paths\'');
      expect(content).toContain('TypedFetchFn');
      expect(content).toContain('https://api.example.com');
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
      expect(code).toContain('import { createFetch, fromOpenAPI } from \'@bajustone/fetcher\'');
      expect(code).toContain('import spec from');
      expect(code).toContain('baseUrl: \'https://api.example.com\'');
      expect(code).toContain('fromOpenAPI(spec)');
      expect(code).toContain('export const api');
    });

    it('returns null for other module IDs', () => {
      const code = (plugin.load as (id: string) => string | null)('some-other-module');
      expect(code).toBeNull();
    });
  });
});
