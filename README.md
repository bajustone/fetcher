# @bajustone/fetcher

Schema-validated, typed fetch client with OpenAPI support.

Published on [JSR](https://jsr.io/@bajustone/fetcher). Runs on Bun, Deno, Node.js, and edge runtimes.

## Features

- **100% native fetch** — the returned object is a real `Response`. All native methods (`.json()`, `.text()`, `.blob()`, `.headers`, `.status`) work alongside `.result()`.
- **One-liner `.result()`** — `await f.get('/pets').result()` collapses two awaits into one. Returns a discriminated union `{ ok: true; data } | { ok: false; error }`. Never throws. Idempotent.
- **Discriminated `FetcherError`** — `{ kind: 'network' | 'validation' | 'http', ... }`. Network failures, schema-validation issues, and HTTP error responses are all distinguishable without `instanceof` checks.
- **Standard Schema V1** — works with Zod 3.24+, Valibot, ArkType, the bundled `JSONSchemaValidator`, or any value with a `~standard.validate` property.
- **OpenAPI 3.x** — `fromOpenAPI(spec)` builds runtime validators from a spec. Pass an `openapi-typescript`-generated `paths` interface as a generic for full body/response/error type inference.
- **Vite/Rollup plugin** — `fetcherPlugin()` auto-generates `paths.d.ts`, provides a `virtual:fetcher` module, and watches the spec for changes during dev. Import as `@bajustone/fetcher/vite`.
- **Composable middleware** — Hono/Koa-shaped recursive dispatcher. Per-call `middleware: false` or `middleware: [...]` override.
- **Built-in middlewares** — `authBearer`, `bearerWithRefresh` (with concurrent-401 dedup and `exclude` list), `timeout`, `retry` (exponential backoff with jitter, honors `Retry-After`).
- **Method shortcuts** — `f.get(path)`, `f.post(path, opts)`, etc.
- **Instance forking** — `f.with(overrides)` returns a sibling client inheriting everything from the parent except the named overrides.
- **Per-call `fetch` override** — drop in SvelteKit's load `fetch`, Cloudflare's `fetch`, or any custom implementation.

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

// One-liner: .result() is available directly on the promise
const result = await f.post('/auth/login', {
  body: { email: 'a@b.com', password: 'secret' },
}).result();

if (result.ok) {
  console.log(result.data.token); // typed: string
} else {
  switch (result.error.kind) {
    case 'network':    console.error('network', result.error.cause); break;
    case 'validation': console.error('invalid', result.error.location, result.error.issues); break;
    case 'http':       console.error('http', result.error.status, result.error.body); break;
  }
}

// The intermediate Response is still accessible when you need it:
const response = await f.get('/users');
response.ok;     // boolean
response.status; // number
const result2 = await response.result();
```

## Three modes

### 1. OpenAPI

Fully typed body / response / error inference from an OpenAPI 3.x spec, with runtime validation built in.

#### Option A: Vite/Rollup plugin (recommended)

The plugin auto-generates `paths.d.ts` from your spec and provides a `virtual:fetcher` module with a pre-configured typed client. Zero boilerplate.

```typescript
// vite.config.ts
import { fetcherPlugin } from '@bajustone/fetcher/vite';

export default defineConfig({
  plugins: [
    fetcherPlugin({
      spec: './openapi.json',
      baseUrl: 'https://api.example.com',
      output: './src/lib/api', // where paths.d.ts + fetcher-env.d.ts land
    }),
  ],
});
```

```typescript
// anywhere in your app
import { api } from 'virtual:fetcher';

const result = await api.get('/pets/{petId}', {
  params: { petId: '42' },
}).result();

if (result.ok) {
  result.data.id;   // typed: number — from the spec's Pet schema
  result.data.name; // typed: string
}
```

The plugin watches the spec file during dev and regenerates on change.

#### Option B: Manual setup (no plugin)

```typescript
import type { paths } from './generated/paths';
import { createFetch, fromOpenAPI } from '@bajustone/fetcher';
import spec from './openapi.json' with { type: 'json' };

const f = createFetch<paths>({
  baseUrl: 'https://api.example.com',
  routes: fromOpenAPI(spec),
});
```

Generate `paths.d.ts` with `openapi-typescript`:

```bash
bun add -d openapi-typescript
openapi-typescript ./openapi.json -o ./src/generated/paths.d.ts
```

Add a `package.json` script so types stay in sync with the spec:

```json
{
  "scripts": {
    "gen:api": "openapi-typescript ./openapi.json -o ./src/generated/paths.d.ts",
    "predev": "bun run gen:api",
    "prebuild": "bun run gen:api"
  }
}
```

#### Extracting component schema types

Use `SchemaOf` to extract named schemas from the generated `components` interface without writing the full path:

```typescript
import type { SchemaOf } from '@bajustone/fetcher';
import type { components } from './generated/paths';

type Pet = SchemaOf<components, 'Pet'>;
//   ^? { id: number; name: string; tag?: string }
```

#### Spec linting

`lintSpec(spec)` flags every keyword the runtime validator does NOT enforce (e.g., `format: 'email'` types as `string` but runtime accepts non-emails). Run from CI:

```typescript
import { lintSpec } from '@bajustone/fetcher';
import spec from './openapi.json' with { type: 'json' };

const issues = lintSpec(spec);
if (issues.length > 0) {
  for (const i of issues)
    console.error(`${i.severity}: ${i.pointer} — ${i.message}`);
  process.exit(1);
}
```

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

const result = await f.get('/users/{id}', { params: { id: '42' } }).result();
if (result.ok) {
  result.data; // { id: string; name: string }
}
```

Any Standard Schema V1 schema works — Zod 3.24+, Valibot, ArkType all qualify natively.

### 3. Ad-hoc per-call schema

```typescript
const f = createFetch({ baseUrl: 'https://api.example.com' });

const result = await f.get('/endpoint', {
  responseSchema: z.object({ ok: z.boolean() }),
}).result();

if (result.ok) {
  result.data.ok; // typed boolean
}
```

The per-call `responseSchema` wins over any route-declared `response`.

## Result and error model

`.result()` returns a discriminated union:

```typescript
type ResultData<T, HttpBody = unknown> =
  | { readonly ok: true;  readonly data: T }
  | { readonly ok: false; readonly error: FetcherError<HttpBody> }

type FetcherError<HttpBody = unknown> =
  | { readonly kind: 'network';    readonly cause: unknown }
  | { readonly kind: 'validation'; readonly location: 'body' | 'params' | 'query' | 'response'; readonly issues: ReadonlyArray<...> }
  | { readonly kind: 'http';       readonly status: number; readonly body: HttpBody }
```

`.result()` is available in two places:

- **On the promise:** `await f.get('/path').result()` — one-liner, resolves directly to `ResultData`.
- **On the response:** `const r = await f.get('/path'); await r.result()` — when you need the intermediate `Response` for headers, status, streaming, etc.

Both are idempotent and never throw.

## Middleware

```typescript
import { bearerWithRefresh, createFetch } from '@bajustone/fetcher';

const f = createFetch({
  baseUrl: 'https://api.example.com',
  retry: 3,
  timeout: 5_000,
  middleware: [
    bearerWithRefresh({
      getToken: () => sessionStorage.getItem('access_token'),
      refresh: async () => {
        const r = await fetch('/auth/refresh', { method: 'POST' });
        const { access_token } = await r.json();
        sessionStorage.setItem('access_token', access_token);
        return access_token;
      },
      exclude: ['/auth/login', '/auth/logout', '/auth/refresh'],
    }),
  ],
});
```

### Built-in middlewares

| Middleware | Purpose |
|---|---|
| `authBearer(getToken)` | Attaches `Authorization: Bearer <token>` per request. |
| `bearerWithRefresh(opts)` | Bearer auth + 401-refresh-retry. Concurrent 401s share one in-flight refresh. The `exclude` field lists paths that skip auth entirely (login, logout, refresh, etc.). |
| `retry(opts)` | Re-invokes the chain on retryable failures. Defaults: 3 attempts, exponential backoff with jitter, retries on `[408, 425, 429, 500, 502, 503, 504]`. Honors `Retry-After`. |
| `timeout(ms)` | Aborts a single request after `ms` ms. Merged with any user signal. |

### Per-call overrides

```typescript
await f.post('/auth/login', { middleware: false }); // skip all middleware
await f.get('/health', { middleware: [] });          // empty chain
await f.get('/slow', { timeout: 30_000, retry: 5 }); // per-call timeout/retry
```

## Method shortcuts and instance forking

```typescript
await f.get('/users');
await f.post('/users', { body: { name: 'Alice' } });
await f.put('/users/{id}', { params: { id: '1' }, body: { name: 'Alice' } });
await f.delete('/users/{id}', { params: { id: '1' } });
await f.patch('/users/{id}', { params: { id: '1' }, body: { active: false } });
```

`f.with(overrides)` derives a sibling client over a shallow-merged config:

```typescript
const api = createFetch({
  baseUrl: 'https://api.example.com',
  middleware: [bearerWithRefresh({ /* ... */ })],
});

const noAuth = api.with({ middleware: [] });
await noAuth.post('/auth/login', { body: { email, password } });
```

## Per-call fetch override

```typescript
// SvelteKit load function
export async function load({ fetch }) {
  return f.get('/users', { fetch }).result();
}
```

## API reference

### Runtime exports (`@bajustone/fetcher`)

| Export | Purpose |
|---|---|
| `createFetch(config)` | Factory returning a typed fetch function. Optional `<paths>` generic for OpenAPI type inference. |
| `fromOpenAPI(spec)` | Converts an OpenAPI 3.x spec into routes with runtime validators. |
| `lintSpec(spec)` | Walks an OpenAPI 3.x spec; returns every keyword the runtime validator doesn't enforce. |
| `coverage(spec)` | Walks an OpenAPI 3.x spec; reports per-route schema complexity (`oneOf`/`allOf`/recursive `$ref`/etc.). |
| `authBearer(getToken)` | Bearer-token middleware. |
| `bearerWithRefresh(opts)` | Bearer auth + 401-refresh-retry middleware with `exclude` list. |
| `retry(opts)` | Retry middleware (number shorthand or `RetryOptions`). |
| `timeout(ms)` | Per-request timeout middleware. |
| `JSONSchemaValidator` | Bundled JSON Schema validator implementing Standard Schema V1. |
| `ValidationError` | Thrown by the legacy `JSONSchemaValidator.parse()` (deprecated; prefer `~standard.validate`). |

### Plugin export (`@bajustone/fetcher/vite`)

| Export | Purpose |
|---|---|
| `fetcherPlugin(opts)` | Rollup/Vite plugin. Auto-generates `paths.d.ts`, provides `virtual:fetcher` module, watches spec during dev. |

### Types

`TypedFetchFn`, `TypedFetchPromise`, `TypedResponse`, `ResultData`, `FetcherError`, `FetcherErrorLocation`, `FetchConfig`, `Middleware`, `RetryOptions`, `RouteDefinition`, `Routes`, `Schema`, `SchemaOf`, `StandardSchemaV1`, `BearerWithRefreshOptions`, `FetcherPlugin`, `FetcherPluginOptions`, `SpecDriftIssue`, `SpecCoverageReport`, `RouteCoverage`, `InferRoutesFromSpec`, `InferOutput`.

See [`docs/architecture.md`](./docs/architecture.md) for implementation details.

## License

MIT
