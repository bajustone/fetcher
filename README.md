# @bajustone/fetcher

Schema-validated, typed fetch client with OpenAPI support.

Published on [JSR](https://jsr.io/@bajustone/fetcher). Runs on Bun, Deno, Node.js, and edge runtimes.

## Features

- **100% native fetch** — the returned object is a real `Response`, all native methods work (`.json()`, `.text()`, `.headers`, `.status`, ...)
- **Typed `.result()` extension** — returns a discriminated union `{ data } | { error }`, never throws
- **Schema-agnostic** — works with Zod v4, Valibot, ArkType, or any object with a `.parse(data): T` method
- **OpenAPI 3.x support** — `fromOpenAPI(spec)` builds typed routes with built-in JSON Schema validation, zero runtime deps
- **Middleware** — composable request/response pipeline with a built-in `authBearer()` helper
- **Per-call `fetch` override** — drop in SvelteKit's load `fetch`, Cloudflare's `fetch`, or any custom implementation

## Installation

```bash
# JSR (recommended)
deno add jsr:@bajustone/fetcher
bunx jsr add @bajustone/fetcher
npx jsr add @bajustone/fetcher
```

## Quick Start

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

const response = await f('/auth/login', {
  method: 'POST',
  body: { email: 'a@b.com', password: 'secret' },
});

// Native Response methods work
response.ok; // boolean
response.status; // number

// Typed + validated
const { data, error } = await response.result();
if (error) {
  console.error(error);
}
else {
  console.log(data.token); // fully typed
}
```

## Three Modes

### 1. OpenAPI

```typescript
import { createFetch, fromOpenAPI } from '@bajustone/fetcher';
import spec from './openapi.json';

const f = createFetch({
  baseUrl: 'https://api.example.com',
  routes: fromOpenAPI(spec),
});
```

`fromOpenAPI()` parses an OpenAPI 3.x spec, resolves `$ref` pointers, and creates route definitions with built-in JSON Schema validators. One JSON file gives you type safety and runtime validation with no external deps.

### 2. Manual Route Schemas

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

const res = await f('/users/{id}', {
  method: 'GET',
  params: { id: '42' },
});
const { data } = await res.result();
```

Any schema library with a `.parse()` method works.

### 3. Ad-hoc Per-Call Schema

```typescript
import { createFetch } from '@bajustone/fetcher';
import { z } from 'zod';

const f = createFetch({ baseUrl: 'https://api.example.com' });

const res = await f('/endpoint', {
  method: 'GET',
  responseSchema: z.object({ ok: z.boolean() }),
});
```

Useful for one-off requests or gradual adoption.

## Middleware

Middleware is `(request: Request, next: () => Promise<Response>) => Promise<Response>` — the same shape as Hono/Koa.

```typescript
import { authBearer, createFetch } from '@bajustone/fetcher';

const f = createFetch({
  baseUrl: 'https://api.example.com',
  middleware: [
    authBearer(() => localStorage.getItem('token')),
    async (req, next) => {
      console.log('→', req.method, req.url);
      const res = await next();
      console.log('←', res.status);
      return res;
    },
  ],
});
```

`authBearer(getToken)` calls `getToken` on every request, so it can return a fresh token each time (e.g. from a refresh flow).

## Response Model

The fetch function returns a `TypedResponse` — a real `Response` with an added `.result()` method:

```typescript
const response = await f('/auth/login', { method: 'POST', body: { /* ... */ } });

// Native Response — all methods work
response.ok; // boolean
response.status; // number
response.headers; // Headers
await response.json(); // untyped JSON (native)

// Extension — typed + validated
const { data, error } = await response.result();
```

`.result()` is like `.json()` but:

- Parses JSON and validates against the schema
- Returns a discriminated union: `{ data: T }` on success, `{ error: E }` on failure
- Never throws — network failures, validation errors, and HTTP error responses are all surfaced via `{ error }`

## Per-Call Fetch Override

Pass a custom `fetch` function per call — useful for SvelteKit's load `fetch`, Cloudflare Workers, or mocking in tests.

```typescript
export async function load({ fetch }) {
  const res = await f('/users', { method: 'GET', fetch });
  return await res.result();
}
```

## API Reference

- `createFetch(config)` — factory that returns a typed fetch function
- `fromOpenAPI(spec)` — converts an OpenAPI 3.x JSON spec into typed routes
- `authBearer(getToken)` — middleware that attaches `Authorization: Bearer <token>`
- `JSONSchemaValidator` — lightweight JSON Schema validator (used internally by `fromOpenAPI`)
- `ValidationError` — thrown by `JSONSchemaValidator.parse()` on invalid data

See [`docs/architecture.md`](./docs/architecture.md) for implementation details.

## License

MIT
