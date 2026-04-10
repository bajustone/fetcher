# Architecture

## Overview

`@bajustone/fetcher` is a schema-validated, typed fetch client. It wraps the native `fetch` API — returning a real `Response` object — and extends it with a `.result()` method that provides typed, schema-validated data. It supports OpenAPI specs, manual schemas (Zod, Valibot, ArkType), and ad-hoc per-call schemas.

## Design Principles

1. **100% native fetch** — The returned object is a real `Response`. All native methods (`.json()`, `.text()`, `.blob()`, `.headers`, `.status`) work as expected.
2. **Standard Schema V1** — Any schema implementing the [Standard Schema V1](https://standardschema.dev) spec (Zod 3.24+, Valibot, ArkType, the bundled `JSONSchemaValidator`, or any value with a `~standard.validate` property) works out of the box.
3. **Zero runtime deps** — Ships a built-in JSON Schema validator for `fromOpenAPI()`. No external dependencies.
4. **Never throws** — `.result()` catches errors and returns them in a discriminated union. Network failures, validation errors, and HTTP errors are all surfaced via `{ error }`.
5. **Framework-compatible** — Accepts a custom `fetch` function per-call (e.g., SvelteKit's load `fetch`) or globally via config.

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

1. **Runtime validators** — `fromOpenAPI(spec)` parses an OpenAPI 3.x spec, resolves `$ref` pointers, and creates `JSONSchemaValidator` instances for every route's body / params / query / response / errorResponse.
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

The runtime `JSONSchemaValidator` enforces a deliberately small subset (see the supported-keyword table in the "json-schema-validator.ts" section below). `openapi-typescript` may render features the runtime ignores. Where the two diverge, the type is stricter than the runtime. Examples:

- `format: 'email'` → types as `string`, runtime accepts any string.
- `multipleOf` / `exclusiveMinimum` / `exclusiveMaximum` → ignored at runtime.
- `patternProperties` / `propertyNames` / `additionalProperties` (sub-schema form) → unenforced.
- `if` / `then` / `else`, `dependentSchemas`, `dependentRequired` → unenforced.
- `prefixItems`, positional `items` (tuple arrays) → every element checked against the first schema.
- External `$ref`, `$id`, `$schema` → unsupported.
- Recursive `$ref` → no cycle detection; will overflow at runtime.

`lintSpec(spec)` (exported from `src/spec-tools.ts`) returns one `SpecDriftIssue` per drift point with an RFC 6901 JSON pointer, the unsupported keyword, a `'warn'` / `'info'` severity, and a message. Run from CI to fail builds on silent drift.

#### Why no zero-codegen OpenAPI inference?

TypeScript intentionally widens string values when importing JSON files (`resolveJsonModule`, `with { type: 'json' }` — both widen). A schema like `{ "type": "integer" }` imports as `{ type: string }`, not `{ type: 'integer' }`. A type-level `JSONSchemaToType<S>` converter cannot discriminate between schema kinds without literal types on the `type` field — it collapses to `unknown` for every leaf.

The widening is intentional per the TypeScript team ([microsoft/TypeScript#27913](https://github.com/Microsoft/TypeScript/issues/27913)). The proposal for literal-preserving JSON imports has been open since 2019 ([microsoft/TypeScript#32063](https://github.com/microsoft/TypeScript/issues/32063)) with no commitment. Every workaround re-introduces a build step (`.d.json.ts` declaration files, TypeScript transformer plugins, pasting the spec into a `.ts` file with `as const`).

Given that every alternative is a form of codegen, the question becomes: fetcher's custom converter vs `openapi-typescript`'s mature one. `openapi-typescript` wins — it handles `oneOf` / `allOf` / recursive `$ref` / discriminated unions / large specs. The `<paths>` flow is the right shape.

If TypeScript ever ships [#32063](https://github.com/microsoft/TypeScript/issues/32063), this section becomes obsolete and zero-codegen inference becomes worth revisiting.

### Mode 2: Manual Route Schemas

```typescript
const f = createFetch({
  baseUrl: 'https://api.example.com',
  routes: {
    '/auth/login': {
      POST: {
        body: z.object({ email: z.string(), password: z.string() }),
        response: z.object({ token: z.string() }),
      },
    },
  },
});
```

Define routes with any Standard Schema V1 schema library. Types are inferred from the schemas via `ResolveBody` / `ResolveResponse` / `ResolveErrorResponse`.

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
├── index.ts                  # Public exports (main entry)
├── types.ts                  # All type definitions (TypedFetchPromise, <paths> helpers, SchemaOf, etc.)
├── fetcher.ts                # createFetch implementation
├── openapi.ts                # fromOpenAPI implementation
├── json-schema-validator.ts  # Built-in JSON Schema validator (Standard Schema V1)
├── spec-tools.ts             # lintSpec + coverage
├── vite-plugin.ts            # Rollup/Vite plugin (secondary export: @bajustone/fetcher/vite)
└── middleware.ts             # Middleware types + built-ins
```

### types.ts
- `Schema<T>` — aliases `StandardSchemaV1<unknown, T>`.
- `TypedResponse<T, E>` — `Response` + `.result()`.
- `TypedFetchPromise<T, E>` — `Promise<TypedResponse<T, E>>` + `.result()` shorthand on the promise itself. Enables `await f.get('/path').result()`.
- `ResultData<T, E>` — discriminated union returned by `.result()`.
- `RouteDefinition` — per-method schema config (body, params, query, response, errorResponse).
- `Routes` — path → method → RouteDefinition mapping.
- `SchemaOf<Components, Name>` — extracts a named schema from an `openapi-typescript`-generated `components` interface.
- **OpenAPI `<paths>` inference helpers** — `FilterKeys`, `MediaType`, `OpenAPISuccessStatus`, `OpenAPIErrorStatus`, `ResolveBodyFromPaths`, `ResolveResponseFromPaths`, `ResolveErrorResponseFromPaths`, plus unified `ResolveBodyFor` / `ResolveResponseFor` / `ResolveErrorResponseFor` resolvers and `IsTypedCall` / `AvailablePaths` / `AvailableMethods` routing helpers.
- `TypedFetchFn<R, OAS>` — the typed fetch function interface. `R` is the routes table; `OAS` (optional) is the `openapi-typescript` `paths` interface.
- Type-level helpers: `ExtractPathParams`, `InferRoutesFromSpec`, `InferOutput`, `InferSchema`.

### fetcher.ts
- `createFetch<OAS, R>(config)` — factory returning a `TypedFetchFn<R, OAS>`.
- `rawFetchFn` — async function handling path interpolation, query params, body serialization, middleware chain execution, and response wrapping.
- `fetchFn` — wraps `rawFetchFn` to attach `.result()` on the returned promise (producing a `TypedFetchPromise`).
- Method shortcuts (`.get`, `.post`, `.put`, `.delete`, `.patch`) delegate to `fetchFn`.
- `.with(overrides)` — forks the client with shallow-merged config, preserving both `R` and `OAS` generics.
- `extractErrorMessage(error)` — standalone utility that extracts a human-readable string from any `FetcherError`. Handles all three error kinds: network (unwraps `cause`), validation (joins issue messages), http (extracts `body.message` or `body.error.message`, falls back to `HTTP {status}`).

### json-schema-validator.ts
- Lightweight JSON Schema validator implementing **Standard Schema V1** via the `~standard` property.
- Used internally by `fromOpenAPI()` — no external dependency.
- Also exports a deprecated `.parse()` method; new code should use `validator['~standard'].validate(data)`.

#### Supported subset

The validator covers a deliberately small slice of JSON Schema — enough for well-formed OpenAPI 3.x specs. The test suite at `tests/json-schema-validator.test.ts` is the authoritative reference.

**Supported keywords:**

| Category | Keywords |
|---|---|
| Type | `type` (`object`, `array`, `string`, `number`, `integer`, `boolean`, `null`), array form (`type: ['string', 'null']`), `nullable` |
| Object | `properties`, `required` |
| Array | `items`, `minItems`, `maxItems` |
| String | `minLength`, `maxLength`, `pattern` |
| Number / integer | `minimum`, `maximum` (integer also enforces integer-ness) |
| Enum | `enum` (any JSON value) |
| Composition | `oneOf` (exactly one), `anyOf` (at least one), `allOf` (all) |
| Refs | `$ref` against the definitions object (typically `components.schemas`) |

**Not supported (intentionally):**

- Conditional schemas (`if` / `then` / `else`, `dependentSchemas`, `dependentRequired`).
- Format validators (`format: 'email'` etc. — recognized but not enforced).
- Pattern properties (`patternProperties`, `propertyNames`, `additionalProperties` other than `false`).
- Number constraints (`multipleOf`, `exclusiveMinimum`, `exclusiveMaximum`).
- Recursive `$ref` (no cycle detection).
- Tuple-typed arrays (`items: [...]`, `prefixItems`, `additionalItems`).
- Schema annotations (`title`, `description`, `examples`, `default` — accepted, ignored).
- `$id` / `$schema` / external `$ref`.

**Maintenance contract:** the subset will not grow unless a new keyword is required for a real-world OpenAPI 3.x spec AND fits the existing recursive validator without architectural change.

### openapi.ts
- `fromOpenAPI<const Spec>(spec)` — generic over the literal spec type. Converts an OpenAPI 3.x JSON spec into `Routes`, narrowed to the spec's actual paths and methods via `InferRoutesFromSpec`.
- Resolves `$ref` pointers, extracts paths/methods/bodies/responses/parameters, creates `JSONSchemaValidator` instances.
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
