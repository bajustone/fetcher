# @bajustone/fetcher

Schema-validated, typed fetch client with OpenAPI support. ~4.0 kB gzipped for the tree-shaken core, pay-as-used for the optional schema builder (string-only: ~650 B). Sizes are CI-enforced (`scripts/check-size.ts`).

Published on [npm](https://www.npmjs.com/package/@bajustone/fetcher) and [JSR](https://jsr.io/@bajustone/fetcher). Runs on Node.js, Bun, Deno, modern browsers, and edge runtimes — the runtime matrix is proven in CI, not just claimed.

### Why fetcher over openapi-fetch?

[openapi-fetch](https://openapi-ts.dev/openapi-fetch/) gives you typed paths from an OpenAPI spec. fetcher does that too — still comfortably under openapi-fetch's ~6 kB — and adds:

- **Runtime validation** — responses are validated against your schemas at runtime, not just at compile time. Catch API drift before it breaks your UI.
- **Recursive middleware** — Hono/Koa-shaped dispatcher with per-call override (`middleware: false`). Built-in `bearerWithRefresh` and `cookieAuth` with concurrent-401 dedup and typed `exclude`.
- **Batteries included** — retry with backoff/jitter, timeout, error extraction, `.result()` / `.unwrap()` / `.query()` primitives, instance forking via `.with()`.
- **Standard Schema V1** — not locked to Zod. Works with the bundled native schema builder, Valibot, ArkType, or any value with `~standard.validate`.

## Features

- **100% native fetch** — the returned object is a real `Response`. All native methods (`.json()`, `.text()`, `.blob()`, `.headers`, `.status`) work alongside `.result()`.
- **One-liner `.result()`** — `await f.get('/pets').result()` collapses two awaits into one. Returns a discriminated union `{ ok: true; data } | { ok: false; error }`. Never throws. Idempotent.
- **Discriminated `FetcherError`** — `{ kind: 'network' | 'timeout' | 'aborted' | 'validation' | 'http', ... }`. Transport failures, deadline expiry, intentional cancellation, schema-validation issues, and HTTP error responses are all distinguishable without `instanceof` checks.
- **Lazy dispatch** — the request fires on the first `await` / `.then()` / `.result()` / `.unwrap()`, never at call time. `.query()` builds a cache descriptor without touching the network.
- **Standard Schema V1** — works with Zod 3.24+, Valibot, ArkType, the native `@bajustone/fetcher/schema` builder, or any value with a `~standard.validate` property.
- **Native schema builder** — `@bajustone/fetcher/schema` exports `string`, `object`, `optional`, `discriminatedUnion`, format helpers, and a `compile` pass for `$ref` resolution. Each factory is tree-shakeable (`@__NO_SIDE_EFFECTS__`) and validators are compiled at construction time — no runtime interpreter.
- **OpenAPI 3.x** — `fromOpenAPI(spec)` (from `@bajustone/fetcher/openapi`) builds runtime validators from a spec. Pass an `openapi-typescript`-generated `paths` interface as a generic for full body/response/error type inference — or skip codegen entirely with an inline `as const` spec.
- **Vite/Rollup plugin** — `fetcherPlugin()` auto-generates `paths.d.ts`, provides a `virtual:fetcher` module exporting pre-built route schemas, and watches the spec for changes during dev. Optionally fetches the spec from a remote URL. Import as `@bajustone/fetcher/vite`.
- **Composable middleware** — Hono/Koa-shaped recursive dispatcher. Per-call `middleware: false` or `middleware: [...]` override.
- **Built-in middlewares** — `authBearer`, `bearerWithRefresh` (with concurrent-401 dedup and typed `exclude` list), `cookieAuth` (login/refresh dance for server-side cookie sessions), `timeout`, `retry` (exponential backoff with jitter, honors `Retry-After`, idempotent methods only by default). Plus `parseSetCookie` for converting `Set-Cookie` response headers into `Cookie` request strings.
- **Built-in error extraction** — `extractErrorMessage(error)` turns any `FetcherError` into a human-readable string. No per-project helper needed.
- **Method shortcuts** — `f.get(path)`, `f.post(path, opts)`, `f.put`, `f.delete`, `f.patch`, `f.head`, `f.options`. The `options` argument is *required at the type level* when the route declares a body or the path has `{params}` — a forgotten body is a compile error.
- **Instance forking** — `f.with(overrides)` returns a sibling client inheriting everything from the parent except the named overrides.
- **Dynamic headers** — `getHeaders` config hook for per-request header sources (request-scoped auth contexts, CSRF tokens, trace IDs).
- **Per-call `fetch` override** — drop in SvelteKit's load `fetch`, Cloudflare's `fetch`, or any custom implementation.

## Installation

```bash
# npm (compiled ESM + .d.ts, with source maps for go-to-definition)
npm install @bajustone/fetcher

# JSR (raw TypeScript source)
deno add jsr:@bajustone/fetcher
bunx jsr add @bajustone/fetcher
npx jsr add @bajustone/fetcher
```

The package is **ESM-only** and declares `engines.node >= 20.19` (the first line where `require(esm)` works). Zero runtime dependencies.

> [!NOTE]
> Installing directly from git (`npm install github:bajustone/fetcher`) is not supported: the npm entry points resolve to the compiled `dist/`, which only exists in published releases. Use the npm or JSR registry.

### Supported runtimes

| Runtime | Versions | Verified by |
|---|---|---|
| Node.js | 20.19+, 22, 24 | CI conformance smoke (`scripts/smoke.mjs`) against the built artifact |
| Bun | current | CI smoke |
| Deno | current | CI smoke |
| Browsers | modern (native `fetch` + `AbortSignal`) | — see [SECURITY.md](./SECURITY.md) for credential-redirect version floors |
| Edge workers | Cloudflare Workers, Vercel Edge, etc. | API surface is fetch-standard only |

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
    case 'timeout':    console.error('timed out', result.error.cause); break;
    case 'aborted':    break; // caller cancelled — usually no UI feedback needed
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

> Requests are **lazy**: `f.get(...)` dispatches nothing until the promise is consumed (`await`, `.then()`, `.result()`, `.unwrap()`). Building a `.query()` descriptor never touches the network.

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
      fetchTimeoutMs: 30_000, // optional: abort the remote fetch after this (default 30 s)
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

The plugin watches the spec file during dev and regenerates on change. A timed-out or failed remote fetch falls back to the cached copy, then the local `spec` file.

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

#### Option C: Zero-codegen (inline `as const` spec)

For small specs or prototypes, you can skip `openapi-typescript` entirely and let fetcher walk the spec at the type level. The inferred types flow all the way to call sites — `r.data` below is typed with **no codegen step at all**. Works when the spec is narrowly typed — typically by pasting it into a `.ts` file with `as const`:

```typescript
import { createFetch } from '@bajustone/fetcher';
import { fromOpenAPI } from '@bajustone/fetcher/openapi';

const spec = {
  paths: {
    '/pets/{id}': {
      get: {
        responses: {
          200: {
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Pet' },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Pet: {
        type: 'object',
        properties: { id: { type: 'integer' }, name: { type: 'string' } },
        required: ['id', 'name'],
      },
    },
  },
} as const;

const f = createFetch({ baseUrl: 'https://api.example.com', routes: fromOpenAPI(spec) });
const r = await f.get('/pets/{id}', { params: { id: '1' } }).result();
if (r.ok) r.data.name; // typed: string
```

A `requestBody` marked `required: true` makes the call-site `body` required (a missing body is a compile error); an optional `requestBody` keeps it optional. `default` responses type as the error catch-all, never the success body — consistently with the runtime and the codegen path.

`as const` is load-bearing — without it, TypeScript widens string literals (so `type: 'integer'` becomes `type: string`) and the spec-walker collapses to `unknown`. Plain `import spec from './openapi.json'` also widens. For large specs, the `openapi-typescript` codegen path is still the right call — it's mature, handles every edge case, and keeps TypeScript's conditional-type budget under control. This zero-codegen path is an addition, not a replacement.

`JSONSchemaToType<Schema, Defs?>` is exported from the core package if you want to type a response manually without round-tripping through `InferRoutesFromSpec`.

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

For inlining a JSON Schema that didn't come from fetcher (e.g., an external schema you want to drop into a consumer that doesn't resolve `$ref`), the core package exports an `inline()` helper — memoized by input identity, returns a frozen, self-contained schema:

```typescript
import { inline } from '@bajustone/fetcher/openapi';
const flat = inline(someExternalSchema);
```

`inline()` throws `InlineCycleError` on cyclic refs (a recursive schema cannot be flattened) and `InlineUnresolvedRefError` on refs it cannot resolve against the schema's own `$defs` — so a schema that is *not* actually self-contained never escapes silently. Pass `{ onUnresolved: 'keep' }` to leave unresolvable refs in place instead when a downstream consumer can resolve them itself.

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

Each route in `report.routes` includes `bodyTyped` / `responseTyped` / `errorTyped` flags plus three issue arrays:

- **`fallbackReasons`** — schema features that defeat `JSONSchemaToType` inference (`patternProperties`, `propertyNames`, `prefixItems`, `if`/`then`/`else`, conditional schemas, recursive `$ref`). Note: `oneOf`/`anyOf`/`allOf` are *not* flagged — they're handled natively by the v0.4.0 converter.
- **`unsupportedKeywords`** — keywords this route uses (transitively via `$ref`) that the runtime silently ignores (`format`, `multipleOf`, `exclusiveMinimum`/`Maximum`, `patternProperties`, `propertyNames`, `if`/`then`/`else`, `dependentSchemas`, `dependentRequired`, `prefixItems`, `additionalItems`, `not`, `uniqueItems`, `min`/`maxProperties`, the `contains` family, `unevaluated*`, `content*`, `$dynamicRef`, sub-schema `additionalProperties`, tuple-shaped `items`). Route-level aggregate of what `lintSpec` flags at the keyword level.
- **`integrityIssues`** — spec-level integrity problems worth catching in CI:
  - `discriminator_mismatch` — a `oneOf` variant lacks the discriminator property or uses a non-`const`/single-`enum` value.
  - `discriminator_duplicate` — two variants share the same discriminator tag.
  - `required_without_property` — an `object` schema lists a key in `required` that isn't in `properties` (likely a typo; every request will fail with `missing`).
  - `unreachable_response` — a response declares content in a media type fetcher's default extractor won't match (anything other than `application/json`, `*+json` types, or `*/*`).

Example CI gate:

```typescript
import { coverage } from '@bajustone/fetcher/spec-tools';
import spec from './openapi.json' with { type: 'json' };

const report = coverage(spec);
if (report.summary.withIntegrityIssues > 0) {
  for (const route of report.routes) {
    for (const issue of route.integrityIssues) {
      console.error(`${issue.kind} at ${issue.pointer}: ${issue.message}`);
    }
  }
  process.exit(1);
}
```

`lintSpec()` and `coverage()` are complementary: use both as CI gates. `lintSpec` catches runtime-unenforced keywords site-by-site; `coverage` aggregates per route and adds spec-integrity checks.

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

A route's declared `body` schema runs **even when you omit the body** — a forgotten required body is a `validation` error, not a silent empty request. Schemas for optional bodies must accept `undefined` (`fromOpenAPI` does this automatically when the spec says `requestBody.required: false`).

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

Every factory is annotated `/*@__NO_SIDE_EFFECTS__*/`, so a bundler eliminates any factory whose result is unused. Bundle cost is pay-as-used — importing only `string` produces a ~650 B gzipped fixture; a typical `object({ id: integer(), name: string() })` schema lands around 1.7 kB gzipped.

> **Naming convention:** factories whose natural name collides with a JavaScript reserved word or global carry a trailing underscore — `null_`, `undefined_`, `enum_`, `default_`, `any_`, `never_`, `bigint_`, `keyof_`. Everything else uses the plain name. This is deliberate and uniform, not an inconsistency.

### What's in the box

| Category | Factories |
|---|---|
| Primitives | `string`, `number`, `integer`, `boolean`, `null_`, `literal`, `unknown`, `undefined_`, `any_`, `never_`, `bigint_` |
| Number convenience | `positive`, `nonnegative`, `negative`, `nonpositive`, `finite`, `safe` |
| Composites | `object` (with `unknownKeys` policy), `array`, `optional`, `nullable`, `union`, `intersect`, `enum_`, `record`, `tuple` |
| Object composition | `partial`, `required`, `pick`, `omit`, `extend`, `extendSchema`, `merge`, `keyof_` |
| Predicates, defaults & transforms | `refined(schema, predicate, messageOrOptions?)`, `default_(schema, fallbackOrFactory)`, `transform(schema, ...fns)` |
| Tagged | `discriminatedUnion(key, { tag: variant })` — O(1) dispatch by property lookup |
| Refs | `ref(name)` + `compile(schema, defs)` — lazy, cycle-safe binding |
| Formats | `email`, `url`, `uuid`, `datetime`, `date`, `time` — each emits both `format` and an enforcing `pattern` |
| Meta | `brand<B>()`, `describe(schema, text)`, `title(schema, text)` |
| Parsing & errors | `parse`, `parseOrThrow`, `parseForm`, `groupIssuesByField`, `SchemaValidationError`, `formatIssues(issues, opts?)` |

Numbers reject `NaN` and `±Infinity` (JSON can't represent them), and string length constraints count **Unicode code points** (JSON Schema semantics), not UTF-16 units.

### Objects and unknown keys

`object()` accepts an `unknownKeys` option controlling keys not declared in the shape:

```typescript
import { object, string } from '@bajustone/fetcher/schema';

const Loose  = object({ id: string() });                              // default: 'passthrough'
const Strip  = object({ id: string() }, { unknownKeys: 'strip' });    // output keeps declared keys only
const Strict = object({ id: string() }, { unknownKeys: 'strict' });   // unknown key → issue (code 'unknown_key')
```

- `'passthrough'` (default) — unknown keys flow through untouched; this is JSON Schema's `additionalProperties: true` default and the zero-copy fast path.
- `'strip'` — returns a new object containing only declared keys.
- `'strict'` — every unknown key yields an issue, and the emitted JSON Schema carries `additionalProperties: false`.

An optional key present with value `undefined` is treated the same as a missing key (matching Zod).

### Discriminated unions

```typescript
import { discriminatedUnion, literal, number, object } from '@bajustone/fetcher/schema';

const Shape = discriminatedUnion('kind', {
  circle: object({ kind: literal('circle' as const), radius: number() }),
  square: object({ kind: literal('square' as const), side: number() }),
});

// Dispatches by the `kind` property; a missing tag fails with
// { code: 'missing_discriminator' }, an unmapped tag with
// { code: 'unknown_discriminator' } — both with path: ['kind'].
// TypeScript narrowing via `kind` works naturally:
type ShapeValue = Infer<typeof Shape>;
function area(s: ShapeValue) {
  if (s.kind === 'circle') return Math.PI * s.radius ** 2;
  return s.side ** 2;
}
```

Number and boolean tags work too — `{ version: 2 }` dispatches to mapping key `'2'`. A numeric/boolean-tagged variant should declare the tag property itself (e.g. `literal(2)`), since the auto-injected emitted `const` is the string mapping key.

Plain `union()` failures are actionable: the result starts with a summary issue (`no_variant_matched`, naming how many variants were tried) followed by the **best-matching** variant's issues with their original paths intact — not one opaque "no variant matched".

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

`compile` walks the tree once and rebinds every ref node to a lazy resolver closed over its target — reaching refs nested anywhere (defs targets, record values, tuple members, wrapped refs). Mutual recursion works the same way — pass multiple entries in `defs`.

### Custom patterns and format helpers

```typescript
import { string } from '@bajustone/fetcher/schema';

const Slug = string({ minLength: 1, maxLength: 64, pattern: '^[a-z0-9-]+$' });
const E164 = string({ pattern: '^\\+[1-9]\\d{1,14}$' });
```

Format helpers (`email()`, `url()`, etc.) always pair the `format` keyword with a runtime-enforcing `pattern` — closing the gap where most validators tag `format: 'email'` but accept any string at runtime. The regexes are deliberate:

- `email()` uses the WHATWG HTML5 `input[type=email]` grammar — battle-tested, linear-time (ReDoS-safe), the same reference regex Zod 4 ships.
- `datetime()` / `date()` / `time()` enforce RFC 3339 shapes **with field range checks** (month 01–12, day 01–31, hour 00–23, minute/second 00–59); calendar validity (e.g. Feb 30) is intentionally not checked.
- `uuid()` accepts RFC 9562 versions 1–8 plus the nil and max UUIDs.
- Every regex is flag-free, so the emitted `pattern` and the runtime check are guaranteed to agree.

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

### Custom predicates, defaults, and transforms

```typescript
import { array, default_, object, refined, string, transform } from '@bajustone/fetcher/schema';

const Password = refined(
  string({ minLength: 8 }),
  (s) => /[A-Z]/.test(s) && /\d/.test(s),
  'must contain uppercase and digit',
);

// Cross-field rules can attribute the failure to a specific field:
const Signup = refined(
  object({ password: string(), confirm: string() }),
  (o) => o.password === o.confirm,
  { message: 'Passwords must match', code: 'password_mismatch', path: ['confirm'] },
);

const User = object({
  name: string(),
  theme: default_(string(), 'light'),     // missing → 'light'; present value validates normally
  tags: default_(array(string()), () => []), // factory: fresh fallback per use
});

// Post-validation reshaping. Each step receives the previous step's output.
const DateFromISO = transform(
  string({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
  (s) => new Date(s),
  (d) => ({ date: d, year: d.getFullYear() }),
);
// Infer<typeof DateFromISO> = { date: Date; year: number }
```

- `refined` runs the base schema first, then your predicate. The third argument is either a message string or an options object `{ message, code, path }` — `code` defaults to `'refine_failed'`, and `path` lets `groupIssuesByField`/`parseForm` route a cross-field failure to the right field.
- `default_` fires only on `undefined` / missing object keys — any present value goes through the base schema unchanged. A **function** fallback is treated as a factory and called per use; an **object/array** fallback is `structuredClone`d per use, so no two validations share one mutable instance. Keeps the key required-typed so consumers always see the value.
- `transform` runs plain functions in sequence on the validated value. Base-schema failures short-circuit; transforms never see invalid input. A throwing transform yields a `transform_error` issue instead of an exception. Wrap with `refined` outside the `transform` if you need to reject after reshaping.

`transform` validates wire data as-is, then reshapes. The emitted JSON Schema reflects the wire shape only — downstream tools (OpenAPI, inline) see the input structure without the transforms. For wire-fidelity use cases, skip `transform`.

Wrapping an `optional()` or `default_` entry with `refined`/`transform` keeps both behaviors inside `object()` — the key's optional/default treatment and the wrapper's composed validator.

### Composing schemas you didn't build

`extend` requires a base whose properties are statically known (`FObject<Props>`). When the base is an opaque validator — `fromJSONSchema` output, or a `validators.*` entry from `virtual:fetcher` — use `extendSchema`:

```typescript
import { extendSchema, number } from '@bajustone/fetcher/schema';
import { validators } from 'virtual:fetcher';

const withId = extendSchema(validators.CreateUserBody, { id: number() });
//    ^? FSchema<CreateUserBody & { id: number }>
```

Both throw a `TypeError` if the base is not structurally an object schema (a union, a transform wrapper, a non-builder schema) — base validation would otherwise be silently dropped.

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

### Parsing in one line

For the common case, `parse` / `parseOrThrow` wrap `schema['~standard'].validate(data)`:

```typescript
import { parse, parseOrThrow, SchemaValidationError } from '@bajustone/fetcher/schema';

// Never throws — returns the native result union.
const r = parse(Pet, data);
if (r.issues) console.error(r.issues);
else use(r.value);

// Throws SchemaValidationError on failure — for server code that wants
// exceptions as control flow.
try {
  const pet = parseOrThrow(Pet, data);
  use(pet);
}
catch (err) {
  if (err instanceof SchemaValidationError) console.error(err.issues);
}
```

Both are standalone functions (not methods) and work with any Standard Schema V1 validator — the bundled builder, Zod, Valibot, ArkType. `parseOrThrow` is synchronous; for async validators, `await schema['~standard'].validate(data)` directly.

### Form-shaped parsing

`parseForm` validates and hands back a field-keyed errors map ready for form libraries; `groupIssuesByField` is the bare transform when you already have issues:

```typescript
import { groupIssuesByField, parseForm } from '@bajustone/fetcher/schema';

const result = parseForm(loginSchema, formData);
if (!result.ok) {
  result.errors; // Record<fieldName, message> — first issue per field; pathless issues land under '_form'
  result.issues; // the full raw list for richer error UX
} else {
  login(result.value);
}
```

### Narrowing the declared input type

Some integrations want a schema whose *input* generic is narrower than `unknown` — e.g. SvelteKit's `form(schema, handler)` expects `StandardSchemaV1<RemoteFormInput, Output>`. `withInputType` (from the core package) re-tags the input type at zero runtime cost:

```typescript
import { withInputType } from '@bajustone/fetcher';
import { validators } from 'virtual:fetcher';

const loginForm = form(withInputType<RemoteFormInput>()(validators.LoginBody), async (data) => {
  // data: the Output type of validators.LoginBody
});
```

It's curried (`withInputType<Input>()(schema)`) so you specify `Input` explicitly while `Output` stays inferred.

### What's intentionally out of scope

The builder exposes only keywords the runtime can enforce. If you need any of these, reach for Zod / Valibot / ArkType — they all drop in via Standard Schema V1.

- **No pre-validation transforms** — `.preprocess()`, `.coerce()`. Input into the validator stays as-is; wire data is verified literally. Post-validation reshaping is fine (see `transform`).
- **No error-swallowing fallbacks** — `.catch()`. If validation fails, fetcher surfaces the issues.
- **No compositional sugar** beyond what ships (`partial`, `required`, `pick`, `omit`, `extend`, `extendSchema`, `merge`, `keyof_`).
- **No conditional schemas** — `if` / `then` / `else`, `dependentSchemas`, `dependentRequired`.
- **No array tuples beyond `tuple`** — no `contains`, `uniqueItems`.
- **No async validation** — sync only; an async schema nested inside a sync combinator throws a `TypeError` instead of silently corrupting output. Async validation belongs at the fetch or form layer.

## Result and error model

`.result()` returns a discriminated union:

```typescript
type ResultData<T, HttpBody = unknown> =
  | { readonly ok: true;  readonly data: T }
  | { readonly ok: false; readonly error: FetcherError<HttpBody> }

type FetcherError<HttpBody = unknown> =
  | { readonly kind: 'network';    readonly cause: unknown }
  | { readonly kind: 'timeout';    readonly cause: unknown }
  | { readonly kind: 'aborted';    readonly cause: unknown }
  | { readonly kind: 'validation'; readonly location: 'body' | 'params' | 'query' | 'response';
      readonly issues: ReadonlyArray<StandardSchemaV1Issue>; readonly status?: number }
  | { readonly kind: 'http';       readonly status: number; readonly body: HttpBody }
```

The five kinds:

- **`'network'`** — the underlying fetch threw (DNS failure, connection refused, TLS error). `cause` holds the raw thrown value.
- **`'timeout'`** — a deadline expired: the `timeout()` middleware fired, or any abort whose reason is a `TimeoutError` `DOMException` (e.g. a user-supplied `AbortSignal.timeout(...)`).
- **`'aborted'`** — *you* cancelled the request via your `AbortSignal`. Distinguishing this from `'timeout'`/`'network'` lets UIs suppress error toasts for intentional cancellations.
- **`'validation'`** — a schema rejected the body/params/query (client-side, before the request was sent) or the response body. For `location: 'response'`, `status` carries the HTTP status of the response that failed validation — the status is never lost.
- **`'http'`** — the server returned 4xx/5xx. `body` is the parsed (and, with a declared `errorResponse` schema, validated) error body; a malformed-JSON error body surfaces here with the raw text as `body`.

`.result()` is available in two places:

- **On the promise:** `await f.get('/path').result()` — one-liner, resolves directly to `ResultData`.
- **On the response:** `const r = await f.get('/path'); await r.result()` — when you need the intermediate `Response` for headers, status, streaming, etc.

Both are idempotent and never throw.

> **Ordering note:** when you mix `.result()` with native body reads, call `.result()` **first**. It takes its internal body clone lazily on the first call (so responses whose `.result()` you never use don't buffer a second body copy); calling it *after* `.json()`/`.text()` consumed the body returns a structured error instead of working by accident.

### Error message extraction

`extractErrorMessage(error)` turns any `FetcherError` into a human-readable string — all five kinds handled:

```typescript
import { extractErrorMessage } from '@bajustone/fetcher';

const result = await f.get('/users').result();
if (!result.ok) {
  console.error(extractErrorMessage(result.error));
  // "getaddrinfo ENOTFOUND ..."          — kind: 'network' (unwraps cause)
  // "Request timed out after 5000ms"     — kind: 'timeout'
  // "Request aborted"                    — kind: 'aborted'
  // "id: Expected string"                — kind: 'validation' (path-prefixed issues)
  // "User not found"                     — kind: 'http' (extracts body.message or body.error.message)
  // "HTTP 500"                           — kind: 'http' (fallback)
}
```

### `.unwrap()` — throwing alternative for server-side code

`.unwrap()` returns `data` directly on success, or throws a `FetcherRequestError` subclass on failure. Use it in server-side contexts where framework error boundaries catch thrown errors:

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

`FetcherRequestError` extends `Error` and carries `.fetcherError` (the full discriminated union) plus a derived `.status` for framework boundaries:

| Failure | Thrown class | `.status` |
|---|---|---|
| HTTP 4xx/5xx | `FetcherHTTPError` (`.body` narrowed to the declared error type) | the response status |
| Request-side validation (`body`/`params`/`query`) | `FetcherValidationError` (`.location`, `.issues`) | `400` — the caller sent bad input |
| Response-side validation | `FetcherValidationError` | the response's error status, or `502` when it was a 2xx (the upstream broke its contract) |
| Timeout | `FetcherTimeoutError` (`.cause`) | `408` |
| Caller abort | `FetcherAbortError` (`.cause`) | `499` (client closed request) |
| Transport failure | `FetcherNetworkError` (`.cause`) | `500` |

Catch the base class for blanket handling, or `instanceof` the subclass you care about:

```typescript
import { FetcherHTTPError, FetcherRequestError, FetcherValidationError } from '@bajustone/fetcher';

try {
  await f.get('/users').unwrap();
} catch (err) {
  if (err instanceof FetcherHTTPError) {
    err.status; // 404, 500, ...
    err.body;   // the declared error body type
  } else if (err instanceof FetcherValidationError) {
    err.issues; // ReadonlyArray<StandardSchemaV1Issue>
  } else if (err instanceof FetcherRequestError) {
    err.fetcherError; // full discriminated union
  }
}
```

### `.query()` — cache-friendly descriptor for TanStack Query, SWR, etc.

`.query()` returns `{ key, fn }` — a deterministic cache key and an async function that calls `.unwrap()`. It is honestly lazy: calling `.query()` dispatches **nothing**, and `fn()` performs a **fresh request on every invocation**, so cache refetches and invalidations actually hit the network:

```typescript
import { createQuery } from '@tanstack/svelte-query'; // or react-query, vue-query

const { key, fn } = f.get('/users', { query: { page: 1 } }).query();
// key: ['GET', 'https://api.example.com/users', { query: { page: 1 } }]
// fn:  () => Promise<User[]>   — each call = a new request

// TanStack Query
const users = createQuery({ queryKey: key, queryFn: fn });

// SWR
const { data } = useSWR(key, fn);
```

The key shape is `[method, fullUrl, inputs?]` where `fullUrl` is the joined `baseUrl + path` and `inputs` bundles whichever of `{ params, query, body }` were supplied — so two clients forked onto different `baseUrl`s, or two mutations with different bodies, never collide on one key.

Use `.query()` for optimistic updates — the key identifies the cache entry:

```typescript
const { key: usersKey } = f.get('/users').query();
queryClient.setQueryData(usersKey, (old) => [...old, optimisticUser]);
```

### When to use which

| Method | Returns | Throws? | Use when |
|--------|---------|---------|----------|
| `.result()` | `{ ok, data } \| { ok, error }` | Never | Partial success, custom error handling |
| `.unwrap()` | `data` | `FetcherRequestError` subclass | Load functions, remote functions, server actions |
| `.query()` | `{ key, fn }` | `fn()` throws | TanStack Query, SWR, any caching library |

## Request and response semantics

The data plane is fully specified — these are the behaviors the conformance smoke asserts on every supported runtime.

### URL joining

- `baseUrl` and `path` are joined with **exactly one slash** at the seam: a trailing-slash `baseUrl` doesn't produce `//`, a missing slash doesn't corrupt the host.
- An absolute-URL path (`https://...`) is used **as-is** — it does not concatenate onto `baseUrl`.
- `{param}` placeholders are interpolated from `params` and URL-encoded. A path template whose `params` are missing (even when the object is omitted entirely) is a `validation` error — the literal `{id}` is never sent to the server.

### Query serialization

- Arrays serialize as repeated keys: `{ ids: [1, 2] }` → `ids=1&ids=2` (OpenAPI `form`/`explode=true` — what openapi-typescript-generated types imply).
- `Date` values serialize as ISO 8601.
- `undefined`/`null` entries are dropped.
- Plain-object values are a `validation` error (no universal wire encoding — not `[object Object]`).
- A path already containing `?` merges additional parameters with `&`.
- A custom `querySerializer` (global config or per-call) takes over completely — return a ready string or a `URLSearchParams`.

### Request bodies

- `string`, `FormData`, `Blob`, `ArrayBuffer`, `URLSearchParams`, any `ArrayBuffer` view (`Uint8Array`, …), and `ReadableStream` bodies pass through to the wire untouched. Stream bodies get `duplex: 'half'` automatically.
- Everything else is `JSON.stringify`'d, with `Content-Type: application/json` defaulted only when fetcher did the encoding.
- The **validated output** of your body/params/query schemas is what goes on the wire — Standard Schema transforms and defaults apply to the request, not just the types.
- Lowercase `method: 'post'` hits the same route definition (and validation) as `'POST'`.

### Response handling

- `application/json` plus the RFC 6839 `*+json` family (`application/problem+json`, `application/vnd.api+json`, …) parse as JSON.
- The HTTP status is never lost: a malformed-JSON error body surfaces as `kind: 'http'` with the raw text as `body`; response-side validation errors carry `status`; an empty error body keeps its status with `body: undefined`.
- An empty 2xx body (204/205/HEAD/bodiless 200) resolves `ok: true` with `data: undefined` — unless a `response` schema is declared, in which case the schema decides whether absence is acceptable (model it with `optional()`/`default_`).
- Invalid JSON on a 2xx is a `validation` error with code `'invalid_json'` and the status.
- A non-JSON 2xx with a declared `response` schema is **validated** (a `string()` schema accepts the text; an object schema rejects with issues). Without a schema, text is returned as-is.

## Configuration reference

| Option | Type | Default | Description |
|---|---|---|---|
| `baseUrl` | `string` | — | **Required.** Prepended to every request path (one-slash join; absolute-URL paths bypass it). |
| `routes` | `Routes` | `{}` | Route schemas — from `fromOpenAPI(spec)`, the Vite plugin, or hand-written. |
| `middleware` | `Middleware[]` | `[]` | Request/response pipeline, executed in order. |
| `defaultHeaders` | `Record<string, string>` | `{}` | Headers merged into every outgoing request. |
| `getHeaders` | `() => Record<string, string> \| Promise<...>` | — | Called once per request for headers that depend on per-request state (request-scoped auth, CSRF tokens, trace IDs). Precedence: `defaultHeaders` → `getHeaders()` → per-call `headers`. May be async; a thrown error surfaces as `kind: 'network'`. |
| `fetch` | `FetchFn` | `globalThis.fetch` | Custom fetch implementation (SvelteKit load `fetch`, Cloudflare Workers, test mocks). |
| `timeout` | `number` | — | Auto-prepend a `timeout()` middleware (ms). Per-call `timeout` overrides. |
| `retry` | `number \| RetryOptions` | — | Auto-prepend a `retry()` middleware. Number shorthand = `{ attempts: n }`. Per-call `retry` overrides. |
| `querySerializer` | `QuerySerializer` | built-in | Custom query-string encoding for every call. Per-call `querySerializer` overrides. |

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
| `bearerWithRefresh<Paths>(opts)` | Bearer auth + 401-refresh-retry. Concurrent 401s share one in-flight refresh; staggered 401s reuse the freshly refreshed token instead of refreshing again. The `exclude` field lists paths that skip auth entirely — typed against the `Paths` generic. |
| `cookieAuth<Paths>(opts)` | Cookie session auth for server-side runtimes: lazy initial login, optional `refreshAfterMs` proactive refresh, reactive 401-driven re-login, single in-flight dedup with the same staggered-401 protection as `bearerWithRefresh`. |
| `retry(opts)` | Re-invokes the chain on retryable failures — idempotent methods only by default (see below). |
| `timeout(ms)` | Aborts a single request after `ms` ms with a `TimeoutError`. Composed with any user signal. |

### Retry defaults

| Option | Default | Notes |
|---|---|---|
| `attempts` | `3` | Counts the initial request; clamped to ≥ 1, so the request is always sent at least once. |
| `backoff` | `100` ms | Initial delay; exponential with ±25% jitter. |
| `factor` | `2` | Backoff multiplier between attempts. |
| `maxBackoff` | `30_000` ms | Backoff ceiling. |
| `retryOn` | `[408, 425, 429, 500, 502, 503, 504]` | Statuses that trigger a retry. Network rejections always retry — unless your `AbortSignal` caused them. |
| `methods` | `['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS', 'TRACE']` | **Idempotent methods only** (RFC 9110 §9.2.2). `POST`/`PATCH` are never retried unless you opt in. |
| `maxRetryAfter` | = `maxBackoff` | Cap applied to a server-sent `Retry-After` (delay-seconds or HTTP-date) so a hostile server cannot stall the client. Fractional/negative values are ignored per RFC 9110. |

A POST that failed at the network layer may still have been applied server-side — re-sending can double-apply it. Opt known-idempotent endpoints in explicitly, ideally with an idempotency key:

```typescript
const g = createFetch({
  baseUrl: 'https://api.example.com',
  retry: { attempts: 3, methods: ['GET', 'POST'] },
  defaultHeaders: { 'Idempotency-Key': crypto.randomUUID() },
});
```

Discarded responses (retries, 401 replays) have their bodies cancelled so connections aren't pinned during backoff.

### Timeout semantics

- On expiry the request aborts with a **`TimeoutError`** `DOMException` (not `AbortError`), surfacing as `kind: 'timeout'`. Your own `AbortSignal` cancellation surfaces as `kind: 'aborted'` with your reason.
- The implementation composes a plain `AbortController` with the user signal (no `AbortSignal.any` — it's missing on Node < 20.3 / Safari < 17.4 and leaks with long-lived parent signals on Node). The timer is cleared the moment the request settles, and the user-signal listener is removed — no leak with long-lived signals.
- Under `retry`, **each attempt gets a fresh timeout window** (the built-in chain order is retry → timeout → user middleware). An auth middleware's 401 replay, by contrast, shares one window with the original attempt — budget `timeout` accordingly if your refresh flow is slow.

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

The dispatcher is recursive: a middleware may call `next` more than once (retry, 401 replay), and each call re-runs every downstream middleware and the final fetch.

### `exclude` matching in `bearerWithRefresh` and `cookieAuth`

Both middlewares accept the same four `exclude` shapes — requests matched here skip the auth/refresh logic entirely.

| Form | Matching behavior |
|---|---|
| `string` | Pathname match: exact (`"/auth/login"` matches `/auth/login`), **or** a suffix at a `/` boundary — so excludes written against the route table keep working when `baseUrl` carries a path prefix (`"/auth/login"` also matches `/api/v1/auth/login`, but never `/oauth/login`). OpenAPI `{param}` templates work too: `"/users/{id}"` matches `/users/42` (each `{param}` consumes one path segment). |
| `string[]` | Any of the listed pathnames, same rules as above. |
| `RegExp` | Tested against the full request URL. |
| `(request: Request) => boolean` | Arbitrary predicate — return `true` to skip auth. |

### Cookie auth

`cookieAuth` handles login + session refresh for **server-side runtimes** that drive cookie state manually (Node / Deno / Bun / edge workers). In a browser, set `credentials: 'include'` and let the browser manage cookies — browsers neither expose `Set-Cookie` to JavaScript nor allow setting `Cookie`, so this middleware can't work there by design.

```typescript
import { cookieAuth, createFetch, parseSetCookie } from '@bajustone/fetcher';

const f = createFetch({
  baseUrl: 'https://api.example.com',
  middleware: [
    cookieAuth({
      login: async () => {
        const r = await fetch('https://api.example.com/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ user: USER, pass: PASS }),
        });
        if (!r.ok) throw new Error(`login failed: ${r.status}`);
        return parseSetCookie(r.headers); // → "sid=abc; csrf=xyz"
      },
      refreshAfterMs: 25 * 60_000, // optional proactive refresh window
      exclude: ['/auth/login'],    // login MUST be excluded
    }),
  ],
});
```

Behavior:

- **Lazy initial login** — `login` runs on the first non-excluded request, not at construction time.
- **Proactive refresh** (optional `refreshAfterMs`) — re-login before the request is sent if the window has elapsed since the last successful login.
- **Reactive refresh** — a 401 response triggers `login` and one retry, always active even when `refreshAfterMs` is set.
- **Concurrent dedup** — a single in-flight login promise is shared, and staggered 401s within one expiry burst reuse the cookie the first re-login produced instead of each triggering another login.
- **Body cloning** — the request is cloned per attempt, so stream bodies survive the retry.
- **Login failure surfaces as `kind: 'network'`** via `.result()` — the 401 is "consumed" by the failed refresh; check `error.cause` for the original rejection.

The login endpoint **must** be in `exclude` or the middleware deadlocks on its own 401. Why no separate `cookieWithRefresh`? Cookie auth doesn't have the access/refresh-token split that justifies a two-function API for bearer — the "refresh" *is* the login, so one entry point covers static-cookie, proactive-refresh, and reactive-refresh cases uniformly.

### `parseSetCookie`

Extracts `name=value` pairs from one or more `Set-Cookie` response headers and returns a `Cookie` request-header string. Strips all attributes (`Path`, `Domain`, `Expires`, `Max-Age`, `HttpOnly`, `Secure`, `SameSite`). Last-write-wins for duplicate names.

**Deletions are honored**: a cookie sent with `Max-Age=0` (or negative), or an `Expires` date in the past, is treated as a deletion — omitted from the output, and it removes any same-named cookie set earlier in the same input. RFC 6265bis precedence applies: `Max-Age` wins over `Expires`, attribute names match case-insensitively, and a malformed `Max-Age` is ignored entirely.

```typescript
import { parseSetCookie } from '@bajustone/fetcher';

const r = await fetch('/auth/login', { method: 'POST', body });
const cookie = parseSetCookie(r.headers); // "sid=abc; csrf=xyz"
```

Accepts:

- `Headers` — uses `Headers.getSetCookie()` (available on every supported runtime); the rare runtime without it falls back to the joined `get('set-cookie')` value, reliable only for single-cookie responses.
- `string[]` — one entry per `Set-Cookie` header. **Recommended for cross-runtime correctness** — avoids the comma-in-`Expires` ambiguity of the joined string form.
- `string` — a single `Set-Cookie` header value.

Empty / missing / null input returns `""`. Server-side runtimes only — browsers filter `Set-Cookie` out of fetch response headers entirely.

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
await f.head('/users');
await f.options('/users');
```

When the route declares a `body` schema or the path contains `{param}` placeholders, the shortcut's `options` argument is **required at the type level** — `f.post('/auth/login')` without a body is a compile error, not a runtime validation failure.

`f.with(overrides)` derives a sibling client over a shallow-merged config:

```typescript
const api = createFetch({
  baseUrl: 'https://api.example.com',
  middleware: [bearerWithRefresh({ /* ... */ })],
});

const noAuth = api.with({ middleware: [] });
await noAuth.post('/auth/login', { body: { email, password } });
```

The merge is shallow — `{ middleware: [extra] }` *replaces* the parent's chain; spread the parent's array yourself to extend it.

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
| `extractErrorMessage(error)` | Turns a `FetcherError` into a human-readable string. Handles all five error kinds. |
| `FetcherRequestError` | Base error class thrown by `.unwrap()`. Carries `.status`, `.fetcherError`, and `.message`. |
| `FetcherNetworkError`, `FetcherTimeoutError`, `FetcherAbortError`, `FetcherValidationError`, `FetcherHTTPError` | Kind-specific subclasses for `instanceof` narrowing — `.cause` / `.location` + `.issues` / `.status` + `.body` accessors. |
| `withInputType<Input>()` | Re-tags a Standard Schema's declared input type (zero runtime cost; curried). |
| `authBearer(getToken)` | Bearer-token middleware. |
| `bearerWithRefresh(opts)` | Bearer auth + 401-refresh-retry middleware with `exclude` list. |
| `cookieAuth(opts)` | Cookie session middleware: login-driven init/refresh with concurrent dedup. |
| `parseSetCookie(input)` | Parse one or more `Set-Cookie` headers into a ready-to-send `Cookie` header string (deletion-aware). |
| `retry(opts)` | Retry middleware (number shorthand or `RetryOptions`). Idempotent methods only by default. |
| `timeout(ms)` | Per-request timeout middleware (aborts with `TimeoutError`). |

### Schema builder (`@bajustone/fetcher/schema`)

| Export | Purpose |
|---|---|
| `string`, `number`, `integer`, `boolean`, `null_`, `literal`, `unknown`, `undefined_`, `any_`, `never_`, `bigint_` | Primitive factories. |
| `positive`, `nonnegative`, `negative`, `nonpositive`, `finite`, `safe` | Number convenience wrappers. |
| `object`, `array`, `optional`, `nullable`, `union`, `intersect`, `enum_`, `record`, `tuple` | Composites. `object` takes `{ unknownKeys: 'passthrough' \| 'strip' \| 'strict' }`. |
| `partial`, `required`, `pick`, `omit`, `extend`, `extendSchema`, `merge`, `keyof_` | Object composition helpers (`extendSchema` for opaque/validator bases). |
| `refined(schema, predicate, messageOrOptions?)`, `default_(schema, fallbackOrFactory)`, `transform(schema, ...fns)` | Custom predicates (with `{ message, code, path }`), undefined-only defaults (factory/clone-per-use), post-validation reshaping. |
| `discriminatedUnion(key, map)` | O(1) tagged-union dispatch (string/number/boolean tags). |
| `ref(name)` + `compile(schema, defs)` | Lazy, cycle-safe `$ref` binding. |
| `email`, `url`, `uuid`, `datetime`, `date`, `time` | Format helpers — emit `format` + enforcing linear-time `pattern`. |
| `brand<B>()`, `describe`, `title` | Type-level brand + JSON Schema annotations. |
| `formatIssues(issues, opts?)` | Display helper for issue arrays. |
| `parse(schema, data)` | Validate and return `{ value } \| { issues }`. Never throws. |
| `parseOrThrow(schema, data)` | Validate; return value or throw `SchemaValidationError`. Sync only. |
| `parseForm(schema, data)` | Validate; return `{ ok, value }` or `{ ok, errors, issues }` with a field-keyed errors map. |
| `groupIssuesByField(issues)` | Issues → `Record<fieldName, message>` (first issue per field; pathless under `'_form'`). |
| `SchemaValidationError` | Error thrown by `parseOrThrow`. Carries `.issues`. |
| `Infer<typeof X>` | Extract the validated output type. |

### OpenAPI / JSON Schema (`@bajustone/fetcher/openapi`)

| Export | Purpose |
|---|---|
| `fromOpenAPI(spec)` | Converts an OpenAPI 3.x spec into routes with runtime validators. Resolves operation-level `$ref`s and shared path-item `parameters`; treats `default` responses as the error catch-all; coerces numeric path/query params. |
| `fromJSONSchema(schema, defs?)` | Raw JSON Schema → compiled builder validator. |
| `inline(schema, options?)` | Dereferences local `$ref` into a frozen, self-contained JSON Schema (memoized). Throws `InlineCycleError` on cycles, `InlineUnresolvedRefError` on unresolvable refs (or pass `{ onUnresolved: 'keep' }`). |
| `InlineCycleError`, `InlineUnresolvedRefError` | Error classes thrown by `inline()`. |
| `extractRouteSchemas`, `extractComponentSchemas`, `bundleComponent`, `translateDialect`, `JSON_SCHEMA_DIALECT` | Build-time helpers used by the Vite plugin. |

### Spec tools (`@bajustone/fetcher/spec-tools`)

| Export | Purpose |
|---|---|
| `lintSpec(spec)` | Walks an OpenAPI 3.x spec; returns every keyword the runtime validator doesn't enforce. |
| `coverage(spec)` | Walks an OpenAPI 3.x spec; reports per-route schema complexity and integrity issues. |

### Plugin export (`@bajustone/fetcher/vite`)

| Export | Purpose |
|---|---|
| `fetcherPlugin(opts)` | Rollup/Vite plugin. Auto-generates `paths.d.ts` (with `Schema` helper), provides `virtual:fetcher` + `virtual:fetcher/inlined` modules, watches the spec during dev. Options: `spec`, `output?`, `url?`, `fetchTimeoutMs?`, `components?`. |

### Types

`TypedFetchFn`, `TypedFetchPromise`, `TypedResponse`, `ResultData`, `QueryDescriptor`, `FetcherError`, `FetcherErrorLocation`, `FetchConfig`, `FetchFn`, `HttpMethod`, `Middleware`, `RetryOptions`, `QuerySerializer`, `RouteDefinition`, `Routes`, `Schema`, `SchemaOf`, `StandardSchemaV1`, `StandardSchemaV1Issue`, `StandardSchemaV1PathSegment`, `StandardSchemaV1Result`, `BearerWithRefreshOptions<Paths>`, `CookieAuthOptions<Paths>`, `ExcludeMatcher<Paths>`, `FetcherPluginOptions`, `SpecDriftIssue`, `SpecCoverageReport`, `RouteCoverage`, `InferRoutesFromSpec`, `InferOutput`, `InferSchema`, `ExtractPathParams`, `MethodShortcutFn`, `PathsToRoutes`, `JSONSchemaToType`, `InlineOptions`, `JSONSchemaDefinition`, `ExtractedRouteSchemas`.

> Internal OAS type-plumbing helpers (`FilterKeys`, `MediaType`, the `Resolve*FromPaths` family, `IsTypedCall`, …) are no longer exported as of 1.0 — see the [migration guide](./docs/migration-1.0.md) for the full list and replacements.

See [`docs/architecture.md`](./docs/architecture.md) for implementation details.

## Stability and support

- **Semver.** Breaking changes to runtime behavior or exported types only happen in major releases. The 1.0 surface — everything documented above — is the contract.
- **Types are API.** The shapes of exported types are covered by the semver promise. TypeScript support is a rolling window: currently **TypeScript ≥ 5.7** (the npm build relies on `rewriteRelativeImportExtensions`).
- **0.x maintenance.** After 1.0.0, the 0.x line receives critical security fixes for 6 months — see [SECURITY.md](./SECURITY.md), which also documents the security model (redirect credential stripping, retry semantics, untrusted-spec ReDoS, cookie handling, supply-chain provenance).
- **Upgrading from 0.x?** Every behavior change is listed exhaustively in the [1.0 migration guide](./docs/migration-1.0.md).

## License

MIT
