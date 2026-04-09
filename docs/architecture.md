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
```

`fromOpenAPI()` parses an OpenAPI 3.x spec, resolves `$ref` pointers, and creates route definitions with built-in JSON Schema validators. One JSON file gives you type safety + runtime validation.

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
const { data, error } = await response.result()
```

`.result()` is like `.json()` but:
- Parses JSON and validates against the schema
- Returns a discriminated union: `{ data: T }` on success, `{ error: E }` on failure
- Never throws

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
- Lightweight JSON Schema validator (subset of the spec)
- Supports: object, array, string, number, integer, boolean, enum, required, nullable, oneOf/anyOf, $ref resolution
- Conforms to `Schema<T>` via `.parse()`
- Used internally by `fromOpenAPI()` — no external dependency

### openapi.ts
- `fromOpenAPI(spec)` — converts an OpenAPI 3.x JSON spec into `Routes`
- Resolves `$ref` pointers within the spec
- Extracts paths, methods, request bodies, response schemas, and parameters
- Creates JSON Schema validator instances for each route definition

### middleware.ts
- `Middleware` — `(request: Request, next: () => Promise<Response>) => Promise<Response>`
- `authBearer(getToken)` — attaches `Authorization: Bearer <token>` header
- Middleware is composable and executed in order
