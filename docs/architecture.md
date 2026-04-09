# Architecture

## Overview

`@bajustone/fetcher` is a schema-validated, typed fetch client. It wraps the native `fetch` API — returning a real `Response` object — and extends it with a `.result()` method that provides typed, schema-validated data. It supports OpenAPI specs, manual schemas (Zod, Valibot, ArkType), and ad-hoc per-call schemas.

## Design Principles

1. **100% native fetch** — The returned object is a real `Response`. All native methods (`.json()`, `.text()`, `.blob()`, `.headers`, `.status`) work as expected.
2. **Schema-agnostic** — Any object with a `.parse(data): T` method works as a schema. This covers Zod v4, Valibot, ArkType, and custom validators.
3. **Zero runtime deps** — Ships a built-in JSON Schema validator for `fromOpenAPI()`. No external dependencies.
4. **Never throws** — `.result()` catches errors and returns them in a discriminated union. Network failures, validation errors, and HTTP errors are all surfaced via `{ error }`.
5. **Framework-compatible** — Accepts a custom `fetch` function per-call (e.g., SvelteKit's load `fetch`) or globally via config.

## Three Modes

### Mode 1: fromOpenAPI

```typescript
import { createFetch, fromOpenAPI } from '@bajustone/fetcher'
import spec from './openapi.json'

const f = createFetch({
  baseUrl: 'https://api.example.com',
  routes: fromOpenAPI(spec),
})

f('/pets/{petId}', { method: 'GET', params: { petId: '42' } })
//  ^ autocompletes from spec               ^ inferred from path template
```

`fromOpenAPI()` parses an OpenAPI 3.x spec, resolves `$ref` pointers, and creates route definitions with built-in JSON Schema validators. One JSON file gives you path/method autocomplete and runtime validation.

#### What's inferred from the spec

`fromOpenAPI` is generic over the literal spec type (`fromOpenAPI<const Spec>`). When called with a JSON-imported spec, the return type narrows via `InferRoutesFromSpec<Spec>` to preserve:

- **Path keys** — `'/pets'`, `'/pets/{petId}'` autocomplete at the call site.
- **Method keys per path** — `f('/pets/{petId}', { method: 'GET' })` typechecks; `f('/pets/{petId}', { method: 'POST' })` falls through to the untyped branch if POST isn't declared on that path.
- **Path parameters** — derived from the path template via `ExtractPathParams<P>`. `params` becomes required when the path contains `{...}` segments.

#### What is NOT yet inferred

- **Body type** from `requestBody.content['application/json'].schema`
- **Response type** from `responses.200.content['application/json'].schema`
- **Error response type** from `responses.4xx/5xx.content['application/json'].schema`

These slots are typed as `RouteDefinition` (all-optional) for now, so `data` and `error.body` come back as `unknown`. The runtime validators built by `fromOpenAPI` are still active either way — you just don't get static `data: T` inference from the spec.

**Workaround until full inference lands:** layer a per-call `responseSchema` on top. The §4.A1 generic flows the schema's inferred output through to `result.data` regardless of what the route declares:

```typescript
import { z } from 'zod'

const Pet = z.object({ id: z.number(), name: z.string() })

const result = await f('/pets/{petId}', {
  method: 'GET',
  params: { petId: '42' },
  responseSchema: Pet, // ← static type via per-call schema
}).then(r => r.result())

if (result.ok) {
  result.data // typed { id: number; name: string }
}
```

#### Roadmap: full inference

Body/response inference from the spec's JSON Schemas requires a type-level JSON Schema → TS converter that mirrors the runtime `JSONSchemaValidator`'s supported subset. There are two paths under consideration:

1. **Extend `InferRoutesFromSpec`** to walk `Spec['paths'][P][M]['requestBody'/'responses']` and convert each schema to a TS type. Best-effort; expensive on the type checker for large specs.
2. **Codegen helper (Path B)** — a `bin/fetcher-codegen` script that emits a typed `Routes.ts` from a spec, with full-fidelity TypeScript interfaces. Slower workflow but covers cases the type-level converter can't.

Both are deferred — neither is necessary for the core runtime guarantees, and the per-call `responseSchema` workaround above is a clean stopgap.

### Mode 2: Manual Route Schemas

```typescript
const f = createFetch({
  baseUrl: 'https://api.example.com',
  routes: {
    '/auth/login': {
      POST: {
        body: z.object({ email: z.string(), password: z.string() }),
        response: z.object({ token: z.string() }),
      }
    },
  },
})
```

Define routes with any schema library that has `.parse()`. Types are inferred from the schemas.

### Mode 3: Ad-hoc Per-Call Schema

```typescript
const f = createFetch({ baseUrl: 'https://api.example.com' })
const response = await f('/endpoint', { method: 'GET', responseSchema: mySchema })
```

Pass a schema on any individual call. Useful for one-off requests or gradual adoption.

## Response Model

The fetch function returns a `TypedResponse` — a real `Response` with an added `.result()` method:

```typescript
const response = await f('/auth/login', { method: 'POST', body: { ... } })

// Native Response — all methods work
response.ok        // boolean
response.status    // number
response.headers   // Headers
await response.json()  // untyped JSON (native)

// Extension — typed + validated
const result = await response.result()
if (result.ok) {
  // result.data: T
} else {
  // result.error: FetcherError<HttpErrorBody>
  switch (result.error.kind) {
    case 'network':    /* result.error.cause */    break
    case 'validation': /* result.error.location, result.error.issues */ break
    case 'http':       /* result.error.status, result.error.body */     break
  }
}
```

`.result()` is like `.json()` but:
- Parses JSON and validates against the schema
- Returns `{ ok: true; data: T } | { ok: false; error: FetcherError<HttpErrorBody> }`
- Never throws — network failures, validation issues, and HTTP error responses are all surfaced via `{ ok: false, error }`
- Is **idempotent**: calling `.result()` more than once returns the same cached result

### Mixing `.result()` with native body methods

Because the returned object is a real `Response`, you can call `.result()` and any native body method (`.json()`, `.text()`, `.blob()`, `.arrayBuffer()`, `.formData()`) on the same response — in any order. `.result()` reads from an internal `response.clone()`, leaving the original body stream untouched for native access:

```typescript
const response = await f('/users/42', { method: 'GET' })

const result = await response.result()       // typed + validated
const blob = await response.blob()            // raw bytes — both work
const text = await response.text()            // raw text — also works
```

This is the load-bearing version of the "100% native fetch" promise: nothing about using `.result()` precludes streaming, blob-handling, or any other native Response use case.

The clone is *not* taken on the synthetic response returned by client-side validation failures or transport rejections — those carry the error directly and have no body to read.

## Module Structure

```
src/
├── index.ts                  # Public exports
├── types.ts                  # All type definitions
├── fetcher.ts                # createFetch implementation
├── openapi.ts                # fromOpenAPI implementation
├── json-schema-validator.ts  # Built-in JSON Schema validator
└── middleware.ts             # Middleware types + built-ins
```

### types.ts
- `Schema<T>` — the universal schema interface `{ parse(data: unknown): T }`
- `TypedResponse<T, E>` — Response + `.result()`
- `ResultData<T, E>` — discriminated union returned by `.result()`
- `RouteDefinition` — per-method schema config (body, params, query, response)
- `Routes` — path → method → RouteDefinition mapping
- Type-level helpers for extracting path params from template strings and inferring types from routes

### fetcher.ts
- `createFetch(config)` — factory that returns a typed fetch function
- Handles path param interpolation (`{id}` → actual value)
- Serializes query params to URL search params
- Sets `Content-Type: application/json` and serializes body
- Wraps the native `Response` with `.result()`
- Executes middleware chain
- Accepts optional `fetch` override per-call (SvelteKit compatibility)

### json-schema-validator.ts
- Lightweight JSON Schema validator implementing **Standard Schema V1** via the `~standard` property.
- Used internally by `fromOpenAPI()` — no external dependency.
- Also exports a deprecated `.parse()` method for backwards compatibility; new code should call `validator['~standard'].validate(data)`.

#### Supported subset

The validator covers a deliberately small slice of JSON Schema — enough to validate every endpoint in a well-formed OpenAPI 3.x spec. The supported subset is documented exclusively by the test suite at `tests/json-schema-validator.test.ts`; **anything not covered by a test there is officially out of scope.**

**Supported keywords:**

| Category | Keywords |
|---|---|
| Type | `type` (`object`, `array`, `string`, `number`, `integer`, `boolean`, `null`), array form (`type: ['string', 'null']`), `nullable` |
| Object | `properties`, `required` |
| Array | `items`, `minItems`, `maxItems` |
| String | `minLength`, `maxLength`, `pattern` |
| Number / integer | `minimum`, `maximum` (integer also enforces integer-ness) |
| Enum | `enum` (any JSON value) |
| Composition | `oneOf` (must match exactly one), `anyOf` (must match at least one), `allOf` (must match all) |
| Refs | `$ref` against the definitions object passed to the constructor (typically OpenAPI's `components.schemas`) |

**Not supported (intentionally):**

- **JSON Schema drafts other than 2020-12-shaped subsets** — no draft-4 / draft-6 / draft-7 quirks.
- **Conditional schemas** — `if` / `then` / `else`, `dependentSchemas`, `dependentRequired`.
- **Format validators** — `format: 'email'` / `'uri'` / `'date-time'` etc. are recognized as fields but not enforced.
- **Pattern properties** — `patternProperties`, `propertyNames`, `additionalProperties` (other than `false`).
- **Number constraints** — `multipleOf`, `exclusiveMinimum`, `exclusiveMaximum`.
- **Recursive `$ref`** — `$ref` resolution does not detect cycles. Self-referential schemas will recurse until the call stack overflows.
- **Format-specific validation** — UUID, email, URI, etc.
- **Tuple-typed arrays** — `items: [...]` (positional), `prefixItems`, `additionalItems`.
- **Schema annotations** — `title`, `description`, `examples`, `default` are accepted in input schemas but ignored at validation time.
- **`$id` / `$schema` / external `$ref`** — only intra-spec refs work.

**The maintenance contract.** The supported subset will not grow unless: (a) a new keyword is required to handle a real-world OpenAPI 3.x spec that fetcher otherwise can't validate, AND (b) the addition fits the existing recursive validator without architectural change. PRs adding general JSON Schema features will be politely closed with a pointer to Ajv.

If you need full JSON Schema support, build a `Schema` adapter around Ajv (or any validator that implements Standard Schema V1) and pass that to `createFetch` instead of going through `fromOpenAPI`.

### openapi.ts
- `fromOpenAPI<const Spec>(spec)` — generic over the literal spec type. Converts an OpenAPI 3.x JSON spec into `Routes`, narrowed to the spec's actual paths and methods via {@link InferRoutesFromSpec}.
- Resolves `$ref` pointers within the spec.
- Extracts paths, methods, request bodies, response schemas, and parameters.
- Creates `JSONSchemaValidator` instances for each route definition's body / params / query / response / errorResponse.
- See the "Mode 1: fromOpenAPI" section above for the full inference scope (path/method preservation today; body/response type inference deferred).

### middleware.ts
- `Middleware` — `(request, next) => Promise<Response>`. The `next` continuation accepts an optional `Request` argument so retry middleware can replay the chain with a modified request.
- `executeMiddleware` is a recursive dispatcher: each call to `next` re-enters the chain at the next index. Calling `next` more than once re-runs every downstream middleware (and the underlying fetch), which is what makes retry expressible.
- Built-in middlewares:
  - `authBearer(getToken)` — attaches `Authorization: Bearer <token>`.
  - `bearerWithRefresh(opts)` — bearer auth + 401-refresh-retry with concurrent-401 dedup and refresh-endpoint exclusion.
  - `timeout(ms)` — aborts a request via `AbortSignal.timeout(ms)` merged with the user's signal.
  - `retry(opts)` — re-invokes the chain on retryable failures (configurable status set, exponential backoff with jitter, honors `Retry-After`, clones the request body between attempts).
