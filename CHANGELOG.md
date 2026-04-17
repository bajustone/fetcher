# Changelog

## [0.5.0] - 2026-04-18

Non-breaking ergonomics release. Adds the top-level `parse()` function
users coming from Zod expect.

### Added

- `parse(schema, data)` — thin wrapper over
  `schema['~standard'].validate(data)`. Returns the native Standard
  Schema V1 result (`{ value } | { issues }`). Never throws. Works with
  the bundled builder, Zod, Valibot, ArkType, or any Standard Schema V1
  validator.
- `parseOrThrow(schema, data)` — returns the validated value on success,
  throws `SchemaValidationError` carrying the raw `issues` on failure.
  Sync only — for async validators, `await schema['~standard'].validate(data)`
  directly. Matches fetcher's `.unwrap()` philosophy (throwing form for
  server code).
- `SchemaValidationError` — `Error` subclass with `.issues` field. Its
  `.message` is the `formatIssues` output of the underlying issues.

Standalone functions, not methods — preserves per-factory tree-shaking.
Exported from `@bajustone/fetcher/schema`.

### Bundle impact

- Core and other subpaths unchanged.
- `./schema` wholesale: ~3.0 → ~3.1 KB gz (~80 B gz for the three exports).

## [0.4.0] - 2026-04-18

Type-level-only release. Closes the long-standing gap where
`fromOpenAPI(spec)` narrowed paths and methods but left body / response /
errorResponse types as `unknown` unless the user added
`openapi-typescript` codegen. `as const`-typed specs now infer through.

### Added

- `JSONSchemaToType<S, Defs>` — walks a JSON Schema literal and produces
  the TypeScript type of values that satisfy it. Covers the runtime
  validator's subset: primitives, arrays, objects (with required-split),
  `enum`, `const`, `anyOf` / `oneOf` → union, `allOf` → intersection,
  `$ref` against a defs map, and OpenAPI 3.0 `nullable`. Exported from
  the core package for users who want to type a response manually.

- `InferRoutesFromSpec<S>` now emits typed route definitions when `S` is
  narrowly typed (typically via `const spec = {...} as const`). Each
  method's `body`, `response`, and `errorResponse` slots are inferred
  via `JSONSchemaToType` against the spec's `components.schemas`.
  `params` and `query` stay as `Schema<unknown>` for now (path params
  still flow through `ExtractPathParams`).

### Changed

- `src/types.ts` now imports `InferredRouteDefinition` from the new
  `src/infer-spec.ts` module. Pure type-level; no runtime change.

### Unchanged

- When the spec isn't narrowly typed (e.g. plain
  `import spec from './openapi.json'`, which widens literals),
  inference falls back to `unknown`. The codegen path
  (`openapi-typescript` → `paths.d.ts` → `createFetch<paths>`) remains
  the recommended approach for large specs — it's mature, keeps
  TypeScript's conditional-type budget in check, and handles every edge
  case. Zero-codegen inference is the new alternative, not the
  replacement.

## [0.3.0] - 2026-04-18

Non-breaking additions to `@bajustone/fetcher/schema`. Closes the last two
"I wanted that" gaps for DTO validation: custom predicates and
undefined-only defaults. Plus an ergonomic display helper.

### Added

- `refined(schema, predicate, message?)` — wraps any base schema with a
  custom validation predicate. Runs after the base validator passes.
  Emits `refine_failed` code on predicate rejection. For cross-field
  rules, business constraints, or checks that don't fit in the standard
  options.

- `default_(schema, fallback)` — undefined-only fallback. Missing object
  keys or `undefined` inputs substitute `fallback` without invoking the
  base validator. Any other value validates through the inner schema
  normally. Key stays required-typed in object output (consumer always
  sees the value). Emits `default: fallback` in the JSON Schema.

- `formatIssues(issues, options?)` — flattens an issues array into a
  display string. Configurable separator, path joiner, and path/message
  separator. Purely display; no API change to issue shape.

### Changed

- `prependPath` helper inside `object`, `array`, and `record`/`tuple`
  validators now preserves the `code` field on propagated issues. Prior
  versions dropped `code` when re-wrapping an issue with a parent path.

### Bundle impact

- Core and other subpaths unchanged.
- `./schema` wholesale: ~2.9 → ~3.0 KB gz (+100 B for the three new
  factories + issue-code preservation path).
- Per-schema incremental cost: ~50 B gz when `refined` / `default_` /
  `formatIssues` is imported.

### Intentionally still out of scope

Per the discussion on discovered design: `.transform()`, `.pipe()`,
`.preprocess()`, `.coerce()`, `.catch()`, async validation, `received`
field on issues, constraint params, sub-issue trees for unions.
`refined` + `default_` cover the ~70% of transform-like needs that
align with "validate wire data as-is"; the rest are covered by
Zod/Valibot drop-in via Standard Schema V1.

## [0.2.0] - 2026-04-18

Non-breaking feature release. Expands `@bajustone/fetcher/schema` with the
most-requested structural primitives and adds machine-readable error codes
to every builder-emitted validation issue. No changes to core or plugin.

### Added

**Object composition** (in `@bajustone/fetcher/schema`) — reshape existing
object schemas without re-typing their properties:

- `partial(schema)` — make all keys optional
- `required(schema)` — make all keys required
- `pick(schema, ['a', 'b'] as const)` — sub-selection
- `omit(schema, ['c'] as const)` — inverse of pick
- `extend(schema, { extraKey: ... })` — add/override keys
- `merge(a, b)` — combine two object schemas
- `keyof_(schema)` — enum of string keys

**New composite types:**

- `record(valueSchema)` — string-keyed dictionary, infers `Record<string, V>`
- `tuple([a, b, c])` — fixed-length positional array, infers `[A, B, C]`

**Extended primitives:**

- `undefined_()` — explicit undefined (distinct from `optional`)
- `any_()` — opts out of type checking (use `unknown` when possible)
- `never_()` — rejects all values, for exhaustiveness helpers
- `bigint_()` — validates `typeof v === 'bigint'` (for custom JSON parsers)

**Number constraint expansion:**

- `positive()`, `nonnegative()`, `negative()`, `nonpositive()`, `finite()`,
  `safe()` — convenience wrappers
- `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf` on `NumberOptions`

**String constraint expansion:**

- `length`, `startsWith`, `endsWith`, `includes` on `StringOptions`

**Meta helpers:**

- `brand<'UserId'>()(integer())` — type-level nominal typing, runtime
  passthrough; `Brand<T, B>` type utility
- `describe(schema, 'text')` — attaches JSON Schema `description`
- `title(schema, 'text')` — attaches JSON Schema `title`

**Machine-readable error codes:**

- Every builder-emitted issue now carries a `code` field alongside
  `message`. Stable snake_case identifiers: `expected_string`, `too_short`,
  `missing`, `no_variant_matched`, `unknown_discriminator`, `unresolved_ref`,
  `not_a_multiple`, etc. `StandardSchemaV1Issue.code` is an optional public
  field so external validators can opt in or omit it.

### Changed

- `StandardSchemaV1Issue` interface gains `readonly code?: string` — purely
  additive, existing implementations still satisfy the shape.

### Bundle impact

- Core (`.`): unchanged at ~2.7 KB gzipped.
- `./schema` wholesale: 1.9 → 2.9 KB gz (the new factories add ~1 KB when
  imported together). Per-factory tree-shaking still holds: a `string`-only
  fixture ships at ~440 B gz.
- `./openapi`: 3.7 → 4.0 KB gz (pulls more of the builder via
  `fromJSONSchema`).

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
