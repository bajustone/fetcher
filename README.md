# @bajustone/fetcher

Schema-validated, typed fetch client with OpenAPI support.

Published on [JSR](https://jsr.io/@bajustone/fetcher). Runs on Bun, Deno, Node.js, and edge runtimes.

## Features

- **100% native fetch** — the returned object is a real `Response`. All native methods work (`.json()`, `.text()`, `.blob()`, `.headers`, `.status`, ...) on the same object that exposes `.result()`.
- **Typed `.result()`** — discriminated union `{ ok: true; data } | { ok: false; error }`. Never throws. Idempotent — calling `.result()` more than once returns the same cached value.
- **Discriminated `FetcherError`** — `{ kind: 'network' | 'validation' | 'http', ... }`. Network failures, schema-validation issues, and HTTP error responses are all distinguishable without `instanceof` checks.
- **Standard Schema V1** — works with Zod 3.24+, Valibot, ArkType, the bundled `JSONSchemaValidator`, or any value with a `~standard.validate` property. Zero migration for the major validators.
- **OpenAPI 3.x** — `fromOpenAPI(spec)` generates routes with built-in JSON Schema validation. The return type is generic over the literal spec, so path autocomplete and method narrowing flow from the spec without a separate codegen step.
- **Composable middleware** — Hono/Koa-shaped, with a recursive dispatcher that supports replay (retry middleware actually works). Per-call `middleware: false` or `middleware: [...]` override.
- **Built-in middlewares** — `authBearer`, `bearerWithRefresh` (with concurrent-401 dedup and refresh-endpoint exclusion), `timeout`, `retry` (exponential backoff with jitter, honors `Retry-After`).
- **Method shortcuts** — `f.get(path)`, `f.post(path, opts)`, etc. as additive sugar over the canonical long-form call.
- **Instance forking** — `f.with(overrides)` returns a sibling client inheriting everything from the parent except the named overrides.
- **Per-call `fetch` override** — drop in SvelteKit's load `fetch`, Cloudflare's `fetch`, or any custom implementation per call.

## Installation

```bash
# JSR (recommended)
deno add jsr:@bajustone/fetcher
bunx jsr add @bajustone/fetcher
npx jsr add @bajustone/fetcher
```

## Quick start

```typescript
import { createFetch } from '@bajustone/fetcher';
import { z } from 'zod';

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

const response = await f.post('/auth/login', {
  body: { email: 'a@b.com', password: 'secret' },
});

// Native Response methods work
response.ok;     // boolean
response.status; // number

// Typed + validated
const result = await response.result();
if (result.ok) {
  console.log(result.data.token); // typed: string
} else {
  switch (result.error.kind) {
    case 'network':    console.error('network', result.error.cause); break;
    case 'validation': console.error('invalid', result.error.location, result.error.issues); break;
    case 'http':       console.error('http', result.error.status, result.error.body); break;
  }
}
```

## Three modes

### 1. OpenAPI

> [!IMPORTANT]
> **OpenAPI mode does not yet give you fully typed responses out of the box.**
> What you DO get from `fromOpenAPI(spec)` today: path autocomplete, method narrowing, path-parameter inference, and runtime validation of body / params / query / response / errorResponse against the spec's JSON Schemas.
> What you do NOT yet get: type-level body/response *types* derived from the spec — `data` and `error.body` come back as `unknown`. Layer a per-call `responseSchema` (see [Mode 3](#3-ad-hoc-per-call-schema)) to recover static types until type-level JSON Schema → TS conversion lands.

```typescript
import { createFetch, fromOpenAPI } from '@bajustone/fetcher';
import spec from './openapi.json';

const f = createFetch({
  baseUrl: 'https://api.example.com',
  routes: fromOpenAPI(spec),
});

f('/pets/{petId}', { method: 'GET', params: { petId: '42' } });
//  ^ autocompletes from spec               ^ inferred from path template
```

`fromOpenAPI()` parses an OpenAPI 3.x spec, resolves `$ref` pointers, and creates route definitions with built-in JSON Schema validators. The function is generic over the literal spec type, so path keys and method keys flow from the spec without a codegen step.

**What's inferred from the spec today:**
- Path keys (autocomplete)
- Method keys per path
- Path parameters (via the path template — `{petId}` makes `params: { petId: string }` required)
- Runtime validation of body / params / query / response / errorResponse

**Not yet inferred:**
- Body and response *types* from the spec's JSON Schemas. `data` and `error.body` come back as `unknown` for now. Layer a per-call `responseSchema: zSchema` for typed access (see Mode 3) — the runtime validators built by `fromOpenAPI` are still active either way.

```typescript
import { z } from 'zod';

// Recover static types via per-call responseSchema until full inference lands
const Pet = z.object({ id: z.number(), name: z.string() });

const res = await f.get('/pets/{petId}', {
  params: { petId: '42' },
  responseSchema: Pet,
});
const result = await res.result();
if (result.ok) {
  result.data; // typed: { id: number; name: string }
}
```

See [`docs/architecture.md`](./docs/architecture.md) for the inference scope and the roadmap toward full body/response inference.

### 2. Manual route schemas

```typescript
import { createFetch } from '@bajustone/fetcher';
import { z } from 'zod';

const f = createFetch({
  baseUrl: 'https://api.example.com',
  routes: {
    '/users/{id}': {
      GET: {
        params: z.object({ id: z.string() }),
        response: z.object({ id: z.string(), name: z.string() }),
      },
    },
  },
});

const res = await f.get('/users/{id}', { params: { id: '42' } });
const result = await res.result();
if (result.ok) {
  result.data; // { id: string; name: string }
}
```

Any Standard Schema V1 schema works — Zod 3.24+, Valibot, ArkType all qualify natively. Bare `{ parse(data): T }` validators need a five-line wrapper:

```typescript
import type { StandardSchemaV1 } from '@bajustone/fetcher';

function toStandardSchema<T>(parser: { parse(data: unknown): T }): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'custom',
      validate: (value) => {
        try { return { value: parser.parse(value) }; }
        catch (e) { return { issues: [{ message: String(e) }] }; }
      },
    },
  };
}
```

### 3. Ad-hoc per-call schema

```typescript
import { createFetch } from '@bajustone/fetcher';
import { z } from 'zod';

const f = createFetch({ baseUrl: 'https://api.example.com' });

const res = await f.get('/endpoint', {
  responseSchema: z.object({ ok: z.boolean() }),
});

const result = await res.result();
if (result.ok) {
  result.data.ok; // typed boolean — inference flows from the per-call schema
}
```

The per-call `responseSchema` wins over any route-declared `response`, so you can layer one on top of an OpenAPI route to get typed access while body/response inference is pending.

## Result and error model

`.result()` returns a discriminated union:

```typescript
type ResultData<T, HttpBody = unknown> =
  | { readonly ok: true;  readonly data: T }
  | { readonly ok: false; readonly error: FetcherError<HttpBody> }

type FetcherError<HttpBody = unknown> =
  | { readonly kind: 'network';    readonly cause: unknown }
  | { readonly kind: 'validation'; readonly location: 'body' | 'params' | 'query' | 'response'; readonly issues: ReadonlyArray<{ message: string; path?: ReadonlyArray<...> }> }
  | { readonly kind: 'http';       readonly status: number; readonly body: HttpBody }
```

`.result()` is like `.json()` but:

- Parses JSON and validates against the schema
- Returns the discriminated union — never throws
- Surfaces network failures, body/params/query validation errors (client-side), response validation errors (server-side), and HTTP error responses through one error path
- Is idempotent (cached after the first call)
- Reads from an internal `response.clone()`, so calling `.result()` and any native body method (`.json()`, `.blob()`, ...) on the same response in any order is safe

## Middleware

```typescript
import {
  authBearer,
  bearerWithRefresh,
  createFetch,
  retry,
  timeout,
} from '@bajustone/fetcher';

const f = createFetch({
  baseUrl: 'https://api.example.com',
  // Auto-prepended built-ins (also configurable per-call):
  retry: 3,           // or { attempts, backoff, factor, maxBackoff, retryOn }
  timeout: 5_000,     // milliseconds; merged with any user signal
  middleware: [
    bearerWithRefresh({
      getToken: () => sessionStorage.getItem('access_token'),
      refresh: async () => {
        const r = await fetch('/auth/refresh', { method: 'POST' });
        const { access_token } = await r.json();
        sessionStorage.setItem('access_token', access_token);
        return access_token;
      },
      refreshEndpoint: '/auth/refresh',
    }),
    async (req, next) => {
      console.log('→', req.method, req.url);
      const res = await next(req);
      console.log('←', res.status);
      return res;
    },
  ],
});
```

The middleware contract is `(request, next) => Promise<Response>`, where `next` accepts an optional `Request` argument so retry middleware can replay the chain with a fresh request:

```typescript
const myRetry: Middleware = async (request, next) => {
  let res = await next(request.clone());
  if (res.status >= 500) res = await next(request.clone());
  return res;
};
```

`executeMiddleware` is a recursive dispatcher — calling `next` more than once re-runs every downstream middleware (and the underlying fetch), not just the final hop.

### Built-in middlewares

| Middleware | Purpose |
|---|---|
| `authBearer(getToken)` | Attaches `Authorization: Bearer <token>` per request. |
| `bearerWithRefresh({ getToken, refresh, refreshEndpoint })` | Adds 401-refresh-retry on top of bearer auth. Concurrent 401s share one in-flight refresh. The refresh endpoint itself is excluded from the loop to avoid deadlock. |
| `retry(opts)` | Re-invokes the chain on retryable failures. Defaults: 3 attempts, exponential backoff with ±25% jitter, retries on `[408, 425, 429, 500, 502, 503, 504]`. Honors `Retry-After` (numeric or HTTP-date). Clones the request body between attempts. |
| `timeout(ms)` | Aborts a single request after `ms` ms. Merged with any user `request.signal`. |

### Per-call middleware override

```typescript
// Skip the configured chain entirely (e.g. for an auth-refresh endpoint)
await f.post('/auth/refresh', { middleware: false });

// Replace the chain for this call only
await f.get('/health', { middleware: [] });

// Per-call timeout / retry override
await f.get('/slow-endpoint', { timeout: 30_000, retry: 5 });
```

## Method shortcuts and instance forking

Method shortcuts are sugar over the long-form call. The long-form `f(path, { method: 'GET' })` continues to work.

```typescript
await f.get('/users');
await f.post('/users', { body: { name: 'Alice' } });
await f.put('/users/{id}', { params: { id: '1' }, body: { name: 'Alice' } });
await f.delete('/users/{id}', { params: { id: '1' } });
await f.patch('/users/{id}', { params: { id: '1' }, body: { active: false } });
```

`f.with(overrides)` derives a sibling client over a shallow-merged config — useful for an auth-free helper:

```typescript
const api = createFetch({
  baseUrl: 'https://api.example.com',
  middleware: [bearerWithRefresh({ /* ... */ })],
});

const noAuth = api.with({ middleware: [] });

await noAuth.post('/auth/login', { body: { email, password } });
```

The parent is unaffected — `with` returns a brand-new function over a shallow-merged config.

## Per-call fetch override

```typescript
export async function load({ fetch }) {
  const res = await f.get('/users', { fetch });
  return res.result();
}
```

Useful for SvelteKit's load `fetch`, Cloudflare Workers, or test mocks.

## API reference

### Runtime

| Export | Purpose |
|---|---|
| `createFetch(config)` | Factory returning a typed fetch function. |
| `fromOpenAPI(spec)` | Converts an OpenAPI 3.x spec into typed routes. Generic over the spec literal. |
| `authBearer(getToken)` | Bearer-token middleware. |
| `bearerWithRefresh(opts)` | Bearer auth + 401-refresh-retry middleware. |
| `retry(opts)` | Retry middleware (number shorthand or `RetryOptions`). |
| `timeout(ms)` | Per-request timeout middleware. |
| `JSONSchemaValidator` | Bundled JSON Schema validator implementing Standard Schema V1. |
| `ValidationError` | Thrown by the legacy `JSONSchemaValidator.parse()` (deprecated; prefer `~standard.validate`). |

### Types

`FetchConfig`, `FetcherError`, `FetcherErrorLocation`, `Middleware`, `ResultData`, `RetryOptions`, `RouteDefinition`, `Routes`, `Schema`, `StandardSchemaV1`, `TypedFetchFn`, `TypedResponse`, `BearerWithRefreshOptions`, `InferOutput`, `InferRoutesFromSpec`, plus a few helpers.

See [`docs/architecture.md`](./docs/architecture.md) for implementation details.

## License

MIT
