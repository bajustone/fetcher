# Changelog

## [1.0.0] - Unreleased

Hardening release. The API surface is the one you know; a pre-release audit
drove deliberate behavior corrections across the request/response data plane.
The exhaustive list of every observable change is in
[`docs/migration-1.0.md`](./docs/migration-1.0.md) — this section is the
summary.

### Breaking

- **Lazy dispatch.** Requests fire on the first `await` / `.then()` /
  `.result()` / `.unwrap()`, not at call time. `.query()` alone dispatches
  nothing, and the descriptor's `fn()` performs a fresh request per
  invocation — TanStack Query / SWR refetches actually refetch (previously
  they replayed a permanently memoized first response).
- **`QueryDescriptor.key` shape changed** to `[method, fullUrl, inputs?]`
  where `inputs` bundles `{ params?, query?, body? }`. Keys now distinguish
  clients with different `baseUrl`s and mutations with different bodies.
  Persisted query caches invalidate once on upgrade.
- **`FetcherError.kind` grew two kinds** — now
  `'network' | 'timeout' | 'aborted' | 'validation' | 'http'`. Caller-signal
  cancellations are `'aborted'`; `timeout()`/`TimeoutError` aborts are
  `'timeout'` (both were `'network'`). Update exhaustive `switch` statements.
- **`FetcherRequestError.status` mapping changed**: request-side validation
  → 400 (was 500); response-side validation → the response's error status,
  or 502 when it was a 2xx (was 500); timeout → 408; aborted → 499.
- **`retry()` no longer retries `POST`/`PATCH` by default** — only RFC 9110
  idempotent methods (`GET`, `HEAD`, `PUT`, `DELETE`, `OPTIONS`, `TRACE`).
  Opt in via `retry: { methods: ['GET', 'POST'] }`. Also: `Retry-After` is
  capped at `maxRetryAfter` (default `maxBackoff`); fractional/negative
  `Retry-After` ignored; `attempts` clamped to ≥ 1 (`retry: 0` previously
  sent zero requests).
- **Query serialization corrected**: arrays → repeated keys (`ids=1&ids=2`,
  was comma-joined), `Date` → ISO 8601 (was locale-dependent), plain-object
  values → `validation` error (was `[object Object]`), a path already
  containing `?` merges with `&`.
- **`.result()` ordering contract**: the body clone is taken lazily on the
  first `.result()` call. Call `.result()` before native body reads; the
  reverse returns a structured error instead of working by accident.
- **A non-JSON 2xx with a declared `response` schema is validated** instead
  of silently bypassing the schema.
- **A route's declared `body` schema runs even when the body is omitted** —
  a forgotten required body is a `validation` error, not an empty request.
  Schemas for optional bodies must accept `undefined` (`fromOpenAPI` handles
  this automatically for `requestBody.required: false`).
- **`timeout()` aborts with a `TimeoutError` `DOMException`** (the old JSDoc
  claimed `AbortError`), surfacing as `kind: 'timeout'`.
- **Removed:** the deprecated `refreshEndpoint` option on `bearerWithRefresh`
  (use `exclude`); the internal OAS type-plumbing exports (`FilterKeys`,
  `MediaType`, `IsTypedCall`, `AvailablePaths`/`AvailableMethods`, the
  `Resolve*For`/`Resolve*FromPaths` family, `OpenAPIPaths`,
  `OpenAPI*Status`). The documented type surface is unchanged.

### Fixed

- URL joining: a trailing-slash `baseUrl` no longer produces `//`; a missing
  slash no longer corrupts the host; an absolute-URL path is used as-is.
- A path template whose params are omitted is a `validation` error instead
  of sending the literal `{id}`.
- `Uint8Array` (any ArrayBuffer view) and `ReadableStream` bodies pass
  through to the wire untouched (previously `JSON.stringify`'d into
  garbage); stream bodies get `duplex: 'half'`.
- The **validated output** of body/params/query schemas is what gets sent —
  Standard Schema transforms and defaults now apply to the wire.
- `application/problem+json` and other `*+json` content types parse as JSON.
- The HTTP status is never lost: malformed-JSON error bodies surface as
  `kind: 'http'` with the raw text; response-side validation errors carry
  `status`; empty error bodies keep their status.
- An empty 2xx body resolves `ok: true` with `data: undefined`; invalid
  JSON on a 2xx is a `validation` error with code `'invalid_json'`
  (both previously `kind: 'network'`).
