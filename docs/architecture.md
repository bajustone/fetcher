# Architecture

## Overview

`@bajustone/fetcher` is a schema-validated, typed fetch client. It wraps the native `fetch` API — returning a real `Response` object — and extends it with a `.result()` method that provides typed, schema-validated data. It supports OpenAPI specs, manual schemas (Zod, Valibot, ArkType), and ad-hoc per-call schemas.

## Design Principles

1. **100% native fetch** — The returned object is a real `Response`. All native methods (`.json()`, `.text()`, `.blob()`, `.headers`, `.status`) work as expected.
2. **Standard Schema V1** — Any schema implementing the [Standard Schema V1](https://standardschema.dev) spec (Zod 3.24+, Valibot, ArkType, the bundled schema builder under `./schema`, or any value with a `~standard.validate` property) works out of the box.
3. **Zero runtime deps** — Ships a native schema builder and a raw-JSON-Schema bridge. No external dependencies.
4. **Subpath-split for bundle discipline** — The tree-shaken core is ~4.0 KB gzipped (it grew from ~2.7 KB deliberately in the 1.0 hardening pass — lazy dispatch, real query serialization, abort/timeout classification, status-preserving response handling). OpenAPI, dev-time spec tools, and the schema builder live in opt-in subpaths. Budgets are CI-enforced by `scripts/check-size.ts`.
5. **Never throws** — `.result()` catches errors and returns them in a discriminated union. Transport failures, timeouts, caller aborts, validation errors, and HTTP errors are all surfaced via `{ error }`.
6. **Lazy dispatch** — The request fires on first consumption of the promise, never at call time, which is what makes `.query()` descriptors honest and prevents unhandled rejections on promises nobody consumed.
7. **Framework-compatible** — Accepts a custom `fetch` function per-call (e.g., SvelteKit's load `fetch`) or globally via config.

## Three Modes

### Mode 1: OpenAPI (hybrid type/runtime workflow)

```typescript
import { api } from '$lib/api'; // user-created client using routes from virtual:fetcher

const result = await api.get('/pets/{petId}', { params: { petId: '42' } }).result();
if (result.ok) {
  result.data.id   // typed: number
  result.data.name // typed: string
}
```

Two pieces compose to produce this result:

1. **Runtime validators** — `fromOpenAPI(spec)` (from `@bajustone/fetcher/openapi`) parses an OpenAPI 3.x spec, resolves `$ref` pointers (including operation-level `$ref`s on `requestBody`/`responses`/`parameters` and shared path-item-level `parameters`), and produces pre-compiled validators for every route's body / params / query / response / errorResponse. Under the hood it calls `fromJSONSchema` which dispatches each JSON Schema node to the native builder's factory primitives. Integer/number path and query parameters get numeric-string coercion (marked via the `x-fetcher-coerce` vendor extension in extracted schemas).
2. **Type inference** — either an `openapi-typescript`-generated `paths` interface passed as the `OAS` generic on `createFetch<paths>(...)`, **or** — for narrowly-typed specs — the zero-codegen walker (`InferRoutesFromSpec` + `JSONSchemaToType`) that infers types directly from the spec literal. Both drive static types for body, response, and error bodies via helper types in `src/types.ts`.

Types and runtime validation are **decoupled by design** — see "Hybrid type/runtime workflow" below.

#### What composes when you supply `<paths>`

`createFetch<paths>(...)` walks the generated `paths` interface via internal helper types in `src/types.ts`:

- **Path keys** — autocomplete from the keys of the generated `paths` interface.
- **Body type** — extracted from `paths[Path][Method]['requestBody']['content'][<json media type>]`.
- **Success response type** — extracted from `paths[Path][Method]['responses'][2xx]['content'][<json media type>]`, matched over the numeric 200–206 statuses plus the `'2XX'`/`'2xx'` wildcards.
- **Error response type** — extracted from the 4xx/5xx statuses, the `'4XX'`/`'5XX'` wildcards, and `'default'`. **`'default'` is treated as the catch-all error (not success)** — matching OpenAPI convention, the runtime extractor, and `lintSpec`.
- **Path parameters** — derived from `parameters.path` when declared, falling back to the path template via `ExtractPathParams<P>`; template params accept `string | number` (numeric params are coerced at runtime).

When `<paths>` is not supplied, behavior falls back to `Routes`-based inference — `data` and `error.body` come back as `unknown` unless the route declares schemas. The per-call `responseSchema:` escape hatch always works regardless of which mode is active.

An internal `IsTypedCall` switch selects between the typed and untyped option shapes per call site; unified `Resolve*For` resolvers prefer OAS when supplied, falling back to Routes. As of 1.0 these plumbing types are **internal** — they no longer ship from the package root (see the migration guide). The supported wrapper-typing surface is `Routes`, `Schema`, the `Infer*` family, `PathsToRoutes`, `SchemaOf`, `ExtractPathParams`, and `MethodShortcutFn`.

The executable spec of what flows through is in `tests/types/openapi-paths-inference.test-d.ts` (hand-rolled cases), `tests/openapi-paths-workflow.test.ts` (cases against real `openapi-typescript` output for `tests/fixtures/petstore.json`), and `tests/types/spec-infer.test-d.ts` (zero-codegen call-site inference).

#### Hybrid type/runtime workflow

Types come from `openapi-typescript` codegen (or the zero-codegen walker). Runtime validators come from `fromOpenAPI(spec)`. Two derivations from one source of truth (`openapi.json`).

This split is deliberate:

- **The codegen type story doesn't depend on TypeScript's conditional-type performance budget.** The zero-codegen path trades compile time for setup simplicity, so large specs should keep using codegen.
- **Runtime story doesn't depend on `openapi-typescript`'s release schedule.** The runtime validator subset is small, deliberate, and stable. Validation happens against the actual spec at startup, so spec changes are picked up immediately even if `paths.d.ts` is stale.
- **The two derivations can be checked against each other.** `lintSpec(spec)` walks the spec and reports keywords the runtime validator doesn't enforce but `openapi-typescript` renders as types.

#### Validator/type drift

The runtime validator enforces a deliberately small subset (see the supported-keyword table below). `openapi-typescript` may render features the runtime ignores. Where the two diverge, the type is stricter than the runtime. Examples:

- `format: 'email'` → types as `string`, runtime accepts any string (unless the spec uses a format helper that pairs `format` with an enforcing `pattern`).
- `multipleOf` / `exclusiveMinimum` / `exclusiveMaximum` → ignored at runtime (the *builder's* own `number()`/`integer()` enforce them; spec-sourced validators do not).
- `patternProperties` / `propertyNames` / `additionalProperties` (sub-schema form) → unenforced.
- `if` / `then` / `else`, `dependentSchemas`, `dependentRequired` → unenforced.
- `not`, `uniqueItems`, `minProperties` / `maxProperties`, `contains` / `minContains` / `maxContains`, `unevaluatedProperties` / `unevaluatedItems`, `contentMediaType` / `contentEncoding` / `contentSchema`, `$dynamicRef` → unenforced (all flagged by `lintSpec`).
- `prefixItems`, positional `items` (tuple arrays) → every element checked against the first schema.
- External `$ref`, `$id`, `$schema`, `$anchor` / `$dynamicAnchor` → unsupported / accepted-but-unused.
- Recursive `$ref` → **supported**, via lazy binding in `compile(schema, defs)`; the first resolution is cached on the ref's closure. Self-references terminate on input depth.

`lintSpec(spec)` (from `@bajustone/fetcher/spec-tools`) returns one `SpecDriftIssue` per drift point with an RFC 6901 JSON pointer, the unsupported keyword, a `'warn'` / `'info'` severity, and a message. Run from CI to fail builds on silent drift.

#### Zero-codegen inference (for narrow specs)

`JSONSchemaToType<Schema, Defs>` (in `src/infer-spec.ts`) converts a JSON Schema literal type into the TypeScript type of conforming values, and `InferRoutesFromSpec<S>` walks a spec's paths into a typed `Routes` shape. As of the 1.0 hardening pass **this is a working, call-site-complete flow**, not an aspiration: `createFetch({ routes: fromOpenAPI(spec) })` on an `as const` spec produces typed `result.data`, typed `body`, and typed `error.body` at call sites with no codegen step.

The pieces that make it work:

- `InferredRouteDefinition<Op, Defs>` produces route slots that are **required properties when the spec declares them** (and explicitly absent otherwise). This matters because the call-site resolvers match non-optional properties (`R[P][M] extends { response: Schema<infer T> }`) — an all-optional shape would silently collapse to `unknown`.
- `BodySlot` honors `requestBody.required`: `required: true` → a required `body` at the call site (missing body = compile error); optional → optional `body`.
- `SuccessJsonSchemaOf` / `ErrorJsonSchemaOf` mirror the runtime exactly: any `2…` status key is a success candidate, explicit `4xx`/`5xx` keys are errors, and **`default` is the error catch-all fallback, never a success schema** — the same convention as the runtime extractor and the `<paths>` type layer.
- `fromOpenAPI`'s input constraint is deliberately loose (`any`-valued `paths` / `components.schemas` index signatures), so both widened JSON imports and `as const` literals (whose `readonly` tuples don't assign to mutable arrays) pass without a cast. A failed constraint here would silently collapse inference to `unknown`.

Why not always use this path? Because a plain `import spec from './openapi.json'` widens string literals — TypeScript's `resolveJsonModule` / `with { type: 'json' }` both widen ([microsoft/TypeScript#27913](https://github.com/Microsoft/TypeScript/issues/27913); preservation proposal open at [#32063](https://github.com/microsoft/TypeScript/issues/32063)). Once widened, `type: 'integer'` becomes `type: string` and the spec-walker collapses to `unknown`. So the zero-codegen path requires the spec to live in a `.ts` file with `as const` (fine for small specs and prototypes), while large specs should stay on `openapi-typescript` codegen — mature, handles every edge case (recursive `$ref`, conditional schemas), and keeps TypeScript's conditional-type performance budget in check.

If TypeScript ever ships [#32063](https://github.com/microsoft/TypeScript/issues/32063), the widening limitation goes away and the zero-codegen path becomes viable for arbitrary JSON-imported specs too.

### Mode 2: Manual Route Schemas

```typescript
import { object, string } from '@bajustone/fetcher/schema';

const f = createFetch({
  baseUrl: 'https://api.example.com',
  routes: {
    '/auth/login': {
      POST: {
        body: object({ email: string(), password: string() }),
        response: object({ token: string() }),
      },
    },
  },
});
```

Define routes with any Standard Schema V1 schema library — the bundled `@bajustone/fetcher/schema` builder, Zod 3.24+, Valibot, ArkType, or anything with `~standard.validate`. Types are inferred from the schemas via `ResolveBody` / `ResolveResponse` / `ResolveErrorResponse`.

### Mode 3: Ad-hoc Per-Call Schema

```typescript
const f = createFetch({ baseUrl: 'https://api.example.com' });
const result = await f('/endpoint', { method: 'GET', responseSchema: mySchema }).result();
```

Pass a schema on any individual call. The per-call `responseSchema` wins over the route's declared `response` via `ResolveAdHocResponse`.

## Response Model

The fetch function returns a `TypedFetchPromise` — a *lazy* `Promise<TypedResponse>` augmented with `.result()`, `.unwrap()`, and `.query()` shorthands:

```typescript
// One-liner: .result() on the promise
const result = await f.post('/auth/login', { body: { ... } }).result();
if (result.ok) {
  // result.data: T
} else {
  switch (result.error.kind) {
    case 'network':    /* result.error.cause */    break
    case 'timeout':    /* result.error.cause */    break
    case 'aborted':    /* result.error.cause */    break
    case 'validation': /* result.error.location, result.error.issues, result.error.status? */ break
    case 'http':       /* result.error.status, result.error.body */     break
  }
}

// Two-liner: when you need the intermediate Response
const response = await f.post('/auth/login', { body: { ... } });
response.ok        // boolean
response.status    // number
const result2 = await response.result();
```

### Laziness

`fetchFn` does not call `rawFetchFn` eagerly. It returns a thenable whose `then`/`catch`/`finally`/`.result()`/`.unwrap()` all funnel through a memoized `start()` — the request is dispatched exactly once, on first consumption. Consequences:

- `.query()` fires **nothing**; it builds `{ key, fn }` synchronously. `fn()` invokes `fetchFn` again, so every call is a **fresh request** — cache refetches actually refetch (pre-1.0, `fn` replayed a permanently memoized first response).
- A constructed-but-never-consumed call can never become an unhandled rejection.

### The five-kind error model

`.result()` is like `.json()` but:
- Parses JSON and validates against the schema.
- Returns `{ ok: true; data: T } | { ok: false; error: FetcherError<HttpErrorBody> }`.
- Never throws — every failure path collapses into one of five `error.kind`s: `'network'`, `'timeout'`, `'aborted'`, `'validation'`, `'http'`.
- Is **idempotent**: calling `.result()` more than once returns the same cached result.

Transport-level rejections are classified by `classifyTransportError(cause, userSignal)` in `src/fetcher.ts`. Order matters: the caller's own aborted signal wins (`'aborted'` — the abort reason can be any value, so the signal check, not the error name, is authoritative), then a `TimeoutError` name (`'timeout'` — what the `timeout()` middleware and `AbortSignal.timeout` produce), then `AbortError` (`'aborted'`), then everything else (`'network'`).

`.unwrap()` maps the union onto an error-class family via `toRequestError`: `FetcherNetworkError`, `FetcherTimeoutError`, `FetcherAbortError`, `FetcherValidationError`, `FetcherHTTPError`, all extending `FetcherRequestError`. The base class carries `.status`, computed by `deriveStatus`: `http` → the response status; request-side validation → 400; response-side validation → the response's error status or 502 when it was a 2xx; timeout → 408; aborted → 499; network → 500.

### Mixing `.result()` with native body methods

The body clone backing `.result()` is taken **lazily, on the first `.result()` call** — a response whose `.result()` you never use (status-only checks, streaming consumers) never buffers a second copy of the body in memory.

That laziness makes ordering part of the contract:

- `.result()` first, then `.json()`/`.text()`: works — the clone leaves the original stream untouched.
- Native read first, then `.result()`: returns a **structured error** (`kind: 'network'` carrying a `TypeError`). A `bodyUsed` guard makes this failure deterministic; some runtimes would otherwise let `clone()` succeed after a native read but hand back an empty body, silently masquerading as a bodiless response.

The clone is *not* taken on the synthetic response returned by client-side validation failures or transport rejections — those carry a precomputed error directly and have no body to read.

## Module Structure

```
src/
├── index.ts                  # Core barrel: createFetch, middleware, error classes, types (subpath `.`)
├── types.ts                  # Public + internal type definitions
├── fetcher.ts                # createFetch, lazy promise, error classes, transport classification
├── middleware.ts             # Middleware executor + built-ins (auth, retry, timeout, parseSetCookie)
├── with-input-type.ts        # withInputType — covariant input-generic re-tagging
├── infer-spec.ts             # JSONSchemaToType + InferredRouteDefinition (zero-codegen type walker)
├── from-json-schema.ts       # Raw JSON Schema → builder dispatcher (subpath `./openapi`)
├── inline.ts                 # $ref dereferencer + Inline*Error classes (subpath `./openapi`)
├── json-schema-types.ts      # Shared JSONSchemaDefinition type
├── openapi.ts                # fromOpenAPI + extraction/bundling helpers (subpath `./openapi`)
├── spec-tools.ts             # lintSpec + coverage (subpath `./spec-tools`)
├── vite-plugin.ts            # Rollup/Vite plugin (subpath `./vite`)
├── openapi/index.ts          # Barrel for `./openapi`
├── spec-tools/index.ts       # Barrel for `./spec-tools`
└── schema/                   # Native schema builder (subpath `./schema`)
    ├── types.ts              # FSchema, wrappers, options interfaces, Infer
    ├── primitives.ts         # string, number, integer, boolean, null_, literal, …
    ├── composites.ts         # object (unknownKeys), array, optional, nullable, union, intersect, enum_
    ├── composition.ts        # partial, required, pick, omit, extend, extendSchema, merge, keyof_
    ├── record-tuple.ts       # record, tuple
    ├── refinements.ts        # refined, default_
    ├── transform.ts          # transform (post-validation pipeline)
    ├── wrap.ts               # INTERNAL wrapper protocol shared by refined/transform/default_
    ├── container.ts          # INTERNAL shared member-collection helpers (zero-copy outputs)
    ├── discriminated.ts      # discriminatedUnion (O(1) tagged dispatch)
    ├── refs.ts               # ref, compile (lazy $ref binding, cycle-safe)
    ├── formats.ts            # email, url, uuid, datetime, date, time
    ├── meta.ts               # brand, describe, title
    ├── parse.ts              # parse, parseOrThrow, parseForm, groupIssuesByField
    ├── format-issues.ts      # formatIssues display helper
    └── index.ts              # Barrel

scripts/
├── check-size.ts             # CI bundle-size budgets (guards the README's size claims)
├── smoke.mjs                 # Cross-runtime conformance smoke (Node 20.19/22/24, Deno, Bun in CI)
└── changelog.ts              # Release changelog generator

tsconfig.build.json           # npm dist build: declaration + maps, rewriteRelativeImportExtensions
```

### Packaging: two artifacts from one source

- **npm** ships compiled ESM + `.d.ts` (with `sourceMap` and `declarationMap` for go-to-definition) under `dist/`, built by `tsc -p tsconfig.build.json`. Source files import with explicit `.ts` extensions (JSR style); `rewriteRelativeImportExtensions` (TypeScript ≥ 5.7) rewrites them to `.js` in the output so the dist is standards-compliant ESM. `publint` and `arethetypeswrong` validate the package shape in CI.
- **JSR** ships the raw TypeScript source as-is.
- ESM-only; `engines.node >= 20.19`. The CI conformance smoke (`scripts/smoke.mjs`) runs the **built artifact** against a real local HTTP server on Node 20.19/22/24, Deno, and Bun on every push — the runtime matrix is proven, not claimed.

### types.ts
- `Schema<T>` — aliases `StandardSchemaV1<unknown, T>`.
- `TypedResponse<T, E>` — `Response` + `.result()`.
- `TypedFetchPromise<T, E>` — lazy `Promise<TypedResponse<T, E>>` + `.result()`, `.unwrap()`, and `.query()` shorthands on the promise itself.
- `ResultData<T, E>` — discriminated union returned by `.result()`.
- `FetcherError<HttpBody>` — the five-kind error union; response-side validation errors carry `status`.
- `QueryDescriptor<T>` — `{ key, fn }` returned by `.query()`.
- `RouteDefinition` — per-method schema config (body, params, query, response, errorResponse).
- `Routes` — path → method → RouteDefinition mapping. `HttpMethod` includes `HEAD` and `OPTIONS`.
- `SchemaOf<Components, Name>` — extracts a named schema from an `openapi-typescript`-generated `components` interface.
- `FetchConfig` — includes `getHeaders` (per-request dynamic headers, precedence `defaultHeaders` → `getHeaders()` → per-call) and `querySerializer`.
- **OpenAPI `<paths>` inference helpers** — `FilterKeys`, `MediaType`, `OpenAPI*Status`, the `Resolve*FromPaths`/`Resolve*For` resolvers, and the `IsTypedCall`/`AvailablePaths`/`AvailableMethods` routing helpers. As of 1.0 these are **internal** (not exported from the package root).
- `TypedFetchFn<R, OAS>` — the typed fetch function interface. `R` is the routes table; `OAS` (optional) is the `openapi-typescript` `paths` interface.
- Exported type-level helpers: `ExtractPathParams`, `InferRoutesFromSpec`, `InferOutput`, `InferSchema`, `PathsToRoutes`, `MethodShortcutFn`, `QuerySerializer`.

### fetcher.ts
- `createFetch<OAS, R>(config)` — factory returning a `TypedFetchFn<R, OAS>`.
- `rawFetchFn` — async function handling validation (validated **output** goes on the wire; a declared `body` schema runs even when the body is omitted), URL joining (`joinUrl`: exactly one slash at the seam; absolute-URL paths bypass `baseUrl`), path interpolation (missing params → precomputed validation error, never a literal `{id}` on the wire), query serialization (`serializeQuery`: repeated keys for arrays, ISO 8601 for `Date`, plain objects rejected, custom `QuerySerializer` override), header assembly (`defaultHeaders` → `getHeaders()` → per-call), body serialization (binary/stream passthrough with `duplex: 'half'`; JSON otherwise), middleware chain execution, transport-error classification, and response wrapping.
- `fetchFn` — wraps `rawFetchFn` in the **lazy** thenable described above, attaching `.result()`, `.unwrap()`, `.query()`.
- Method shortcuts (`.get`, `.post`, `.put`, `.delete`, `.patch`, `.head`, `.options`) delegate to `fetchFn`. Lowercase `method:` strings are normalized to uppercase before route lookup.
- `.with(overrides)` — forks the client with shallow-merged config, preserving both `R` and `OAS` generics.
- `wrapResponse` / `computeResult` — attach the lazy-cloning, idempotent `.result()`; `computeResult` implements the response semantics (`*+json` detection, status-preserving error parsing, empty-2xx handling, non-JSON-with-schema validation).
- `classifyTransportError` / `deriveStatus` / `toRequestError` — the error-model plumbing described under "Response Model".
- `FetcherRequestError` + `FetcherNetworkError` / `FetcherTimeoutError` / `FetcherAbortError` / `FetcherValidationError` / `FetcherHTTPError` — the `.unwrap()` class family.
- `extractErrorMessage(error)` — standalone utility covering all five kinds.
- `buildQueryKey(method, url, params?, query?, body?)` — internal helper producing the `.query()` key: `[method, fullUrl, inputs?]`, where `inputs` bundles whichever of `{ params, query, body }` were supplied (with `undefined`/`null` query entries filtered). Keys distinguish clients with different `baseUrl`s and mutations with different bodies.

#### Three promise-level shorthands

| Method | Returns | Throws? | Use case |
|--------|---------|---------|----------|
| `.result()` | `ResultData<T>` | Never | Fine-grained error handling, partial success |
| `.unwrap()` | `T` | `FetcherRequestError` subclass | Server load functions, remote functions, server actions |
| `.query()` | `QueryDescriptor<T>` | `fn()` throws | TanStack Query, SWR, Pinia Colada, any `{ key, fn }` cache |

`.query()` is synchronous and dispatches nothing; `fn()` is a fresh request per invocation. The key is `[method, fullUrl, { params?, query?, body? }?]`, deterministic and compatible with TanStack Query's array keys.

### schema/ — native schema builder

Produces plain JSON Schema objects augmented with a pre-compiled `~standard.validate` closure at construction time. No runtime interpreter. Each factory is `/*@__NO_SIDE_EFFECTS__*/`-annotated so bundlers eliminate any factory whose result is never used.

- **Primitives:** `string`, `number`, `integer`, `boolean`, `null_`, `literal`, `unknown`, `undefined_`, `any_`, `never_`, `bigint_`. Numbers reject `NaN` and `±Infinity` (wire data; JSON can't represent them). String length counts Unicode code points. `multipleOf` is exact for large magnitudes.
- **Number convenience:** `positive`, `nonnegative`, `negative`, `nonpositive`, `finite`, `safe`.
- **Composites:** `object`, `array`, `optional`, `nullable`, `union`, `intersect`, `enum_`, `record`, `tuple`. `object()` takes `unknownKeys: 'passthrough' | 'strip' | 'strict'` (default `'passthrough'` — the zero-copy JSON Schema default); optional keys present with value `undefined` are treated as missing. `union()` failures report a `no_variant_matched` summary plus the best-matching variant's issues with paths intact.
- **Object composition:** `partial`, `required`, `pick`, `omit`, `extend`, `extendSchema` (for opaque `FSchema<T>` bases like `validators.*`), `merge`, `keyof_` — rebuild object shapes without re-typing properties; `default_` wrappers survive composition via the internal `~defaults` registry.
- **Predicates, defaults & transforms:** `refined(schema, predicate, messageOrOptions?)` runs a custom check after base validation (options: `message`, `code`, `path` for cross-field attribution); `default_(schema, fallbackOrFactory)` substitutes a fallback for `undefined`/missing keys — function fallbacks are per-use factories, object/array fallbacks are `structuredClone`d per use; `transform(schema, ...fns)` runs plain functions on the validated value (a throwing transform yields a `transform_error` issue). Wire data is still verified literally — only post-validation output is reshaped.
- **wrap.ts (internal):** the wrapper protocol shared by `refined`/`transform`/`default_`. Wrappers used to be built with a bare `...schema` spread, which leaked an inner `optional()`'s markers onto the outer wrapper — `object()` then compiled the property validator from the *inner* schema, silently discarding the refinement/transform — and broke `compile()`'s identity-keyed ref binding. The protocol (`schemaMeta` / `wrapperBase` / `emissionTarget`) emits the wire-shape JSON Schema, deliberately re-asserts `~optional`/`~default` markers so `object()` keeps *both* behaviors, and threads `~inner` so the ref walker reaches wrapped refs. Async schemas nested inside sync combinators throw a `TypeError` (`ensureSync`) instead of silently corrupting output.
- **Discriminated union:** `discriminatedUnion(key, mapping)` — O(1) dispatch by tag; string, number, and boolean tags dispatch by their string form; missing tag → `missing_discriminator`, unmapped tag → `unknown_discriminator`, both with `path: [key]`.
- **Refs:** `ref(name)` + `compile(schema, defs)` — lazy binding, cycle-safe. The walker reaches refs nested anywhere: defs targets, record values, tuple members, wrapper-enclosed refs.
- **Formats:** `email` (WHATWG HTML5 grammar — linear-time, ReDoS-safe), `url`, `uuid` (RFC 9562 v1–8 + nil/max), `datetime`/`date`/`time` (RFC 3339 shapes with field range checks) — each emits both `format` and an enforcing `pattern`; all regexes are flag-free so emitted pattern === runtime behavior.
- **Meta:** `brand<B>()(schema)` for nominal typing; `describe(schema, text)` / `title(schema, text)` for JSON Schema annotations (both preserve `compile()` ref-binding via `~inner`).
- **Errors:** `formatIssues(issues, opts?)` for flat display; every builder-emitted issue carries a stable snake_case `code`.
- **Parsing:** `parse` (never throws), `parseOrThrow` (throws `SchemaValidationError`), `parseForm` (field-keyed errors map for form libraries), `groupIssuesByField` (the bare issues → `Record<field, message>` transform). Standalone functions (not methods) — preserves per-factory tree-shaking.

Each schema satisfies `StandardSchemaV1<unknown, T>` structurally, so it drops directly into any `RouteDefinition` slot. Inference via `Infer<typeof Pet>`.

#### Supported keyword subset

| Category | Keywords emitted + enforced |
|---|---|
| Type | `type` (`object`, `array`, `string`, `number`, `integer`, `boolean`, `null`) |
| Object | `properties`, `required`, `additionalProperties` (for `record`; `false` for `unknownKeys: 'strict'`) |
| Array | `items`, `minItems`, `maxItems`, `prefixItems` (for `tuple`) |
| String | `minLength`, `maxLength`, `pattern`, `format` (via helpers); non-standard: `startsWith`/`endsWith`/`includes` applied at validation time |
| Number / integer | `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf` |
| Enum | `enum`, `const` |
| Composition | `anyOf`, `allOf`, `oneOf` + `discriminator` |
| Refs | `$ref` against a compiled `defs` map |
| Meta | `title`, `description`, `default` (annotation emitted by value-form `default_`) |

**Not exposed (intentionally), and flagged by `lintSpec` when a spec uses them:** `patternProperties`, `propertyNames`, `additionalProperties` (sub-schema form), `if`/`then`/`else`, `dependentSchemas`, `dependentRequired`, `not`, `uniqueItems`, `minProperties`/`maxProperties`, `contains`/`minContains`/`maxContains`, `unevaluatedProperties`/`unevaluatedItems`, `contentMediaType`/`contentEncoding`/`contentSchema`, `additionalItems`, `$dynamicRef` (plus accepted-but-unused `$anchor`/`$dynamicAnchor`/`$id`/`$schema`), and all pre-validation transform/coerce/catch features — out of scope per the "validate wire data as-is" principle. The authoritative list lives in `UNSUPPORTED_KEYWORDS` in `src/spec-tools.ts`.

### infer-spec.ts

Type-level only (ships no runtime code). `JSONSchemaToType<S, Defs>` handles the same subset the runtime enforces: primitives, `array`/`object` (with `required` mapping and `additionalProperties` index signatures), `enum`/`const`, `anyOf`/`oneOf` → union, `allOf` → intersection, OpenAPI 3.0 `nullable: true`, 3.1 type arrays, and `$ref` against `components.schemas` / `$defs`. Returns `unknown` for shapes outside the subset so users aren't forced into a lie. `InferredRouteDefinition` is the per-operation route shape described under "Zero-codegen inference".

### from-json-schema.ts

`fromJSONSchema<T>(schema, defs?)` — converts a raw JSON Schema object (plus optional `$defs` / component map) into a compiled builder schema. Dispatches each keyword to the native builder's factories. Used by `fromOpenAPI` and the Vite plugin's generated code as the bridge from spec-authored JSON to runtime validators. Honors the `x-fetcher-optional` (optional request body accepts `undefined`) and `x-fetcher-coerce` (numeric-string coercion for path/query params) vendor markers.

### openapi.ts
- `fromOpenAPI<const Spec>(spec)` — generic over the literal spec type. Converts an OpenAPI 3.x JSON spec into `Routes`, narrowed to the spec's actual paths and methods via `InferRoutesFromSpec`.
- Resolves `$ref` pointers — including **operation-level** `$ref`s (`requestBody`, individual `responses`, individual `parameters`) and **path-item-level shared `parameters`** — so routes that previously lost runtime validation silently now validate.
- A `default` response is consistently the **error catch-all** (feeds `errorResponse`, never `response`) — matching the type layer and `lintSpec`.
- Optional request bodies (the OpenAPI default, `requestBody.required: false`) produce validators that accept `undefined`; integer/number path and query parameters coerce numeric strings.
- Body / response / errorResponse *type* inference flows from the optional `<paths>` generic on `createFetch` or the zero-codegen walker — `fromOpenAPI` owns only the runtime validators.

### inline.ts
- `inline(schema, options?)` — substitutes every local `#/$defs/X` ref with its resolved target; returns a frozen, self-contained schema, memoized by input identity per `onUnresolved` mode.
- Sibling keywords next to `$ref` (legal in 2020-12 / OpenAPI 3.1) shallow-merge over the target, siblings winning.
- `InlineCycleError` on cyclic refs (recursive schemas cannot be flattened); `InlineUnresolvedRefError` (default `onUnresolved: 'throw'`) on refs that aren't resolvable `#/$defs/X` pointers — so the "no remaining refs" guarantee actually holds. `{ onUnresolved: 'keep' }` leaves such refs in place for ref-aware downstream consumers.

### spec-tools.ts
- `lintSpec(spec)` — walks an OpenAPI 3.x spec and returns one `SpecDriftIssue` per keyword the runtime validator doesn't enforce (the `UNSUPPORTED_KEYWORDS` table — see the "Not exposed" list above). For `format` drift, names the matching builder helper (`email()`, `url()`, etc.) when one exists.
- `coverage(spec)` — walks the spec and returns a `SpecCoverageReport`. Per route: `fallbackReasons` (schema features `JSONSchemaToType` can't infer), `unsupportedKeywords` (route-level aggregate), `integrityIssues` (discriminator mismatches/duplicates, `required` keys without matching properties, response content in media types fetcher won't consume — anything other than `application/json`, `application/*+json`, or `*/*`).
- Zero runtime dependencies. Intended as CI gates.

### vite-plugin.ts
- `fetcherPlugin(options)` — Rollup/Vite plugin, exported as `@bajustone/fetcher/vite`. Returns `any` to avoid requiring `vite` as a peer dependency.
- **Options:** `spec` (path to OpenAPI JSON), `output?` (directory for generated files), `url?` (remote URL to fetch the spec from — downloaded to a cache file, the user's `spec` file is never overwritten; falls back cache → local file on failure), `fetchTimeoutMs?` (abort the remote fetch, default 30 s, same fallback chain), `components?` (`'inline'` default | `false` to ship only `routes`).
- **Rollup hooks:** `buildStart` (async — uses the `openapi-typescript` programmatic API to generate `paths.d.ts`, appends a `Schema<Name>` helper if `components` exist, emits `fetcher-env.d.ts`), `resolveId` + `load` (virtual modules `virtual:fetcher` and `virtual:fetcher/inlined`).
- **Virtual module design:** exports `routes` (not a pre-built client) plus `schemas`/`validators` component exports. The user imports `routes` and passes them to `createFetch` with their own middleware, baseUrl, and config — the industry pattern (openapi-fetch, zodios, Hono RPC) of separating schema generation from client construction. The `/inlined` flavor ships build-time-flattened schemas; cyclic components become throwing getters with an actionable message.
- **Vite-specific hook:** `configureServer` (watches the spec file, regenerates on change, invalidates the virtual modules, triggers full reload).
- Dynamically imports `openapi-typescript` — it must be installed in the user's project as a devDependency. Supports both v7+ (AST-based, uses `astToString`) and earlier versions (string output). Clear error if not importable.
- `fetcher-env.d.ts` declares the virtual module types via dynamic-import type syntax (`import('./paths').paths`) — no fragile relative `declare module` imports.

### middleware.ts
- `Middleware` — `(request, next) => Promise<Response>`. `next` accepts an optional `Request` argument for replay.
- `executeMiddleware` — recursive dispatcher. Calling `next` more than once re-runs every downstream middleware and the final fetch.
- Built-in middlewares:
  - `authBearer(getToken)` — attaches `Authorization: Bearer <token>`.
  - `bearerWithRefresh<Paths>(opts)` — bearer auth + 401-refresh-retry. Refresh dedup is **generation-based**: truly concurrent 401s share one in-flight refresh promise, and a *staggered* 401 whose stale token has already been superseded reuses the freshly refreshed token instead of spawning another refresh. The `exclude` field is typed against the `Paths` generic for autocomplete and compile-time typo checking. (The deprecated `refreshEndpoint` option was removed in 1.0 — use `exclude`.)
  - `cookieAuth<Paths>(opts)` — cookie-based session auth for server-side runtimes. Single `login: () => Promise<string>` callback drives lazy initial login, optional proactive refresh (`refreshAfterMs`), and reactive 401-driven re-login. Closure-owned state (`cookie`, `lastLoginAt`, `inFlight`) plus a **generation counter** giving it the same staggered-401 protection as `bearerWithRefresh`: a 401 sent under an old generation reuses the cookie a newer login already produced. The login endpoint must be excluded or the middleware deadlocks on its own 401. No separate `cookieWithRefresh` is shipped: cookie auth has no access/refresh-token split, so the unified single-callback shape is more honest.
  - `timeout(ms)` — manual composite abort: a plain `AbortController` driven by a timer plus a forwarded user-signal listener — **not** `AbortSignal.any()`, which is missing on Node < 20.3 / Safari < 17.4 and has open memory-leak issues with long-lived parent signals on Node (nodejs/node#54614). On expiry it aborts with a `TimeoutError` `DOMException` → `kind: 'timeout'`; the user's own abort forwards their reason → `kind: 'aborted'`. The timer is cleared and the listener removed the moment the request settles. Chain order is retry → timeout → user middleware, so **each retry attempt gets a fresh timeout window**, while an auth middleware's 401 replay shares the original window.
  - `retry(opts)` — re-invokes the chain on retryable failures. **Method-gated**: only the RFC 9110 §9.2.2 idempotent methods (`GET`, `HEAD`, `PUT`, `DELETE`, `OPTIONS`, `TRACE`) are retried by default; `POST`/`PATCH` require explicit opt-in via `methods` (a network-failed POST may already have been applied server-side). Non-eligible methods pass straight through with no retry semantics. Configurable status set (default 408/425/429/5xx subset), exponential backoff with ±25% jitter, `Retry-After` honored in both delay-seconds (strict `1*DIGIT` — fractional/negative ignored per RFC 9110) and HTTP-date forms, capped at `maxRetryAfter` (default `maxBackoff`). `attempts` is clamped to ≥ 1. The request is `clone()`d per attempt; discarded responses have their bodies cancelled so connections aren't pinned during backoff. User-signal aborts are never retried.
- Exclude matching (`matchesExclude` / `matchPathname`, shared by both auth middlewares): a `string` entry matches the request pathname exactly, **or** as a suffix at a `/` segment boundary (so excludes written against route-table keys keep working when `baseUrl` carries a path prefix — `/auth/login` matches `/api/v1/auth/login` but not `/oauth/login`), and OpenAPI `{param}` templates match one path segment per param. `RegExp` tests the full URL; a predicate function receives the `Request`.
- Auth-middleware utility:
  - `parseSetCookie(input)` — extracts `name=value` pairs from one or more `Set-Cookie` headers into a `Cookie` request-header string. Strips attributes, last-write-wins on duplicate names, and **honors deletions**: `Max-Age <= 0` or a past `Expires` removes the cookie (RFC 6265bis precedence — `Max-Age` over `Expires`, case-insensitive attribute names, strict `Max-Age` digit parsing where a malformed value invalidates the attribute, not the cookie). Accepts `Headers` (via `getSetCookie()`), `string[]` (recommended for cross-runtime correctness — `Expires` dates contain commas, so the joined `get('set-cookie')` form is unsound for multi-cookie responses), or a single `string`. Empty input → `""`. Browsers never expose `Set-Cookie`, so this is server-side-only by construction.
