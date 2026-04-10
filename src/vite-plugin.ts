/**
 * Rollup/Vite plugin for `@bajustone/fetcher` — auto-generates typed paths
 * from an OpenAPI spec and provides a virtual module with pre-built route
 * schemas for runtime validation.
 *
 * **Rollup-compatible:** uses only standard Rollup hooks (`buildStart`,
 * `resolveId`, `load`) so it works in Vite, Rollup, SvelteKit, Astro, and
 * anything built on Rollup. Vite-specific hooks (`configureServer`) are
 * included for dev-server file watching but are silently ignored by Rollup.
 *
 * **No new dependencies on `@bajustone/fetcher`:** the plugin dynamically
 * imports `openapi-typescript` at build time. If it's not installed, a clear
 * error tells the user what to `bun add -d`.
 *
 * @example
 * ```typescript
 * // vite.config.ts
 * import { fetcherPlugin } from '@bajustone/fetcher/vite';
 *
 * export default defineConfig({
 *   plugins: [
 *     fetcherPlugin({ spec: './openapi.json' }),
 *   ],
 * });
 * ```
 *
 * Then in your app:
 * ```typescript
 * import { createFetch } from '@bajustone/fetcher';
 * import type { paths } from './paths';
 * import { routes } from 'virtual:fetcher';
 *
 * export const api = createFetch<paths>({
 *   baseUrl: 'https://api.example.com',
 *   routes,
 *   middleware: [...],
 * });
 * ```
 *
 * @module
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { extractRouteSchemas } from './openapi.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Configuration for {@link fetcherPlugin}. */
export interface FetcherPluginOptions {
  /**
   * Path to the OpenAPI 3.x JSON spec file, relative to the project root
   * (or absolute).
   */
  spec: string;
  /**
   * Directory to emit generated files (`paths.d.ts` and `fetcher-env.d.ts`).
   * Defaults to the directory containing the spec file.
   */
  output?: string;
  /**
   * Remote URL to fetch the OpenAPI spec from. If set, the spec is
   * downloaded and written to the `spec` path before generation.
   * Falls back to the local file if the fetch fails.
   */
  url?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VIRTUAL_MODULE_ID = 'virtual:fetcher';
/** Rollup convention: `\0` prefix marks a virtual module. */
const RESOLVED_VIRTUAL_ID = `\0${VIRTUAL_MODULE_ID}`;

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * Rollup/Vite plugin that:
 *
 * 1. **Generates `paths.d.ts`** from the OpenAPI spec via `openapi-typescript`
 *    (run at build start; re-run on spec change in Vite dev mode).
 * 2. **Provides `virtual:fetcher`** — a virtual module exporting pre-built
 *    route schemas for runtime validation. The user imports `routes` and
 *    passes them to `createFetch` with their own middleware and config.
 *    Only the JSON Schema nodes needed for validation are inlined — the
 *    full OpenAPI spec is never shipped to the client bundle.
 * 3. **Emits `fetcher-env.d.ts`** — a module declaration that types the
 *    virtual module so TypeScript sees `routes` as `Routes`.
 *
 * @returns A Vite/Rollup-compatible plugin object. Typed as `any` to avoid
 * requiring `vite` as a peer dependency — the object satisfies Vite's
 * `Plugin` interface structurally.
 */
export function fetcherPlugin(options: FetcherPluginOptions): any {
  const { spec } = options;
  const specPath = resolve(spec);
  const outputDir = resolve(options.output ?? dirname(spec));
  const pathsDtsPath = resolve(outputDir, 'paths.d.ts');
  const envDtsPath = resolve(outputDir, 'fetcher-env.d.ts');

  async function generate(): Promise<void> {
    mkdirSync(outputDir, { recursive: true });

    // If a remote URL is configured, fetch and cache the spec locally.
    if (options.url) {
      try {
        const response = await globalThis.fetch(options.url);
        if (!response.ok)
          throw new Error(`HTTP ${response.status}`);
        const body = await response.text();
        JSON.parse(body); // Validate JSON before overwriting
        writeFileSync(specPath, body);
      }
      catch (err) {
        if (existsSync(specPath)) {
          console.warn(`[fetcher] Failed to fetch spec from ${options.url}, using local file: ${err}`);
        }
        else {
          throw new Error(
            `[fetcher] Failed to fetch spec from ${options.url} and no local file exists at ${spec}: ${err}`,
          );
        }
      }
    }

    await runOpenAPITypeScript(specPath, pathsDtsPath);
    appendSchemaHelper(pathsDtsPath);
    emitEnvDeclaration(envDtsPath);
  }

  return {
    name: 'fetcher',

    // Rollup hook: runs once at the start of each build.
    async buildStart() {
      await generate();
    },

    // Rollup hook: intercept `import 'virtual:fetcher'`.
    resolveId(source: string) {
      if (source === VIRTUAL_MODULE_ID)
        return RESOLVED_VIRTUAL_ID;
      return null;
    },

    // Rollup hook: provide the virtual module's source code.
    // Extracts only the JSON Schema nodes needed for validation at build
    // time — the full OpenAPI spec is never shipped to the client bundle.
    // Exports `routes` (not a pre-built client) so the user controls
    // middleware, baseUrl, and other config via their own `createFetch`.
    load(id: string) {
      if (id !== RESOLVED_VIRTUAL_ID)
        return null;

      const rawSpec = JSON.parse(readFileSync(specPath, 'utf-8'));
      const { definitions, routes } = extractRouteSchemas(rawSpec);

      return [
        `import { JSONSchemaValidator } from '@bajustone/fetcher';`,
        `const __defs = ${JSON.stringify(definitions)};`,
        `const __routes = ${JSON.stringify(routes)};`,
        `function __buildRoutes(extracted, defs) {`,
        `  const r = {};`,
        `  for (const [path, methods] of Object.entries(extracted)) {`,
        `    r[path] = {};`,
        `    for (const [method, schemas] of Object.entries(methods)) {`,
        `      const d = {};`,
        `      for (const [key, schema] of Object.entries(schemas)) {`,
        `        d[key] = new JSONSchemaValidator(schema, defs);`,
        `      }`,
        `      r[path][method] = d;`,
        `    }`,
        `  }`,
        `  return r;`,
        `}`,
        `export const routes = __buildRoutes(__routes, __defs);`,
      ].join('\n');
    },

    // Vite-specific hook: watch the spec file and regenerate on change.
    // Rollup ignores this hook silently.
    configureServer(server: ViteDevServer) {
      server.watcher.add(specPath);
      server.watcher.on('change', async (changedPath: string) => {
        if (resolve(changedPath) !== specPath)
          return;

        try {
          await generate();
          // Invalidate the virtual module so Vite serves fresh code.
          const mod = server.moduleGraph.getModuleById(RESOLVED_VIRTUAL_ID);
          if (mod)
            server.moduleGraph.invalidateModule(mod);
          server.ws.send({ type: 'full-reload' });
        }
        catch (error) {
          server.config.logger.error(
            `[fetcher] Failed to regenerate from ${spec}: ${error}`,
          );
        }
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Generates `paths.d.ts` from the OpenAPI spec using the `openapi-typescript`
 * programmatic API. The package is NOT a dependency of `@bajustone/fetcher` —
 * it must be installed in the user's project as a dev dependency. If it's
 * missing, a clear error is thrown.
 */
async function runOpenAPITypeScript(specPath: string, outputPath: string): Promise<void> {
  let openapiTS: (schema: unknown) => Promise<string>;
  try {
    const mod = await import('openapi-typescript');
    // openapi-typescript v7+ returns TypeScript AST nodes and provides
    // astToString() to serialise them. Earlier versions returned a string
    // directly. Support both shapes.
    if (typeof mod.astToString === 'function') {
      const astToString = mod.astToString as (ast: unknown) => string;
      const rawFn = mod.default as unknown as (schema: unknown) => Promise<unknown>;
      openapiTS = async (schema: unknown) => astToString(await rawFn(schema));
    }
    else {
      openapiTS = mod.default as unknown as (schema: unknown) => Promise<string>;
    }
  }
  catch {
    throw new Error(
      '[fetcher] Could not import openapi-typescript. Install it as a dev dependency:\n\n'
      + '  bun add -d openapi-typescript\n',
    );
  }

  const specContent = JSON.parse(readFileSync(specPath, 'utf-8'));
  const output = await openapiTS(specContent);
  writeFileSync(outputPath, output);
}

/**
 * Appends a pre-applied `Schema<Name>` type alias to the generated
 * `paths.d.ts` so users can write `import type { Schema } from './paths'`
 * instead of importing `SchemaOf` from `@bajustone/fetcher` and `components`
 * from `./paths` separately. Only appended if the generated output contains
 * a `components` interface (i.e. the spec has `components.schemas`).
 */
function appendSchemaHelper(pathsDtsPath: string): void {
  const content = readFileSync(pathsDtsPath, 'utf-8');
  if (!content.includes('components'))
    return;

  const helper = [
    ``,
    `// --- Added by @bajustone/fetcher plugin ---`,
    `import type { SchemaOf } from '@bajustone/fetcher';`,
    `/** Pre-applied SchemaOf — use \`Schema<'Pet'>\` instead of \`SchemaOf<components, 'Pet'>\`. */`,
    `export type Schema<Name extends string> = SchemaOf<components, Name>;`,
    ``,
  ].join('\n');

  appendFileSync(pathsDtsPath, helper);
}

/**
 * Emits `fetcher-env.d.ts` — a module declaration that types the
 * `virtual:fetcher` virtual module. The declaration exports `routes` as
 * `Routes` — a standalone type from `@bajustone/fetcher` with no relative
 * imports, eliminating the `declare module` + relative path fragility that
 * affected SvelteKit and other frameworks.
 *
 * The user should include this file in their `tsconfig.json` `include`
 * array (or it lands there automatically if the output dir is inside `src/`).
 */
function emitEnvDeclaration(envDtsPath: string): void {
  const content = [
    `// Auto-generated by @bajustone/fetcher plugin — do not edit.`,
    `// Provides type declarations for the virtual:fetcher module.`,
    `// Make sure this file is included in your tsconfig.json.`,
    ``,
    `declare module 'virtual:fetcher' {`,
    `  import type { Routes } from '@bajustone/fetcher';`,
    `  /** Pre-built route schemas for runtime validation. */`,
    `  export const routes: Routes;`,
    `}`,
    ``,
  ].join('\n');

  writeFileSync(envDtsPath, content);
}

// ---------------------------------------------------------------------------
// Minimal Vite type stubs (avoids adding vite as a dependency)
// ---------------------------------------------------------------------------

interface ViteModuleNode {
  id: string | null;
}

interface ViteModuleGraph {
  getModuleById: (id: string) => ViteModuleNode | undefined;
  invalidateModule: (mod: ViteModuleNode) => void;
}

interface ViteDevServer {
  watcher: {
    add: (path: string) => void;
    on: (event: string, callback: (path: string) => void) => void;
  };
  moduleGraph: ViteModuleGraph;
  ws: { send: (payload: { type: string }) => void };
  config: { logger: { error: (msg: string) => void } };
}