- Lowercase `method: 'post'` hits the same route definition and validation
  as `'POST'`.
- `timeout()` no longer uses `AbortSignal.any` (broken/missing on several
  claimed runtimes; Node leak nodejs/node#54614), clears its timer on
  settle, and removes user-signal listeners — no leak with long-lived
  signals.
- `exclude` matchers match when `baseUrl` carries a path prefix and support
  OpenAPI `{param}` templates.
- `bearerWithRefresh`/`cookieAuth`: staggered 401s within one expiry burst
  reuse the fresh token/cookie instead of each triggering another refresh;
  discarded responses (retries, 401 replays) have their bodies cancelled.
- `parseSetCookie` honors deletions (`Max-Age=0` / past `Expires`, RFC
  6265bis precedence rules).
- OpenAPI runtime: operation-level `$ref`s and shared path-item `parameters`
  are resolved (routes that silently lost validation now validate); a
  `default` response is consistently the error catch-all in the runtime,
  type layer, and spec-tools; integer path/query params coerce numeric
  strings and accept `string | number` at the type level.
- Schema engine: `number()`/`integer()` reject `±Infinity`; string lengths
  count Unicode code points; `object()` accepts optional keys present as
  `undefined`; `union()` failures report the best-matching variant's issues
  with paths; `compile()` reaches refs nested anywhere;
  `transform`/`refined`/`default_` over `optional()` keep both behaviors
  inside `object()`; async schemas inside sync combinators throw `TypeError`
  instead of corrupting output; `default_` clones object/array fallbacks per
  use; format validators tightened (HTML5 email, range-checked date/time,
  flag-consistent patterns); `multipleOf` exact for large magnitudes.

### Added

- `f.head()` / `f.options()` shortcuts; `HttpMethod` includes
  `HEAD`/`OPTIONS`.
- Method shortcuts make `options` required at the type level when the route
  declares a body or the path has `{params}` — a missing body/params is a
  compile error.
- `FetcherTimeoutError` (408), `FetcherAbortError` (499),
  `FetcherNetworkError`, `FetcherValidationError`, and `FetcherHTTPError` —
  `instanceof`-narrowable subclasses thrown by `.unwrap()`.
- `querySerializer` option (global and per-call) for custom query encodings.
- `object()` gains `unknownKeys: 'passthrough' | 'strip' | 'strict'`.
- `refined()` accepts an options object `{ message, code, path }`.
- `default_()` accepts a factory function; object/array fallbacks are cloned
  per use.
- `discriminatedUnion()` supports number/boolean tags.
- `inline()` gains `onUnresolved: 'throw' | 'keep'` and throws typed
  `InlineCycleError` / `InlineUnresolvedRefError`.
- Vite plugin `fetchTimeoutMs` option for remote spec fetches.
- Zero-codegen OpenAPI inference works end-to-end: an `as const` spec +
  `fromOpenAPI` produces typed `result.data` / `body` / `error.body` at call
  sites with no codegen (`InferredRouteDefinition` slots are required when
  declared; `fromOpenAPI`'s input constraint loosened so literal specs pass).

### Packaging

- **npm is first-class**: compiled ESM + `.d.ts` (+ source maps and
  `declarationMap`) under `dist/`, validated by publint and
  arethetypeswrong in CI. JSR continues to ship raw TypeScript source.
- ESM-only; `engines.node >= 20.19`. Node 18 is EOL and no longer claimed.
- CI proves the runtime matrix: Node 20.19/22/24, Deno, and Bun run a
  conformance smoke (`scripts/smoke.mjs`) against the built artifact on
  every push; bundle-size budgets enforced by `scripts/check-size.ts`
  (tree-shaken core ~4.0 kB gzipped).
- New `SECURITY.md`: vulnerability reporting, security guarantees and their
  boundaries, and the 0.x support window (critical security fixes for 6
  months after 1.0.0).

## [0.10.0] - 2026-06-08

### Fixed
- fix: address open issues across runtime, schema, and vite plugin

## [0.9.1] - 2026-05-16

### Added
- docs: cover cookieAuth + parseSetCookie

### Fixed
- `object` schemas now propagate a member's transformed value whenever it
  differs from the input (`r.value !== obj[k]`), not only for defaulted-missing
  keys — so `transform()` on a present key is no longer dropped.

## [0.9.0] - 2026-04-24

### Added
- feat(middleware): add cookieAuth and parseSetCookie

## [0.8.0] - 2026-04-23

### Fixed
- Plugin `fetcher-env.d.ts` now references `./paths` via dynamic-import type
  syntax (`import('./paths').paths`) so the ambient `declare module` resolves
  relative paths reliably in consumers — fixes `routes`/`validators` collapsing
  to opaque `never`-typed shapes under SvelteKit and similar frameworks.

## [0.7.1] - 2026-04-23

### Added
- v0.7.1 — friction-list items 1, 2, 5, 6, 7, 10, 13, 14

## [0.7.0] - 2026-04-18

Widened `spec-tools.coverage` — anything it can statically flag is a
pre-ship win. Six new CI-grade checks. `lintSpec()` and `coverage()`
APIs are backward-compatible; `RouteCoverage` gains two new fields
(additive).

### Added

- **`lintSpec` format messages now name the builder helper** when one
  exists. `format: 'email'` → "use the `email()` builder helper from
  `@bajustone/fetcher/schema` for runtime enforcement". Formats without
  a helper get a generic message that suggests adding a `pattern`
  instead.

- **`RouteCoverage.unsupportedKeywords: string[]`** — route-level
  aggregate of keywords this route uses transitively (via `$ref`) that
  the runtime doesn't enforce. Pairs with `lintSpec`: same set, per
  route instead of per site. Useful for "which routes will silently
  accept invalid data despite the spec's constraints?"

- **`RouteCoverage.integrityIssues: IntegrityIssue[]`** — spec-integrity
  problems:
  - `discriminator_mismatch` — `oneOf` variant lacks discriminator tag
    or uses non-`const`/single-`enum` value.
  - `discriminator_duplicate` — two variants share the same tag.
  - `required_without_property` — `required` lists a key missing from
    `properties` (typo; every request will emit `missing`).
  - `unreachable_response` — response declares content in a media type
    fetcher won't consume (anything other than `application/json` or
    `*/*`).

- **`SpecCoverageReport.summary.withIntegrityIssues: number`** — route
  count with at least one integrity issue.

### Changed

- **`TIER_0_BLOCKER_KEYWORDS` rewritten** to match v0.4.0's
  `JSONSchemaToType` capabilities. `oneOf`, `anyOf`, `allOf` removed —
  the converter handles them natively via union/intersection. Added:
  `propertyNames`, `if`, `then`, `else`, `dependentSchemas`,
  `dependentRequired`. `patternProperties` and `prefixItems` retained.

  **Migration:** routes that previously fell back because of
  `oneOf`/`anyOf`/`allOf` will now be reported as fully typed. This is
  a more accurate reflection of what the inference path actually does.
  No changes needed unless CI gates were relying on the false negative.

### Bundle impact

- Core unchanged.
- `./spec-tools`: ~2.3 → ~2.9 KB gz (~600 B for the four new walkers).
- `./schema` and `./openapi` unchanged.

## [0.6.0] - 2026-04-18

Adds post-validation transforms. Non-breaking.

### Added

- `transform(schema, ...fns)` — runs plain transform functions in
  sequence on the validated value. Base schema runs first; on success,
  each subsequent function receives the previous step's output. On
  validation failure, transforms are skipped and issues propagate.

  Type-safe variadic with 6 overloads covering 1–6 transform functions
  per call. For more, nest transforms.

  ```ts
  const YearFromISO = transform(
    string({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
    (s) => new Date(s),
    (d) => d.getFullYear(),
  );
  // Infer<typeof YearFromISO> = number
  ```

  Wire data is validated literally before any transform runs — the
  "validate wire as-is" principle holds. Transforms only reshape the
  successfully-validated output.

  Composes with `refined` (for post-transform validation) and
  `default_` (for undefined-only fallback) via nesting. No curry, no
  action infrastructure — just plain functions.

### Changed

- "Intentionally out of scope" docs updated: pre-validation transforms
  (`.preprocess`, `.coerce`) and error-swallowing (`.catch`) remain out.
  `.transform` / `.pipe` are now in via this single `transform` function.

### Bundle impact

- Core and other subpaths unchanged.
- `./schema` wholesale: ~3.4 → ~3.5 KB gz (~60 B gz).

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
