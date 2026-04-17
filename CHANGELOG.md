# Changelog

## [0.1.0] - 2026-04-17

First breaking release. Adds a native, tree-shakeable schema builder and
splits the package into subpaths. Core shrinks from 7.2 KB → **2.7 KB gzipped**.

### Added
- `@bajustone/fetcher/schema` — native schema builder with compile-on-construction
  validators. Exports `string`, `number`, `integer`, `boolean`, `null_`, `literal`,
  `unknown`, `object`, `array`, `optional`, `nullable`, `union`, `intersect`,
  `enum_`, `discriminatedUnion`, `ref` + `compile` (lazy, cycle-safe $ref binding),
  and format helpers (`email`, `url`, `uuid`, `datetime`, `date`, `time`). Every
  factory is `@__NO_SIDE_EFFECTS__`-annotated; importing only `string` lands at
  **327 B gzipped**.
- `@bajustone/fetcher/openapi` subpath — `fromOpenAPI`, `fromJSONSchema` (raw
  JSON Schema → compiled builder), `inline`, `extractRouteSchemas`,
  `extractComponentSchemas`, `bundleComponent`, `translateDialect`,
  `JSONSchemaDefinition`.
- `@bajustone/fetcher/spec-tools` subpath — `coverage`, `lintSpec`.

### Changed
- Validation now happens via pre-compiled closures captured at schema construction,
  not by walking a schema object at runtime. Short literal error messages
  (`Expected string`, `Too short`, `Missing`, etc.) for better gzip density.
- Vite plugin's `virtual:fetcher` now emits
  `import { fromJSONSchema } from '@bajustone/fetcher/openapi'` and compiles
  validators via the builder. No user-facing surface change.
- `fromOpenAPI` output: each body/params/query/response/errorResponse slot is
  now a compiled builder validator (same `~standard` shape as before).

### Removed (breaking)
- `JSONSchemaValidator` class and `ValidationError` class — deleted. Use
  `fromJSONSchema(schema)` for raw JSON Schema, or the native builder for
  hand-authored schemas.
- `fromOpenAPI`, `extractRouteSchemas`, `extractComponentSchemas`,
  `bundleComponent`, `translateDialect`, `JSON_SCHEMA_DIALECT`,
  `ExtractedRouteSchemas`, `JSONSchemaDefinition`, `inline` — moved from
  the root entry to `@bajustone/fetcher/openapi`.
- `coverage`, `lintSpec`, `RouteCoverage`, `SpecCoverageReport`,
  `SpecDriftIssue` — moved to `@bajustone/fetcher/spec-tools`.

### Migration

```ts
// Before
import { JSONSchemaValidator, fromOpenAPI, inline, coverage } from '@bajustone/fetcher';
const v = new JSONSchemaValidator(schema);

// After
import { fromJSONSchema, fromOpenAPI, inline } from '@bajustone/fetcher/openapi';
import { coverage } from '@bajustone/fetcher/spec-tools';
const v = fromJSONSchema(schema);

// New — native builder
import { object, string, integer, optional } from '@bajustone/fetcher/schema';
const Pet = object({ id: integer(), name: string(), tag: optional(string()) });
```

## [0.0.15] - 2026-04-17

### Added
- clean docs
- add component schemas + validators to virtual:fetcher

## [0.0.14] - 2026-04-11

### Fixed
- fix url query

## [0.0.13] - 2026-04-10

### Changed
- update read me

## [0.0.12] - 2026-04-10

### Added
- feat: add .unwrap() and .query() primitives on TypedFetchPromise

## [0.0.11] - 2026-04-10

### Changed
- refactor: redesign plugin to export routes instead of pre-built client

## [0.0.10] - 2026-04-10

### Fixed
- fix: vite plugin no longer ships full OpenAPI spec in bundle

## [0.0.9] - 2026-04-10

### Added
- add Rollup/Vite plugin; rewrite docs to match source

## [0.0.8] - 2026-04-10

### Added
- dx: .result() shorthand, bearerWithRefresh exclude, SchemaOf<>

## [0.0.7] - 2026-04-10

### Added
- types

## [0.0.6] - 2026-04-09

### Added
- rework: result model, middleware, retry/timeout, OpenAPI typing

## [0.0.5] - 2026-04-09

### Fixed
- fix jsr

## [0.0.4] - 2026-04-09

### Changed
- Document every exported type and interface field in `src/types.ts` to lift the JSR documented-symbols score.
- Promote `executeMiddleware` to a full JSDoc block and mark it `@internal`.

### Fixed
- Remove the dead `description` field from `jsr.json` (not part of JSR's config schema — set via package settings instead).

## [0.0.3] - 2026-04-09

### Fixed
- fix jsr
