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
import { inline } from './inline.ts';
import { extractComponentSchemas, extractRouteSchemas } from './openapi.ts';

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
  /**
   * Whether to expose `schemas` and `validators` exports from the virtual
   * modules.
   *
   * - `'inline'` (default): emit both
   *   - `virtual:fetcher` — spec-canonical JSON Schema draft-2020-12 with
   *     local `$defs` + `$ref`. Works with ref-aware consumers (AJV, TypeBox)
   *     out of the box. `validators.X` resolves refs at validation time.
   *   - `virtual:fetcher/inlined` — fully-flattened schemas (no `$ref`,
   *     built at plugin time). Drop-in for consumers that don't resolve
   *     refs (sveltekit-superforms' `schemasafe` adapter, Zod 4's
   *     experimental `z.fromJSONSchema`, react-jsonschema-form). Cyclic
   *     components emit as throwing getters with an actionable message.
   * - `false`: omit both `schemas` and `validators`; only `routes` is
   *   exported from `virtual:fetcher`, and `virtual:fetcher/inlined` emits
   *   an empty module.
   */
  components?: 'inline' | false;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VIRTUAL_MODULE_ID = 'virtual:fetcher';
const VIRTUAL_INLINED_ID = 'virtual:fetcher/inlined';
/** Rollup convention: `\0` prefix marks a virtual module. */
const RESOLVED_VIRTUAL_ID = `\0${VIRTUAL_MODULE_ID}`;
const RESOLVED_INLINED_ID = `\0${VIRTUAL_INLINED_ID}`;

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

    // Collect component names so the env declaration can narrow
    // `schemas` / `validators` keys to literal component names (making
    // `schemas.Nonexistent` a compile error and enabling autocomplete).
    const emitComponents = options.components !== false;
    let componentNames: string[] = [];
    if (emitComponents) {
      const rawSpec = JSON.parse(readFileSync(specPath, 'utf-8'));
      componentNames = Object.keys(extractComponentSchemas(rawSpec).schemas);
    }
    emitEnvDeclaration(envDtsPath, emitComponents, componentNames);
  }

  return {
    name: 'fetcher',

    // Rollup hook: runs once at the start of each build.
    async buildStart() {
      await generate();
    },

    // Rollup hook: intercept `import 'virtual:fetcher'` and
    // `import 'virtual:fetcher/inlined'`.
    resolveId(source: string) {
      if (source === VIRTUAL_MODULE_ID)
        return RESOLVED_VIRTUAL_ID;
      if (source === VIRTUAL_INLINED_ID)
        return RESOLVED_INLINED_ID;
      return null;
    },

    // Rollup hook: provide the virtual modules' source code.
    // - `virtual:fetcher` → spec-canonical JSON Schema draft-2020-12 with
    //   local $defs + $ref (ref-aware consumers handle natively)
    // - `virtual:fetcher/inlined` → fully-flattened schemas, pre-inlined at
    //   plugin time (zero runtime cost, stable identity). Cyclic components
    //   emit as throwing getters.
    //
    // Only the JSON Schema nodes needed for validation are inlined — the
    // full OpenAPI spec is never shipped to the client bundle.
    load(id: string) {
      if (id !== RESOLVED_VIRTUAL_ID && id !== RESOLVED_INLINED_ID)
        return null;

      const rawSpec = JSON.parse(readFileSync(specPath, 'utf-8'));
      const emitComponents = options.components !== false;

      if (id === RESOLVED_INLINED_ID) {
        if (!emitComponents)
          return `export {};\n`;
        return buildInlinedModule(rawSpec);
      }

      return buildCanonicalModule(rawSpec, emitComponents);
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
          // Invalidate both virtual modules so Vite serves fresh code.
          for (const moduleId of [RESOLVED_VIRTUAL_ID, RESOLVED_INLINED_ID]) {
            const mod = server.moduleGraph.getModuleById(moduleId);
            if (mod)
              server.moduleGraph.invalidateModule(mod);
          }
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
 * Emits the source for `virtual:fetcher` — the spec-canonical module exposing
 * `routes`, and (when `emitComponents` is true) `schemas` and `validators`.
 * `schemas.X` retains local `$defs` + `$ref`; `validators.X` resolves those
 * refs at validation time.
 */
function buildCanonicalModule(rawSpec: unknown, emitComponents: boolean): string {
  const { definitions, routes } = extractRouteSchemas(rawSpec as Parameters<typeof extractRouteSchemas>[0]);

  const parts: string[] = [
    `import { fromJSONSchema } from '@bajustone/fetcher/openapi';`,
    `const __defs = ${JSON.stringify(definitions)};`,
    `const __routes = ${JSON.stringify(routes)};`,
    `function __buildRoutes(extracted, defs) {`,
    `  const r = {};`,
    `  for (const [path, methods] of Object.entries(extracted)) {`,
    `    r[path] = {};`,
    `    for (const [method, schemas] of Object.entries(methods)) {`,
    `      const d = {};`,
    `      for (const [key, schema] of Object.entries(schemas)) {`,
    `        d[key] = fromJSONSchema(schema, defs);`,
    `      }`,
    `      r[path][method] = d;`,
    `    }`,
    `  }`,
    `  return r;`,
    `}`,
    `export const routes = __buildRoutes(__routes, __defs);`,
  ];

  if (emitComponents) {
    const { schemas } = extractComponentSchemas(rawSpec as Parameters<typeof extractComponentSchemas>[0]);
    parts.push(
      `const __components = ${JSON.stringify(schemas)};`,
      `export const schemas = Object.freeze(__components);`,
      `const __validatorCache = Object.create(null);`,
      `const __validatorDescriptors = {};`,
      `for (const __name of Object.keys(__components)) {`,
      `  __validatorDescriptors[__name] = {`,
      `    enumerable: true,`,
      `    get() {`,
      `      return __validatorCache[__name] ??= fromJSONSchema(`,
      `        __components[__name],`,
      `        __components[__name].$defs ?? {},`,
      `      );`,
      `    },`,
      `  };`,
      `}`,
      `export const validators = Object.freeze(Object.create(null, __validatorDescriptors));`,
    );
  }

  return parts.join('\n');
}

/**
 * Emits the source for `virtual:fetcher/inlined` — the fully-flattened
 * `schemas` export. Acyclic components are pre-inlined at plugin time;
 * cyclic components emit as throwing getters.
 */
function buildInlinedModule(rawSpec: unknown): string {
  const { schemas } = extractComponentSchemas(rawSpec as Parameters<typeof extractComponentSchemas>[0]);

  const inlinedAcyclic: Record<string, unknown> = {};
  const cyclicNames: string[] = [];

  for (const [name, schema] of Object.entries(schemas)) {
    try {
      inlinedAcyclic[name] = inline(schema);
    }
    catch {
      cyclicNames.push(name);
    }
  }

  return [
    `const __inlined = ${JSON.stringify(inlinedAcyclic)};`,
    `const __cyclic = ${JSON.stringify(cyclicNames)};`,
    `const __descriptors = {};`,
    `for (const __name of Object.keys(__inlined)) {`,
    `  __descriptors[__name] = { enumerable: true, value: __inlined[__name] };`,
    `}`,
    `for (const __name of __cyclic) {`,
    `  __descriptors[__name] = {`,
    `    enumerable: true,`,
    `    get() {`,
    `      throw new Error(`,
    `        "schemas." + __name + " is recursive and cannot be inlined. " +`,
    `        "Import it from 'virtual:fetcher' (ref-aware) or use validators." + __name + " (also from 'virtual:fetcher')."`,
    `      );`,
    `    },`,
    `  };`,
    `}`,
    `export const schemas = Object.freeze(Object.create(null, __descriptors));`,
  ].join('\n');
}

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
 * Emits `fetcher-env.d.ts` — module declarations for the virtual modules
 * served by this plugin. Uses only types exported from `@bajustone/fetcher`
 * (no relative imports), eliminating the `declare module` + relative path
 * fragility that affected SvelteKit and other frameworks.
 *
 * When `emitComponents` is true, also declares the `schemas` and `validators`
 * exports on `virtual:fetcher` and the `schemas` export on
 * `virtual:fetcher/inlined`. `componentNames` is the full list of component
 * names pulled from the spec — they become literal keys on `schemas` and
 * `validators`, so `schemas.NonexistentName` is a compile error and IDEs
 * autocomplete component names. Value types remain `JSONSchemaDefinition` /
 * `StandardSchemaV1<unknown, unknown>` (intentionally mutable, no `readonly`,
 * so consumers typed against mutable arrays don't trip on `as const`-style
 * inference).
 *
 * The user should include this file in their `tsconfig.json` `include` array
 * (or it lands there automatically if the output dir is inside `src/`).
 */
function emitEnvDeclaration(
  envDtsPath: string,
  emitComponents: boolean,
  componentNames: string[],
): void {
  const schemasBody = componentNames
    .map(n => `    ${JSON.stringify(n)}: JSONSchemaDefinition;`)
    .join('\n');
  // When component names are known (emitComponents && spec has components.schemas),
  // narrow each validator's output type to the matching `components['schemas'][Name]`.
  // Otherwise fall back to the bare `StandardSchemaV1<unknown, unknown>` shape.
  const hasTypedComponents = emitComponents && componentNames.length > 0;
  const validatorsBody = componentNames
    .map(n => hasTypedComponents
      ? `    ${JSON.stringify(n)}: StandardSchemaV1<unknown, components['schemas'][${JSON.stringify(n)}]>;`
      : `    ${JSON.stringify(n)}: StandardSchemaV1<unknown, unknown>;`)
    .join('\n');

  // `./paths` resolves to the sibling `paths.d.ts` emitted in the same
  // output dir. `components` is only imported when the spec has at least
  // one `components.schemas` entry — otherwise the interface isn't emitted.
  const pathsImport = hasTypedComponents
    ? `  import type { components, paths } from './paths';`
    : `  import type { paths } from './paths';`;

  const lines: string[] = [
    `// Auto-generated by @bajustone/fetcher plugin — do not edit.`,
    `// Provides type declarations for the virtual:fetcher modules.`,
    `// Make sure this file is included in your tsconfig.json.`,
    ``,
    `declare module 'virtual:fetcher' {`,
    `  import type { PathsToRoutes, StandardSchemaV1 } from '@bajustone/fetcher';`,
    `  import type { JSONSchemaDefinition } from '@bajustone/fetcher/openapi';`,
    pathsImport,
    `  /**`,
    `   * Pre-built route schemas for runtime validation, typed against the`,
    `   * generated \`paths\` interface — \`routes[path][METHOD].body\` resolves`,
    `   * to \`Schema<ConcreteBody>\` instead of the bare \`Schema\`. Method keys`,
    `   * are uppercase, matching the runtime table populated by the plugin.`,
    `   */`,
    `  export const routes: PathsToRoutes<paths>;`,
  ];

  if (emitComponents) {
    lines.push(
      `  /**`,
      `   * Component schemas (JSON Schema draft-2020-12) with local \`$defs\` + \`$ref\`.`,
      `   * Drop-in for ref-aware consumers (AJV, TypeBox). For consumers that don't`,
      `   * resolve \`$ref\` (Zod 4's \`fromJSONSchema\`, etc.), use the`,
      `   * \`virtual:fetcher/inlined\` subpath instead.`,
      `   */`,
      schemasBody
        ? `  export const schemas: {\n${schemasBody}\n  };`
        : `  export const schemas: {};`,
      `  /**`,
      `   * Standard Schema V1 validators; resolve \`$ref\` at validation time.`,
      `   * Each validator's output type is narrowed to the matching component`,
      `   * — \`validators.Pet\` is \`StandardSchemaV1<unknown, components['schemas']['Pet']>\`.`,
      `   */`,
      validatorsBody
        ? `  export const validators: {\n${validatorsBody}\n  };`
        : `  export const validators: {};`,
    );
  }

  lines.push(`}`, ``);

  if (emitComponents) {
    lines.push(
      `declare module 'virtual:fetcher/inlined' {`,
      `  import type { JSONSchemaDefinition } from '@bajustone/fetcher/openapi';`,
      `  /**`,
      `   * Fully-flattened component schemas, pre-inlined at plugin time. No \`$ref\`.`,
      `   * Cyclic components throw on access with an actionable message.`,
      `   */`,
      schemasBody
        ? `  export const schemas: {\n${schemasBody}\n  };`
        : `  export const schemas: {};`,
      `}`,
      ``,
    );
  }

  writeFileSync(envDtsPath, lines.join('\n'));
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
