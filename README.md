# @bajustone/fetcher

Schema-validated, typed fetch client with OpenAPI support. ~2.7 kB gzipped for the core, pay-as-used for the optional schema builder (string-only: ~330 B).

Published on [JSR](https://jsr.io/@bajustone/fetcher). Runs on Bun, Deno, Node.js, and edge runtimes.

### Why fetcher over openapi-fetch?

[openapi-fetch](https://openapi-ts.dev/openapi-fetch/) gives you typed paths from an OpenAPI spec. fetcher does that too, and adds:

- **Runtime validation** — responses are validated against your schemas at runtime, not just at compile time. Catch API drift before it breaks your UI.
- **Recursive middleware** — Hono/Koa-shaped dispatcher with per-call override (`middleware: false`). Built-in `bearerWithRefresh` with concurrent-401 dedup and typed `exclude`.
- **Batteries included** — retry with backoff/jitter, timeout, error extraction, `.result()` / `.unwrap()` / `.query()` primitives, instance forking via `.with()`.
- **Standard Schema V1** — not locked to Zod. Works with the bundled native schema builder, Valibot, ArkType, or any value with `~standard.validate`.

## Features

- **100% native fetch** — the returned object is a real `Response`. All native methods (`.json()`, `.text()`, `.blob()`, `.headers`, `.status`) work alongside `.result()`.
- **One-liner `.result()`** — `await f.get('/pets').result()` collapses two awaits into one. Returns a discriminated union `{ ok: true; data } | { ok: false; error }`. Never throws. Idempotent.
- **Discriminated `FetcherError`** — `{ kind: 'network' | 'validation' | 'http', ... }`. Network failures, schema-validation issues, and HTTP error responses are all distinguishable without `instanceof` checks.
- **Standard Schema V1** — works with Zod 3.24+, Valibot, ArkType, the native `@bajustone/fetcher/schema` builder, or any value with a `~standard.validate` property.
- **Native schema builder** — `@bajustone/fetcher/schema` exports `string`, `object`, `optional`, `discriminatedUnion`, format helpers, and a `compile` pass for `$ref` resolution. Each factory is tree-shakeable (`@__NO_SIDE_EFFECTS__`) and validators are compiled at construction time — no runtime interpreter.
- **OpenAPI 3.x** — `fromOpenAPI(spec)` (from `@bajustone/fetcher/openapi`) builds runtime validators from a spec. Pass an `openapi-typescript`-generated `paths` interface as a generic for full body/response/error type inference.
- **Vite/Rollup plugin** — `fetcherPlugin()` auto-generates `paths.d.ts`, provides a `virtual:fetcher` module exporting pre-built route schemas, and watches the spec for changes during dev. Optionally fetches the spec from a remote URL. Import as `@bajustone/fetcher/vite`.
- **Composable middleware** — Hono/Koa-shaped recursive dispatcher. Per-call `middleware: false` or `middleware: [...]` override.
- **Built-in middlewares** — `authBearer`, `bearerWithRefresh` (with concurrent-401 dedup and typed `exclude` list), `timeout`, `retry` (exponential backoff with jitter, honors `Retry-After`).
- **Built-in error extraction** — `extractErrorMessage(error)` turns any `FetcherError` into a human-readable string. No per-project helper needed.
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

Zod 3.24+, Valibot, and ArkType all drop in the same way — the bundled builder is just the zero-dep default.

## Three modes

### 1. OpenAPI

Fully typed body / response / error inference from an OpenAPI 3.x spec, with runtime validation built in.

#### Option A: Vite/Rollup plugin (recommended)

The plugin auto-generates `paths.d.ts` from your spec and provides a `virtual:fetcher` module exporting pre-built route schemas. You construct the client yourself, with full control over middleware, baseUrl, and other config.

```typescript
// vite.config.ts
import { fetcherPlugin } from '@bajustone/fetcher/vite';

export default defineConfig({
  plugins: [
    fetcherPlugin({
      spec: './openapi.json',
      output: './src/lib/api', // where paths.d.ts + fetcher-env.d.ts land
      url: process.env.OPENAPI_SPEC_URL, // optional: fetch spec from remote
    }),
  ],
});
```

```typescript
// src/lib/api/index.ts — your app's API client
import { createFetch, bearerWithRefresh } from '@bajustone/fetcher';
import type { paths } from './paths';
import { routes } from 'virtual:fetcher';

export const api = createFetch<paths>({
  baseUrl: import.meta.env.VITE_API_URL,
  routes,
  middleware: [
    bearerWithRefresh({ /* ... */ }),
  ],
});
```

```typescript
// anywhere in your app
import { api } from '$lib/api';

const result = await api.get('/pets/{petId}', {
  params: { petId: '42' },
}).result();

if (result.ok) {
  result.data.id;   // typed: number — from the spec's Pet schema
  result.data.name; // typed: string
}
```

The plugin watches the spec file during dev and regenerates on change.

> **TypeScript setup:** The plugin generates a `fetcher-env.d.ts` ambient module declaration. Make sure it's covered by your `tsconfig.json` `include` glob. In SvelteKit, this means it must live inside `src/` (e.g., `output: './src/lib/api'`).

#### Option B: Manual setup (no plugin)

```typescript
import type { paths } from './generated/paths';
import { createFetch } from '@bajustone/fetcher';
import { fromOpenAPI } from '@bajustone/fetcher/openapi';
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

When the plugin generates `paths.d.ts`, it appends a pre-applied `Schema` helper (if the spec has `components.schemas`):

```typescript
import type { Schema } from './paths';

type Pet = Schema<'Pet'>;
//   ^? { id: number; name: string; tag?: string }
```

Without the plugin (or for manual setups), use `SchemaOf` directly:

```typescript
import type { SchemaOf } from '@bajustone/fetcher';
import type { components } from './generated/paths';

type Pet = SchemaOf<components, 'Pet'>;
```

#### Component schemas and validators

With the plugin, `virtual:fetcher` also exposes every component schema from the spec — usable with any JSON-Schema-aware tool. Two flavors:

```typescript
// Spec-canonical: JSON Schema draft-2020-12 with local $defs + $ref
import { schemas, validators } from 'virtual:fetcher';

// Fully-flattened: $refs resolved at build time (no $ref anywhere)
import { schemas as inlinedSchemas } from 'virtual:fetcher/inlined';
```

Pick based on what your consumer accepts:

```typescript
// AJV / TypeBox / any ref-aware consumer — use the canonical module
import Ajv from 'ajv/dist/2020';
import { schemas } from 'virtual:fetcher';
const ajv = new Ajv();
ajv.addSchema(schemas.User, 'User');

// Zod 4's fromJSONSchema, or any consumer that doesn't resolve $ref — use /inlined
import { z } from 'zod';
import { schemas } from 'virtual:fetcher/inlined';
const User = z.fromJSONSchema(schemas.User);

// Zero-dep runtime validation via the pre-compiled builder validators
import { validators } from 'virtual:fetcher';
const result = await validators.User['~standard'].validate(input);
if (!result.issues) handleValid(result.value);
```

Recursive components (e.g., a tree with self-reference) can only be used via the canonical module — the `/inlined` subpath emits a throwing getter for them with an actionable message. Use `validators.Tree` for runtime validation of recursive types.

For inlining a JSON Schema that didn't come from fetcher (e.g., an external schema you want to drop into a consumer that doesn't resolve `$ref`), the core package exports an `inline()` helper — memoized by input identity, throws on cycles:

```typescript
import { inline } from '@bajustone/fetcher/openapi';
const flat = inline(someExternalSchema);
```

Opt out entirely with `fetcherPlugin({ spec: ..., components: false })` — only `routes` is exported, no `schemas`/`validators` ship.

#### Spec linting

`lintSpec(spec)` flags every keyword the runtime validator does NOT enforce (e.g., `format: 'email'` types as `string` but runtime accepts non-emails). Run from CI:

```typescript
import { lintSpec } from '@bajustone/fetcher/spec-tools';
import spec from './openapi.json' with { type: 'json' };

const issues = lintSpec(spec);
if (issues.length > 0) {
  for (const i of issues)
    console.error(`${i.severity}: ${i.pointer} — ${i.message}`);
  process.exit(1);
}
```

#### Spec coverage

`coverage(spec)` reports per-route schema complexity — which routes are fully typed, which fall back to `unknown`, and why:

```typescript
import { coverage } from '@bajustone/fetcher/spec-tools';
import spec from './openapi.json' with { type: 'json' };

const report = coverage(spec);

console.log(report.summary);
// { total: 24, fullyTyped: 18, partial: 4, untyped: 2 }

for (const route of report.routes) {
  if (route.fallbackReasons.length > 0) {
    console.warn(`${route.method} ${route.path}:`, route.fallbackReasons);
  }
}
```

Each route in `report.routes` includes `bodyTyped`, `responseTyped`, `errorTyped` flags and a `fallbackReasons` array explaining why any slot couldn't be fully typed (e.g., unsupported `oneOf`/`allOf` combinations, recursive `$ref`).

### 2. Manual route schemas

```typescript
import { createFetch } from '@bajustone/fetcher';
import { object, string } from '@bajustone/fetcher/schema';

const f = createFetch({
  baseUrl: 'https://api.example.com',
  routes: {
    '/users/{id}': {
      GET: {
        params: object({ id: string() }),
        response: object({ id: string(), name: string() }),
      },
    },
  },
});

const result = await f.get('/users/{id}', { params: { id: '42' } }).result();
if (result.ok) {
  result.data; // { id: string; name: string }
}
```

Any Standard Schema V1 schema works — the bundled `@bajustone/fetcher/schema` builder shown above, Zod 3.24+, Valibot, ArkType, or any value with a `~standard.validate` property. See [Native schema builder](#native-schema-builder) below for the full builder surface.

### 3. Ad-hoc per-call schema

```typescript
import { createFetch } from '@bajustone/fetcher';
import { boolean, object } from '@bajustone/fetcher/schema';

const f = createFetch({ baseUrl: 'https://api.example.com' });

const result = await f.get('/endpoint', {
  responseSchema: object({ ok: boolean() }),
}).result();

if (result.ok) {
  result.data.ok; // typed boolean
}
```

The per-call `responseSchema` wins over any route-declared `response`.

## Native schema builder

`@bajustone/fetcher/schema` ships a JSON-Schema-producing builder with pre-compiled validators. Factories return plain JSON Schema objects with a `~standard.validate` closure baked in at construction time — no runtime interpreter, no class hierarchy, no external dependencies. Drop straight into any `RouteDefinition` slot.

```typescript
import {
  array,
  email,
  integer,
  object,
  optional,
  string,
} from '@bajustone/fetcher/schema';
import type { Infer } from '@bajustone/fetcher/schema';

const Pet = object({
  id:    integer(),
  name:  string({ minLength: 1 }),
  email: email(),                 // { type: 'string', format: 'email', pattern: <regex> }
  tags:  array(string()),
  owner: optional(string()),
});

type Pet = Infer<typeof Pet>;
// { id: number; name: string; email: string; tags: string[]; owner?: string }
```

Every factory is annotated `/*@__NO_SIDE_EFFECTS__*/`, so a bundler eliminates any factory whose result is unused. Bundle cost is pay-as-used — importing only `string` produces a ~330 B gzipped fixture; a typical `object({ id: integer(), name: string() })` schema lands around 800 B gzipped.

### What's in the box

| Category | Factories |
|---|---|
| Primitives | `string`, `number`, `integer`, `boolean`, `null_`, `literal`, `unknown`, `undefined_`, `any_`, `never_`, `bigint_` |
| Number convenience | `positive`, `nonnegative`, `negative`, `nonpositive`, `finite`, `safe` |
| Composites | `object`, `array`, `optional`, `nullable`, `union`, `intersect`, `enum_`, `record`, `tuple` |
| Object composition | `partial`, `required`, `pick`, `omit`, `extend`, `merge`, `keyof_` |
| Predicates & defaults | `refined(schema, predicate, msg?)`, `default_(schema, fallback)` |
| Tagged | `discriminatedUnion(key, { tag: variant })` — O(1) dispatch by property lookup |
| Refs | `ref(name)` + `compile(schema, defs)` — lazy, cycle-safe binding |
| Formats | `email`, `url`, `uuid`, `datetime`, `date`, `time` — each emits both `format` and an enforcing `pattern` |
| Meta | `brand<B>()`, `describe(schema, text)`, `title(schema, text)` |
| Errors | `formatIssues(issues, opts?)` display helper |

### Discriminated unions

```typescript
import { discriminatedUnion, literal, number, object } from '@bajustone/fetcher/schema';

const Shape = discriminatedUnion('kind', {
  circle: object({ kind: literal('circle' as const), radius: number() }),
  square: object({ kind: literal('square' as const), side: number() }),
});

// Dispatches by the `kind` property; unknown tags fail fast with
// { message: 'Unknown discriminator', path: ['kind'] }
// TypeScript narrowing via `kind` works naturally:
type ShapeValue = Infer<typeof Shape>;
function area(s: ShapeValue) {
  if (s.kind === 'circle') return Math.PI * s.radius ** 2;
  return s.side ** 2;
}
```

### Recursive schemas

```typescript
import { array, compile, number, object, ref } from '@bajustone/fetcher/schema';

interface TreeNode { value: number; children: TreeNode[] }

const Tree = object({
  value:    number(),
  children: array(ref<TreeNode>('Tree')),
});

compile(Tree, { Tree });
// lazy-binds the ref; the resolver caches on first call.
// Self-references terminate on input depth, not construction depth.
```

`compile` walks the tree once and rebinds every ref node to a lazy resolver closed over its target. Mutual recursion works the same way — pass multiple entries in `defs`.

### Custom patterns and format helpers

```typescript
import { string } from '@bajustone/fetcher/schema';

const Slug = string({ minLength: 1, maxLength: 64, pattern: '^[a-z0-9-]+$' });
const E164 = string({ pattern: '^\\+[1-9]\\d{1,14}$' });
```

Format helpers (`email()`, `url()`, etc.) always pair the `format` keyword with a runtime-enforcing `pattern` — closing the gap where most validators tag `format: 'email'` but accept any string at runtime.

### Bridging raw JSON Schema

When you already have a JSON Schema object — from an OpenAPI spec, a legacy source, or `virtual:fetcher`'s generated component schemas — use `fromJSONSchema` from `@bajustone/fetcher/openapi` to produce the same pre-compiled validator:

```typescript
import { fromJSONSchema } from '@bajustone/fetcher/openapi';

const User = fromJSONSchema<{ id: number; name: string }>({
  type: 'object',
  properties: { id: { type: 'integer' }, name: { type: 'string' } },
  required: ['id', 'name'],
});
```

`fromJSONSchema` dispatches each keyword to the matching builder factory, so the result tree-shakes identically.

### Custom predicates and defaults

```typescript
import { default_, integer, object, refined, string } from '@bajustone/fetcher/schema';

const Password = refined(
  string({ minLength: 8 }),
  (s) => /[A-Z]/.test(s) && /\d/.test(s),
  'must contain uppercase and digit',
);

const User = object({
  name: string(),
  theme: default_(string(), 'light'),  // missing → 'light'; present value validates normally
});
```

`refined` runs the base schema first, then your predicate; failure emits `code: 'refine_failed'`. `default_` fires only on `undefined` / missing object keys — any present value goes through the base schema unchanged. `default_` keeps the key required-typed so consumers always see the value.

### Error display

```typescript
import { formatIssues } from '@bajustone/fetcher/schema';

const r = schema['~standard'].validate(data);
if (r.issues) console.error(formatIssues(r.issues));
// user.email: Pattern mismatch
// user.age: Too small
// items.0.name: Missing
```

Optional `{ separator, pathJoiner, pathMessageSeparator }` for custom formatting. Every builder-emitted issue also carries a stable snake_case `code` (`expected_string`, `too_short`, `missing`, `refine_failed`, …) for i18n or structured error mapping.

### What's intentionally out of scope

The builder exposes only keywords the runtime can enforce. If you need any of these, reach for Zod / Valibot / ArkType — they all drop in via Standard Schema V1.

- **No transforms** — `.transform()`, `.pipe()`, `.preprocess()`, `.coerce()`, `.catch()`. The builder validates wire data as-is.
- **No compositional sugar** beyond what ships (`partial`, `pick`, `omit`, `extend`, `merge`, `keyof_`).
- **No conditional schemas** — `if` / `then` / `else`, `dependentSchemas`, `dependentRequired`.
- **No array tuples beyond `tuple`** — no `contains`, `uniqueItems`.
- **No async validation** — sync only; async validation belongs at the fetch or form layer.

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

### Error message extraction

`extractErrorMessage(error)` turns any `FetcherError` into a human-readable string:

```typescript
import { extractErrorMessage } from '@bajustone/fetcher';

const result = await f.get('/users').result();
if (!result.ok) {
  console.error(extractErrorMessage(result.error));
  // "Network error"          — kind: 'network'
  // "id: expected string"    — kind: 'validation'
  // "User not found"         — kind: 'http' (extracts body.message or body.error.message)
  // "HTTP 500"               — kind: 'http' (fallback)
}
```

### `.unwrap()` — throwing alternative for server-side code

`.unwrap()` returns `data` directly on success, or throws a `FetcherRequestError` on failure. Use it in server-side contexts where framework error boundaries catch thrown errors:

```typescript
// SvelteKit load function
export const load: PageServerLoad = async ({ fetch }) => {
  const users = await f.get('/users', { fetch }).unwrap();
  return { users }; // typed, no if-not-ok boilerplate
};

// SvelteKit remote function
export const getUsers = query(async () => {
  return f.get('/users').unwrap();
});

// Next.js server component
async function UsersPage() {
  const users = await f.get('/users').unwrap();
  return <UserList users={users} />;
}
```

`FetcherRequestError` extends `Error` and carries `.status` (HTTP code or 500) and `.fetcherError` (the full discriminated union):

```typescript
try {
  await f.get('/users').unwrap();
} catch (err) {
  if (err instanceof FetcherRequestError) {
    err.status;        // 404, 500, etc.
    err.fetcherError;  // { kind: 'http', status: 404, body: ... }
  }
}
```

### `.query()` — cache-friendly descriptor for TanStack Query, SWR, etc.

`.query()` returns `{ key, fn }` — a deterministic cache key and an async function that calls `.unwrap()`. Does not trigger the fetch; the caching library calls `fn()` when it needs data:

```typescript
import { createQuery } from '@tanstack/svelte-query'; // or react-query, vue-query

const { key, fn } = f.get('/users', { query: { page: 1 } }).query();
// key: ['GET', '/users', { page: 1 }]
// fn:  () => Promise<User[]>

// TanStack Query
const users = createQuery({ queryKey: key, queryFn: fn });

// SWR
const { data } = useSWR(key, fn);
```

Use `.query()` for optimistic updates — the key identifies the cache entry:

```typescript
const { key: usersKey } = f.get('/users').query();
queryClient.setQueryData(usersKey, (old) => [...old, optimisticUser]);
```

### When to use which

| Method | Returns | Throws? | Use when |
|--------|---------|---------|----------|
| `.result()` | `{ ok, data } \| { ok, error }` | Never | Partial success, custom error handling |
| `.unwrap()` | `data` | `FetcherRequestError` | Load functions, remote functions, server actions |
| `.query()` | `{ key, fn }` | `fn()` throws | TanStack Query, SWR, any caching library |

## Configuration reference

| Option | Type | Default | Description |
|---|---|---|---|
| `baseUrl` | `string` | — | **Required.** Prepended to every request path. No trailing slash needed. |
| `routes` | `Routes` | `{}` | Route schemas — from `fromOpenAPI(spec)`, the Vite plugin, or hand-written. |
| `middleware` | `Middleware[]` | `[]` | Request/response pipeline, executed in order. |
| `defaultHeaders` | `Record<string, string>` | `{}` | Headers merged into every outgoing request. Per-call headers win. |
| `fetch` | `FetchFn` | `globalThis.fetch` | Custom fetch implementation (SvelteKit load `fetch`, Cloudflare Workers, test mocks). |
| `timeout` | `number` | — | Auto-prepend a `timeout()` middleware (ms). Per-call `timeout` overrides. |
| `retry` | `number \| RetryOptions` | — | Auto-prepend a `retry()` middleware. Number shorthand = `{ attempts: n }`. Per-call `retry` overrides. |

## Middleware

```typescript
import { bearerWithRefresh, createFetch } from '@bajustone/fetcher';
import type { paths } from './paths';

const f = createFetch<paths>({
  baseUrl: 'https://api.example.com',
  retry: 3,
  timeout: 5_000,
  middleware: [
    bearerWithRefresh<paths>({
      getToken: () => sessionStorage.getItem('access_token'),
      refresh: async () => {
        const r = await fetch('/auth/refresh', { method: 'POST' });
        const { access_token } = await r.json();
        sessionStorage.setItem('access_token', access_token);
        return access_token;
      },
      // Typed against paths keys — typos are caught at compile time
      exclude: ['/auth/login', '/auth/logout', '/auth/refresh'],
    }),
  ],
});
```

### Built-in middlewares

| Middleware | Purpose |
|---|---|
| `authBearer(getToken)` | Attaches `Authorization: Bearer <token>` per request. |
| `bearerWithRefresh<Paths>(opts)` | Bearer auth + 401-refresh-retry. Concurrent 401s share one in-flight refresh. The `exclude` field lists paths that skip auth entirely — typed against the `Paths` generic for autocomplete and compile-time typo checking. |
| `retry(opts)` | Re-invokes the chain on retryable failures. Defaults: 3 attempts, exponential backoff with jitter, retries on `[408, 425, 429, 500, 502, 503, 504]`. Honors `Retry-After`. |
| `timeout(ms)` | Aborts a single request after `ms` ms. Merged with any user signal. |

### Custom middleware

A middleware is an async function that receives a `Request` and a `next` function, and returns a `Response`. Call `next()` to continue the chain:

```typescript
import type { Middleware } from '@bajustone/fetcher';

const logger: Middleware = async (request, next) => {
  console.log('→', request.method, request.url);
  const response = await next(request);
  console.log('←', response.status);
  return response;
};

const f = createFetch({
  baseUrl: 'https://api.example.com',
  middleware: [logger],
});
```

You can modify the request before calling `next`, inspect or transform the response after, or skip `next` entirely to short-circuit:

```typescript
const cacheMiddleware: Middleware = async (request, next) => {
  const cached = cache.get(request.url);
  if (cached) return cached;              // short-circuit
  const response = await next(request);
  cache.set(request.url, response.clone());
  return response;
};
```

### `exclude` matching in `bearerWithRefresh`

The `exclude` option determines which paths skip auth. It accepts four forms:

| Form | Matching behavior |
|---|---|
| `string` | **Exact pathname match** — `"/auth/login"` matches only `/auth/login`, not `/auth/login/setup`. |
| `string[]` | Exact match against any entry in the array. |
| `RegExp` | Tested against the full request URL. |
| `(request: Request) => boolean` | Arbitrary predicate — return `true` to skip auth. |

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
| `extractErrorMessage(error)` | Turns a `FetcherError` into a human-readable string. Handles all three error kinds. |
| `FetcherRequestError` | Error class thrown by `.unwrap()`. Carries `.status`, `.fetcherError`, and `.message`. |
| `authBearer(getToken)` | Bearer-token middleware. |
| `bearerWithRefresh(opts)` | Bearer auth + 401-refresh-retry middleware with `exclude` list. |
| `retry(opts)` | Retry middleware (number shorthand or `RetryOptions`). |
| `timeout(ms)` | Per-request timeout middleware. |

### Schema builder (`@bajustone/fetcher/schema`)

| Export | Purpose |
|---|---|
| `string`, `number`, `integer`, `boolean`, `null_`, `literal`, `unknown`, `undefined_`, `any_`, `never_`, `bigint_` | Primitive factories. |
| `positive`, `nonnegative`, `negative`, `nonpositive`, `finite`, `safe` | Number convenience wrappers. |
| `object`, `array`, `optional`, `nullable`, `union`, `intersect`, `enum_`, `record`, `tuple` | Composites. |
| `partial`, `required`, `pick`, `omit`, `extend`, `merge`, `keyof_` | Object composition helpers. |
| `refined(schema, predicate, msg?)`, `default_(schema, fallback)` | Custom predicates and undefined-only defaults. |
| `discriminatedUnion(key, map)` | O(1) tagged-union dispatch. |
| `ref(name)` + `compile(schema, defs)` | Lazy, cycle-safe `$ref` binding. |
| `email`, `url`, `uuid`, `datetime`, `date`, `time` | Format helpers — emit `format` + enforcing `pattern`. |
| `brand<B>()`, `describe`, `title` | Type-level brand + JSON Schema annotations. |
| `formatIssues(issues, opts?)` | Display helper for issue arrays. |
| `Infer<typeof X>` | Extract the validated output type. |

### OpenAPI / JSON Schema (`@bajustone/fetcher/openapi`)

| Export | Purpose |
|---|---|
| `fromOpenAPI(spec)` | Converts an OpenAPI 3.x spec into routes with runtime validators. |
| `fromJSONSchema(schema, defs?)` | Raw JSON Schema → compiled builder validator. |
| `inline(schema)` | Dereferences local `$ref` into a self-contained JSON Schema (memoized, throws on cycles). |
| `extractRouteSchemas`, `extractComponentSchemas`, `bundleComponent`, `translateDialect`, `JSON_SCHEMA_DIALECT` | Build-time helpers used by the Vite plugin. |

### Spec tools (`@bajustone/fetcher/spec-tools`)

| Export | Purpose |
|---|---|
| `lintSpec(spec)` | Walks an OpenAPI 3.x spec; returns every keyword the runtime validator doesn't enforce. |
| `coverage(spec)` | Walks an OpenAPI 3.x spec; reports per-route schema complexity. |

### Plugin export (`@bajustone/fetcher/vite`)

| Export | Purpose |
|---|---|
| `fetcherPlugin(opts)` | Rollup/Vite plugin. Auto-generates `paths.d.ts` (with `Schema` helper), provides `virtual:fetcher` module exporting route schemas, watches spec during dev. Optionally fetches spec from a remote URL. |

### Types

`TypedFetchFn`, `TypedFetchPromise`, `TypedResponse`, `ResultData`, `QueryDescriptor`, `FetcherError`, `FetcherErrorLocation`, `FetchConfig`, `Middleware`, `RetryOptions`, `RouteDefinition`, `Routes`, `Schema`, `SchemaOf`, `StandardSchemaV1`, `BearerWithRefreshOptions<Paths>`, `FetcherPluginOptions`, `SpecDriftIssue`, `SpecCoverageReport`, `RouteCoverage`, `InferRoutesFromSpec`, `InferOutput`.

See [`docs/architecture.md`](./docs/architecture.md) for implementation details.

## License

MIT
