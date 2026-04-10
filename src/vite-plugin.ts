/**
 * Rollup/Vite plugin for `@bajustone/fetcher` — auto-generates typed paths
 * from an OpenAPI spec and provides a virtual module with a pre-configured
 * client.
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
 *     fetcherPlugin({
 *       spec: './openapi.json',
 *       baseUrl: 'https://api.example.com',
 *     }),
 *   ],
 * });
 * ```
 *
 * Then in your app:
 * ```typescript
 * import { api } from 'virtual:fetcher';
 *
 * const result = await api.get('/pets').result();
 * ```
 *
 * @module
 */

import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The Rollup/Vite plugin object returned by {@link fetcherPlugin}.
 * Includes standard Rollup hooks (`buildStart`, `resolveId`, `load`) plus
 * the Vite-specific `configureServer` for dev-mode file watching.
 */
export interface FetcherPlugin {
  name: string;
  buildStart: () => void;
  resolveId: (source: string) => string | null;
  load: (id: string) => string | null;
  configureServer: (server: ViteDevServer) => void;
}

/** Configuration for {@link fetcherPlugin}. */
export interface FetcherPluginOptions {
  /**
   * Path to the OpenAPI 3.x JSON spec file, relative to the project root
   * (or absolute).
   */
  spec: string;
  /** API base URL for the generated `api` client exported by `virtual:fetcher`. */
  baseUrl: string;
  /**
   * Directory to emit generated files (`paths.d.ts` and `fetcher-env.d.ts`).
   * Defaults to the directory containing the spec file.
   */
  output?: string;
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
 * 2. **Provides `virtual:fetcher`** — a virtual module exporting a
 *    pre-configured `createFetch<paths>(...)` client so the user writes
 *    `import { api } from 'virtual:fetcher'` with zero boilerplate.
 * 3. **Emits `fetcher-env.d.ts`** — a module declaration that types the
 *    virtual module so TypeScript sees `api` as fully typed.
 */
export function fetcherPlugin(options: FetcherPluginOptions): FetcherPlugin {
  const { spec, baseUrl } = options;
  const specPath = resolve(spec);
  const outputDir = resolve(options.output ?? dirname(spec));
  const pathsDtsPath = resolve(outputDir, 'paths.d.ts');
  const envDtsPath = resolve(outputDir, 'fetcher-env.d.ts');

  function generate(): void {
    mkdirSync(outputDir, { recursive: true });
    runOpenAPITypeScript(specPath, pathsDtsPath);
    emitEnvDeclaration(envDtsPath, baseUrl);
  }

  return {
    name: 'fetcher',

    // Rollup hook: runs once at the start of each build.
    buildStart() {
      generate();
    },

    // Rollup hook: intercept `import 'virtual:fetcher'`.
    resolveId(source: string) {
      if (source === VIRTUAL_MODULE_ID)
        return RESOLVED_VIRTUAL_ID;
      return null;
    },

    // Rollup hook: provide the virtual module's source code.
    load(id: string) {
      if (id !== RESOLVED_VIRTUAL_ID)
        return null;

      // The virtual module imports the raw JSON spec for runtime validation
      // via fromOpenAPI, and re-exports a pre-configured typed client.
      // The `<paths>` generic is type-only and erased at runtime — the
      // type information comes from fetcher-env.d.ts.
      return [
        `import { createFetch, fromOpenAPI } from '@bajustone/fetcher';`,
        `import spec from '${specPath}';`,
        `export const api = createFetch({ baseUrl: '${baseUrl}', routes: fromOpenAPI(spec) });`,
        `export { spec };`,
      ].join('\n');
    },

    // Vite-specific hook: watch the spec file and regenerate on change.
    // Rollup ignores this hook silently.
    configureServer(server: ViteDevServer) {
      server.watcher.add(specPath);
      server.watcher.on('change', (changedPath: string) => {
        if (resolve(changedPath) !== specPath)
          return;

        try {
          generate();
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
 * Runs `openapi-typescript` to generate `paths.d.ts`. The package is NOT a
 * dependency of `@bajustone/fetcher` — it must be installed in the user's
 * project as a dev dependency. If it's missing, a clear error is thrown.
 */
function runOpenAPITypeScript(specPath: string, outputPath: string): void {
  // Try the local binary first (fast — no resolution), then fall back to
  // npx/bunx (resolves on the fly). This covers both "user installed it
  // as a devDependency" and "user just has bun/npm available".
  const commands = [
    `openapi-typescript "${specPath}" -o "${outputPath}"`,
    `bunx openapi-typescript "${specPath}" -o "${outputPath}"`,
    `npx -y openapi-typescript "${specPath}" -o "${outputPath}"`,
  ];

  for (const cmd of commands) {
    try {
      execSync(cmd, { stdio: 'pipe' });
      return;
    }
    catch {
      // Try the next command.
    }
  }

  throw new Error(
    '[fetcher] Could not run openapi-typescript. Install it as a dev dependency:\n\n'
    + '  bun add -d openapi-typescript\n',
  );
}

/**
 * Emits `fetcher-env.d.ts` — a module declaration that types the
 * `virtual:fetcher` virtual module. The user should include this file in
 * their `tsconfig.json` `include` array (or it lands there automatically
 * if the output dir is inside `src/`).
 */
function emitEnvDeclaration(envDtsPath: string, baseUrl: string): void {
  const content = [
    `// Auto-generated by @bajustone/fetcher plugin — do not edit.`,
    `// Provides type declarations for the virtual:fetcher module.`,
    `// Make sure this file is included in your tsconfig.json.`,
    ``,
    `declare module 'virtual:fetcher' {`,
    `  import type { paths } from './paths';`,
    `  import type { Routes, TypedFetchFn } from '@bajustone/fetcher';`,
    `  /** Pre-configured typed fetch client. Base URL: \`${baseUrl}\` */`,
    `  export const api: TypedFetchFn<Routes, paths>;`,
    `  /** Raw OpenAPI spec object (for runtime use). */`,
    `  export const spec: unknown;`,
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
