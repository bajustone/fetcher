# Architecture

## Overview

`@bajustone/fetcher` is a schema-validated, typed fetch client. It wraps the native `fetch` API — returning a real `Response` object — and extends it with a `.result()` method that provides typed, schema-validated data. It supports OpenAPI specs, manual schemas (Zod, Valibot, ArkType), and ad-hoc per-call schemas.

## Design Principles

1. **100% native fetch** — The returned object is a real `Response`. All native methods (`.json()`, `.text()`, `.blob()`, `.headers`, `.status`) work as expected.
2. **Standard Schema V1** — Any schema implementing the [Standard Schema V1](https://standardschema.dev) spec (Zod 3.24+, Valibot, ArkType, the bundled schema builder under `./schema`, or any value with a `~standard.validate` property) works out of the box.
3. **Zero runtime deps** — Ships a native schema builder and a raw-JSON-Schema bridge. No external dependencies.
4. **Subpath-split for bundle discipline** — Core is ~2.7 KB gzipped. OpenAPI, dev-time spec tools, and the schema builder live in opt-in subpaths.
5. **Never throws** — `.result()` catches errors and returns them in a discriminated union. Network failures, validation errors, and HTTP errors are all surfaced via `{ error }`.
6. **Framework-compatible** — Accepts a custom `fetch` function per-call (e.g., SvelteKit's load `fetch`) or globally via config.

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

1. **Runtime validators** — `fromOpenAPI(spec)` (from `@bajustone/fetcher/openapi`) parses an OpenAPI 3.x spec, resolves `$ref` pointers, and produces pre-compiled validators for every route's body / params / query / response / errorResponse. Under the hood it calls `fromJSONSchema` which dispatches each JSON Schema node to the native builder's factory primitives.
2. **Type inference** — an `openapi-typescript`-generated `paths` interface, passed as the `OAS` generic on `createFetch<paths>(...)`, drives static type inference for body, response, and error bodies via helper types in `src/types.ts`.

Types and runtime validation are **decoupled by design** — see "Hybrid type/runtime workflow" below.

#### What composes when you supply `<paths>`

`createFetch<paths>(...)` walks the generated `paths` interface via the helper types in `src/types.ts`:

- **Path keys** — autocomplete from the keys of the generated `paths` interface via `AvailablePaths<R, OAS>`.
- **Body type** — extracted via `ResolveBodyFromPaths` from `paths[Path][Method]['requestBody']['content']['application/json']`.
- **Success response type** — extracted via `ResolveResponseFromPaths` from `paths[Path][Method]['responses'][2xx]['content']['application/json']`, matched by `FilterKeys` over `OpenAPISuccessStatus` (numeric 200–206 + the `'2xx'` wildcard).
- **Error response type** — extracted via `ResolveErrorResponseFromPaths` from `paths[Path][Method]['responses'][4xx|5xx|'default']['content']['application/json']`, matched by `FilterKeys` over `OpenAPIErrorStatus`. `'default'` is treated as the catch-all error (not success) — matching OpenAPI convention.
- **Path parameters** — derived from the path template via `ExtractPathParams<P>` (independent of the spec).

When `<paths>` is not supplied, behavior falls back to `Routes`-based inference only — `data` and `error.body` come back as `unknown` unless the route declares schemas. The per-call `responseSchema:` escape hatch always works regardless of which mode is active.

The `IsTypedCall<R, OAS, P, M>` type switches each call site between the typed (`TypedFetchOptions`) and untyped (`UntypedFetchOptions`) branches. The unified resolvers `ResolveBodyFor` / `ResolveResponseFor` / `ResolveErrorResponseFor` prefer OAS when supplied, falling back to Routes otherwise.

The executable spec of what flows through is in `tests/types/openapi-paths-inference.test-d.ts` (hand-rolled cases) and `tests/openapi-paths-workflow.test.ts` (cases against real `openapi-typescript` output for `tests/fixtures/petstore.json`).

#### Hybrid type/runtime workflow

Types come from `openapi-typescript` codegen. Runtime validators come from `fromOpenAPI(spec)`. Two derivations from one source of truth (`openapi.json`).

This split is deliberate:

- **Type story doesn't depend on TypeScript's conditional-type performance budget.** See "Why no zero-codegen OpenAPI inference?" below.
- **Runtime story doesn't depend on `openapi-typescript`'s release schedule.** The runtime validator subset is small, deliberate, and stable. Validation happens against the actual spec at startup, so spec changes are picked up immediately even if `paths.d.ts` is stale.
- **The two derivations can be checked against each other.** `lintSpec(spec)` walks the spec and reports keywords the runtime validator doesn't enforce but `openapi-typescript` renders as types.

#### Validator/type drift

The runtime validator enforces a deliberately small subset (see the supported-keyword table below). `openapi-typescript` may render features the runtime ignores. Where the two diverge, the type is stricter than the runtime. Examples:

- `format: 'email'` → types as `string`, runtime accepts any string (unless the spec uses a format helper that pairs `format` with an enforcing `pattern`).
- `multipleOf` / `exclusiveMinimum` / `exclusiveMaximum` → ignored at runtime.
- `patternProperties` / `propertyNames` / `additionalProperties` (sub-schema form) → unenforced.
- `if` / `then` / `else`, `dependentSchemas`, `dependentRequired` → unenforced.
- `prefixItems`, positional `items` (tuple arrays) → every element checked against the first schema.
- External `$ref`, `$id`, `$schema` → unsupported.
- Recursive `$ref` → **supported**, via lazy binding in `compile(schema, defs)`; the first resolution is cached on the ref's closure. Self-references terminate on input depth.

`lintSpec(spec)` (from `@bajustone/fetcher/spec-tools`) returns one `SpecDriftIssue` per drift point with an RFC 6901 JSON pointer, the unsupported keyword, a `'warn'` / `'info'` severity, and a message. Run from CI to fail builds on silent drift.

#### Why no zero-codegen OpenAPI inference?

TypeScript intentionally widens string values when importing JSON files (`resolveJsonModule`, `with { type: 'json' }` — both widen). A schema like `{ "type": "integer" }` imports as `{ type: string }`, not `{ type: 'integer' }`. A type-level `JSONSchemaToType<S>` converter cannot discriminate between schema kinds without literal types on the `type` field — it collapses to `unknown` for every leaf.

The widening is intentional per the TypeScript team ([microsoft/TypeScript#27913](https://github.com/Microsoft/TypeScript/issues/27913)). The proposal for literal-preserving JSON imports has been open since 2019 ([microsoft/TypeScript#32063](https://github.com/microsoft/TypeScript/issues/32063)) with no commitment. Every workaround re-introduces a build step (`.d.json.ts` declaration files, TypeScript transformer plugins, pasting the spec into a `.ts` file with `as const`).

Given that every alternative is a form of codegen, the question becomes: fetcher's custom converter vs `openapi-typescript`'s mature one. `openapi-typescript` wins — it handles `oneOf` / `allOf` / recursive `$ref` / discriminated unions / large specs. The `<paths>` flow is the right shape.

If TypeScript ever ships [#32063](https://github.com/microsoft/TypeScript/issues/32063), this section becomes obsolete and zero-codegen inference becomes worth revisiting.

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

The fetch function returns a `TypedFetchPromise` — a `Promise<TypedResponse>` augmented with a `.result()` shorthand:

```typescript
// One-liner: .result() on the promise
const result = await f.post('/auth/login', { body: { ... } }).result();
if (result.ok) {
  // result.data: T
} else {
  switch (result.error.kind) {
    case 'network':    /* result.error.cause */    break
    case 'validation': /* result.error.location, result.error.issues */ break
    case 'http':       /* result.error.status, result.error.body */     break
  }
}

// Two-liner: when you need the intermediate Response
const response = await f.post('/auth/login', { body: { ... } });
response.ok        // boolean
response.status    // number
const result2 = await response.result();
```

`.result()` is like `.json()` but:
- Parses JSON and validates against the schema.
- Returns `{ ok: true; data: T } | { ok: false; error: FetcherError<HttpErrorBody> }`.
- Never throws — network failures, validation issues, and HTTP errors are all surfaced via `{ ok: false, error }`.
- Is **idempotent**: calling `.result()` more than once returns the same cached result.

### Mixing `.result()` with native body methods

Because the returned object is a real `Response`, you can call `.result()` and any native body method (`.json()`, `.text()`, `.blob()`, `.arrayBuffer()`, `.formData()`) on the same response — in any order. `.result()` reads from an internal `response.clone()`, leaving the original body stream untouched.

The clone is *not* taken on the synthetic response returned by client-side validation failures or transport rejections — those carry the error directly and have no body to read.

## Module Structure

```
src/
├── index.ts                  # Core: createFetch, middleware, types (subpath `.`)
├── types.ts                  # Shared type definitions
├── fetcher.ts                # createFetch implementation
├── middleware.ts             # Middleware types + built-ins
├── from-json-schema.ts       # Raw JSON Schema → builder dispatcher (subpath `./openapi`)
├── inline.ts                 # $ref dereferencer (subpath `./openapi`)
├── json-schema-types.ts      # Shared JSONSchemaDefinition type
├── openapi.ts                # fromOpenAPI implementation (subpath `./openapi`)
├── spec-tools.ts             # lintSpec + coverage (subpath `./spec-tools`)
├── vite-plugin.ts            # Rollup/Vite plugin (subpath `./vite`)
├── openapi/index.ts          # Barrel for `./openapi`
├── spec-tools/index.ts       # Barrel for `./spec-tools`
└── schema/                   # Native schema builder (subpath `./schema`)
    ├── types.ts              # FSchema, FOptionalWrapper, Infer, FObjectOutput, interfaces
    ├── primitives.ts         # string, number, integer, boolean, null_, literal, unknown
    ├── composites.ts         # object, array, optional, nullable, union, intersect, enum_
    ├── discriminated.ts      # discriminatedUnion (O(1) tagged dispatch)
    ├── refs.ts               # ref, compile (lazy $ref binding, cycle-safe)
    ├── formats.ts            # email, url, uuid, datetime, date, time
    └── index.ts              # Barrel
```

### types.ts
- `Schema<T>` — aliases `StandardSchemaV1<unknown, T>`.
- `TypedResponse<T, E>` — `Response` + `.result()`.
- `TypedFetchPromise<T, E>` — `Promise<TypedResponse<T, E>>` + `.result()`, `.unwrap()`, and `.query()` shorthands on the promise itself.
- `ResultData<T, E>` — discriminated union returned by `.result()`.
- `QueryDescriptor<T>` — `{ key: ReadonlyArray<...>, fn: () => Promise<T> }` returned by `.query()`.
- `RouteDefinition` — per-method schema config (body, params, query, response, errorResponse).
- `Routes` — path → method → RouteDefinition mapping.
- `SchemaOf<Components, Name>` — extracts a named schema from an `openapi-typescript`-generated `components` interface.
- **OpenAPI `<paths>` inference helpers** — `FilterKeys`, `MediaType`, `OpenAPISuccessStatus`, `OpenAPIErrorStatus`, `ResolveBodyFromPaths`, `ResolveResponseFromPaths`, `ResolveErrorResponseFromPaths`, plus unified `ResolveBodyFor` / `ResolveResponseFor` / `ResolveErrorResponseFor` resolvers and `IsTypedCall` / `AvailablePaths` / `AvailableMethods` routing helpers.
- `TypedFetchFn<R, OAS>` — the typed fetch function interface. `R` is the routes table; `OAS` (optional) is the `openapi-typescript` `paths` interface.
- Type-level helpers: `ExtractPathParams`, `InferRoutesFromSpec`, `InferOutput`, `InferSchema`.

### fetcher.ts
- `createFetch<OAS, R>(config)` — factory returning a `TypedFetchFn<R, OAS>`.
- `rawFetchFn` — async function handling path interpolation, query params, body serialization, middleware chain execution, and response wrapping.
- `fetchFn` — wraps `rawFetchFn` to attach `.result()`, `.unwrap()`, and `.query()` on the returned promise (producing a `TypedFetchPromise`).
- Method shortcuts (`.get`, `.post`, `.put`, `.delete`, `.patch`) delegate to `fetchFn`.
- `.with(overrides)` — forks the client with shallow-merged config, preserving both `R` and `OAS` generics.
- `FetcherRequestError` — `Error` subclass thrown by `.unwrap()`. Carries `.status` (HTTP code or 500 for network/validation errors) and `.fetcherError` (the full `FetcherError` discriminated union). Enables `instanceof` checking in catch blocks.
- `extractErrorMessage(error)` — standalone utility that extracts a human-readable string from any `FetcherError`. Handles all three error kinds: network (unwraps `cause`), validation (joins issue messages), http (extracts `body.message` or `body.error.message`, falls back to `HTTP {status}`).
- `buildQueryKey(method, path, params?, query?)` — internal helper that produces a deterministic cache key array from call arguments. Used by `.query()`.

#### Three promise-level shorthands

| Method | Returns | Throws? | Use case |
|--------|---------|---------|----------|
| `.result()` | `ResultData<T>` | Never | Fine-grained error handling, partial success |
| `.unwrap()` | `T` | `FetcherRequestError` | Server load functions, remote functions, server actions |
| `.query()` | `QueryDescriptor<T>` | `fn()` throws | TanStack Query, SWR, Pinia Colada, any `{ key, fn }` cache |

`.query()` is synchronous — it returns the key and function without triggering the fetch. The key is `[method, path, params?, query?]`, deterministic and compatible with TanStack Query's array keys.

### schema/ — native schema builder

Produces plain JSON Schema objects augmented with a pre-compiled `~standard.validate` closure at construction time. No runtime interpreter. Each factory is `/*@__NO_SIDE_EFFECTS__*/`-annotated so bundlers eliminate any factory whose result is never used.

- **Primitives:** `string`, `number`, `integer`, `boolean`, `null_`, `literal`, `unknown`.
- **Composites:** `object`, `array`, `optional`, `nullable`, `union`, `intersect`, `enum_`.
- **Discriminated union:** `discriminatedUnion(key, mapping)` — O(1) dispatch by tag.
- **Refs:** `ref(name)` + `compile(schema, defs)` — lazy binding, cycle-safe.
- **Formats:** `email`, `url`, `uuid`, `datetime`, `date`, `time` — each emits both `format` and an enforcing `pattern`.

Each schema satisfies `StandardSchemaV1<unknown, T>` structurally, so it drops directly into any `RouteDefinition` slot. Inference via `Infer<typeof Pet>`.

#### Supported keyword subset

| Category | Keywords emitted + enforced |
|---|---|
| Type | `type` (`object`, `array`, `string`, `number`, `integer`, `boolean`, `null`) |
| Object | `properties`, `required` |
| Array | `items`, `minItems`, `maxItems` |
| String | `minLength`, `maxLength`, `pattern`, `format` (via helpers) |
| Number / integer | `minimum`, `maximum` (integer also enforces integer-ness) |
| Enum | `enum`, `const` |
| Composition | `anyOf`, `allOf`, `oneOf` + `discriminator` |
| Refs | `$ref` against a compiled `defs` map |

**Not exposed (intentionally):** `multipleOf`, `exclusiveMinimum`/`exclusiveMaximum`, `patternProperties`, `propertyNames`, `additionalProperties` (sub-schema form), `if`/`then`/`else`, `dependentSchemas`, `dependentRequired`, `prefixItems`, `contains`, `uniqueItems`.

### from-json-schema.ts

`fromJSONSchema<T>(schema, defs?)` — converts a raw JSON Schema object (plus optional `$defs` / component map) into a compiled builder schema. Dispatches each keyword to the native builder's factories. Used by `fromOpenAPI` and the Vite plugin's generated code as the bridge from spec-authored JSON to runtime validators.

### openapi.ts
- `fromOpenAPI<const Spec>(spec)` — generic over the literal spec type. Converts an OpenAPI 3.x JSON spec into `Routes`, narrowed to the spec's actual paths and methods via `InferRoutesFromSpec`.
- Resolves `$ref` pointers, extracts paths/methods/bodies/responses/parameters, wraps each schema with `fromJSONSchema(schema, definitions)` to produce compiled validators.
- Body / response / errorResponse *type* inference flows from the optional `<paths>` generic on `createFetch`, not from `fromOpenAPI` itself — `fromOpenAPI` owns only the runtime validators.

### spec-tools.ts
- `lintSpec(spec)` — walks an OpenAPI 3.x spec and returns one `SpecDriftIssue` per keyword the runtime validator doesn't enforce. Mirrors the "Not supported" table above.
- `coverage(spec)` — walks the spec and returns a `SpecCoverageReport` indicating per-route which schema features (`oneOf`, `allOf`, recursive `$ref`, etc.) each route uses. Useful as a complexity audit.
- Single recursive visitor shared between both functions; zero runtime dependencies.

### vite-plugin.ts
- `fetcherPlugin(options)` — Rollup/Vite plugin, exported as `@bajustone/fetcher/vite`. Returns `any` to avoid requiring `vite` as a peer dependency.
- **Options:** `spec` (path to OpenAPI JSON), `output?` (directory for generated files), `url?` (remote URL to fetch the spec from — fetches and caches locally at build start, falls back to local file on failure).
- **Rollup hooks:** `buildStart` (async — uses the `openapi-typescript` programmatic API to generate `paths.d.ts`, appends a `Schema<Name>` helper if `components` exist, emits `fetcher-env.d.ts`), `resolveId` + `load` (virtual module `virtual:fetcher` exporting pre-built route schemas as `routes`).
- **Virtual module design:** exports `routes` (not a pre-built client). The user imports `routes` and passes them to `createFetch` with their own middleware, baseUrl, and config. This follows the industry pattern (openapi-fetch, zodios, Hono RPC) of separating schema generation from client construction.
- **Vite-specific hook:** `configureServer` (watches the spec file, regenerates on change, invalidates the virtual module, triggers full reload).
- Dynamically imports `openapi-typescript` — it must be installed in the user's project as a devDependency. Supports both v7+ (AST-based, uses `astToString`) and earlier versions (string output). Clear error if not importable.
- `fetcher-env.d.ts` declares the `virtual:fetcher` module type with `export const routes: Routes` — no relative imports, eliminating the `declare module` + relative path fragility that affected SvelteKit and other frameworks.

### middleware.ts
- `Middleware` — `(request, next) => Promise<Response>`. `next` accepts an optional `Request` argument for replay.
- `executeMiddleware` — recursive dispatcher. Calling `next` more than once re-runs every downstream middleware and the final fetch.
- Built-in middlewares:
  - `authBearer(getToken)` — attaches `Authorization: Bearer <token>`.
  - `bearerWithRefresh<Paths>(opts)` — bearer auth + 401-refresh-retry with concurrent-401 dedup. The `exclude` field lists endpoints that skip auth entirely (login, logout, refresh, etc.) and is typed against the `Paths` generic — when the user passes their `paths` interface (e.g. `bearerWithRefresh<paths>({...})`), `exclude` gets autocomplete and compile-time typo checking. Defaults to `Record<string, unknown>` for backwards compatibility. The deprecated `refreshEndpoint` field is kept for backwards compatibility; `exclude` takes precedence when both are supplied.
  - `timeout(ms)` — aborts via `AbortSignal.timeout(ms)` merged with the user's signal.
  - `retry(opts)` — re-invokes the chain on retryable failures (configurable status set, exponential backoff with jitter, honors `Retry-After`, clones request body between attempts).
