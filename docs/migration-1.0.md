# Migrating from 0.x to 1.0

1.0 is a hardening release: the API surface is the one you know, but a
pre-release audit drove a set of deliberate behavior corrections in the
request/response data plane. Most are strictly fixes for things that were
silently wrong; a few change observable behavior you may have depended on.
Everything below is exhaustive — if a behavior isn't listed here, it did not
change.

## Behavior changes you are most likely to notice

### Requests are dispatched lazily
`f.get(...)` no longer fires the request at call time — it fires on the
first `await` / `.then()` / `.result()` / `.unwrap()`. Calling only
`.query()` dispatches **nothing**, and the descriptor's `fn()` now performs
a **fresh request on every invocation**, so TanStack Query / SWR refetches
actually refetch (previously they replayed a permanently memoized first
response — the worst bug of the audit).

`QueryDescriptor.key` changed shape: `[method, fullUrl, inputs?]` where
`inputs` bundles `{ params?, query?, body? }`. Keys now distinguish clients
with different `baseUrl`s and mutations with different bodies. Persisted
query caches will invalidate once on upgrade.

### The error union grew two kinds
`FetcherError.kind` is now
`'network' | 'timeout' | 'aborted' | 'validation' | 'http'`:

- A caller-initiated `AbortSignal` cancellation → `'aborted'` (was `'network'`).
- A `timeout()` middleware expiry / `TimeoutError` abort → `'timeout'` (was `'network'`).

Update exhaustive `switch` statements. Two new error classes mirror them for
`.unwrap()`: `FetcherAbortError` (status 499) and `FetcherTimeoutError`
(status 408).

`FetcherRequestError.status` mapping changed: request-side validation → 400
(was 500); response-side validation → the response's error status, or 502
when it was a 2xx (was 500). Network stays 500.

### retry() no longer retries POST/PATCH by default
Per RFC 9110 §9.2.2 (and matching got/ky/ofetch), only idempotent methods
(`GET`, `HEAD`, `PUT`, `DELETE`, `OPTIONS`, `TRACE`) are retried. Opt
non-idempotent endpoints in explicitly:

```ts
retry: { attempts: 3, methods: ['GET', 'POST'] }
```

Also: server `Retry-After` is now capped at `maxRetryAfter` (default
`maxBackoff`); fractional/negative `Retry-After` values are ignored
(RFC 9110 allows only `1*DIGIT` or an HTTP-date); `attempts` is clamped to
≥ 1 (`retry: 0` previously sent *zero* requests).

### Query serialization
- Arrays serialize as repeated keys: `{ ids: [1,2] }` → `ids=1&ids=2`
  (OpenAPI `form`/`explode=true`; previously `ids=1%2C2`).
- `Date` values → ISO 8601 (previously a locale-dependent string).
- Plain-object values are a `validation` error (previously
  `[object Object]`).
- A path already containing `?` merges with `&` (previously a second `?`).
- New `querySerializer` option (global and per-call) for custom encodings.

### URL joining
`baseUrl` and `path` are joined with exactly one slash. A trailing-slash
`baseUrl` no longer produces `//`; a missing slash no longer corrupts the
host (`api.example.comusers`). An absolute-URL path is used as-is instead of
being concatenated onto `baseUrl`.

### Bodies
- `Uint8Array` (any ArrayBuffer view) and `ReadableStream` bodies pass
  through to the wire untouched (previously `JSON.stringify`'d into
  garbage). Stream bodies get `duplex: 'half'` automatically.
- The **validated output** of your body/params/query schemas is what gets
  sent — Standard Schema transforms and defaults now apply to the wire
  (previously the raw input was sent).
- A route's declared `body` schema now runs even when you omit the body, so
  a forgotten required body is a `validation` error instead of an empty
  request. Schemas for optional bodies must accept `undefined`
  (`fromOpenAPI` does this automatically for `requestBody.required: false`).
- A route's declared `query` schema likewise runs even when you omit the
  query (validated as `{}`): a missing **required** query parameter is a
  `validation` error instead of a silently incomplete request, and query
  defaults/transforms fire and land on the URL. All-optional query schemas
  accept the empty object, so plain `f.get('/list')` calls are unaffected.

### Response handling
- `application/problem+json`, `application/vnd.api+json`, and any other
  `*+json` content type now parse as JSON.
- The HTTP status is never lost: a malformed-JSON error body surfaces as
  `kind: 'http'` with the raw text as `body`; response-side validation
  errors carry a `status` field; an empty error body keeps its status with
  `body: undefined`.
- An empty 2xx body (204/205/HEAD/bodiless 200) resolves `ok: true` with
  `data: undefined` (previously `kind: 'network'`).
- Invalid JSON on a 2xx is a `validation` error with code `'invalid_json'`
  and the status (previously `kind: 'network'`).
- A non-JSON 2xx with a declared `response` schema is **validated** instead
  of silently bypassing the schema (a `string()` schema accepts the text; an
  object schema rejects with issues). Without a schema, text is returned
  as before.
- `.result()` takes its body clone **lazily on first call** (responses whose
  `.result()` you never use no longer buffer a second body copy). Order
  matters now: call `.result()` before reading the body with native methods.
  The reverse returns a structured error instead of working by accident.

### Methods
- Lowercase `method: 'post'` now hits the same route definition (and
  validation) as `'POST'`.
- New `f.head()` / `f.options()` shortcuts; `HttpMethod` includes
  `HEAD`/`OPTIONS`.
- Method shortcuts make `options` **required at the type level** when the
  route declares a body or the path has `{params}` — a missing body/params
  is now a compile error.
- A path template whose params object is omitted entirely is a `validation`
  error (previously the literal `{id}` was sent to the server).

### Middleware
- `timeout()` no longer uses `AbortSignal.any` (works on every claimed
  runtime, clears its timer the moment the request settles, removes user
  signal listeners — no leak with long-lived signals). On timeout it aborts
  with a `TimeoutError` `DOMException` (the old JSDoc claimed `AbortError`).
- `exclude` matchers in `bearerWithRefresh`/`cookieAuth` now match when
  `baseUrl` carries a path prefix and support OpenAPI `{param}` templates.
- `cookieAuth` gained the same staggered-401 dedup as `bearerWithRefresh`.
- `parseSetCookie` honors deletions (`Max-Age=0` / past `Expires`, with
  RFC 6265bis precedence rules).
- Discarded responses (retries, 401 replays) have their bodies cancelled.

### OpenAPI runtime
- Operation-level `$ref`s (`requestBody`/`responses`/`parameters`) and
  path-item-level shared `parameters` are now resolved — routes that
  previously lost all runtime validation silently now validate.
- A `default` response is consistently treated as the error catch-all
  (matching the type layer and `lintSpec`), never as a success schema.
- Integer/number path and query parameters coerce numeric strings (only
  when the round-trip is lossless), and the type level accepts
  `string | number` for template params — typed calls with integer params
  now succeed. Coercion covers nullable forms too (`type:
  ['integer','null']`, `type: ['array','null']` with numeric items); any
  type union admitting `string` never coerces, since a string value is
  legitimate there.
- `additionalProperties: false` is enforced: closed objects reject unknown
  keys (mapped to the builder's `unknownKeys: 'strict'`). The sub-schema
  form remains unenforced and lint-flagged.
- Assertion keywords adjacent to `$ref` (`minLength`, `maxLength`,
  `pattern`, `minimum`, `maximum`, `minItems`, `maxItems`) are enforced as
  a 2020-12 conjunction, gated on the instance type. Previously they were
  silently dropped.
- `required` applies independently of `properties` (2020-12): a required
  key with no property schema — typically a `$ref` sibling like
  `{ $ref: ..., required: ['name'] }` — is enforced as a presence-only
  constraint, type-gated like the other sibling assertions (object
  instances must carry the keys; other instance types pass vacuously).
  Previously such keys were silently lost. Nodes with `properties` or an
  explicit `type: 'object'` keep strict object semantics.
- A typeless node with `items` carries its adjacent `minItems`/`maxItems`
  bounds (previously dropped). Same intent split as objects: `items`
  present → strict array schema; bare bounds without `items` → type-gated,
  vacuous on non-arrays.
- In `$ref`-sibling position specifically, the object/array applicators
  (`properties`/`required`, `items`+bounds) are type-gated too: the
  instance type comes from the ref target (which may be a union), so the
  sibling constrains only instances of its own type and passes vacuously
  otherwise — `{ $ref: <string>, items: ... }` is no longer an
  unsatisfiable conjunction. Standalone typeless schemas keep the strict
  "properties/items imply type" OpenAPI idiom; an explicit `type` in
  sibling position also stays strict.
- A bare `additionalProperties: false` (no `properties`, as a `$ref`
  sibling or standalone) is enforced as an object-gated closed-object
  assertion. Per 2020-12 scoping it consults only its own schema object΄s
  `properties` — never the ref target΄s — so it forbids ALL keys,
  including ones the target declares. Authors wanting "the referenced
  object, closed" need `unevaluatedProperties`, which remains unsupported
  and lint-flagged. The `true` and sub-schema forms remain no-op/lint-only.

### Schema engine
- `number()`/`integer()` reject `±Infinity` (wire data; JSON can't represent
  them).
- String length constraints count Unicode code points (JSON Schema
  semantics), not UTF-16 units.
- `object()` accepts optional keys present with value `undefined`, and gains
  an `unknownKeys: 'passthrough' | 'strip' | 'strict'` option (default
  `'passthrough'`, the previous behavior, now documented).
- `union()` failures report the best-matching variant's issues with paths
  (previously one opaque "No variant matched").
- `compile()` reaches refs nested anywhere (defs targets, record values,
  tuple members, wrapped refs); transform/refined/default over `optional()`
  keep both behaviors inside `object()` — at the TYPE level too:
  `refined(optional(...))` / `transform(optional(...))` entries infer as
  optional keys (and `transform` carries its transformed output type into
  the key), matching the runtime. `refined(default_(...))` keys stay
  required in the output type, since the default fills them.
- Async schemas nested inside sync combinators throw a `TypeError`
  (previously silently corrupted output).
- `default_` clones object/array fallbacks per use (or accepts a factory).
- Format validators tightened: HTML5 email regex, range-checked
  date/time fields, flag-consistent emitted patterns.
- `multipleOf` is exact for large magnitudes.

### Tooling
- `inline()` (from `@bajustone/fetcher/openapi`) now throws
  `InlineUnresolvedRefError` on a `$ref` it cannot resolve against the
  schema's own `$defs` — e.g. draft-07 `#/definitions/X` pointers or
  external URLs, which were previously passed through to the output
  silently. Pass `{ onUnresolved: 'keep' }` to restore the old pass-through
  behavior.
- `inline()` now merges keywords adjacent to `$ref` (legal in JSON Schema
  2020-12 / OpenAPI 3.1) over the resolved target instead of silently
  dropping them.

## Packaging changes

- **npm is now first-class**: compiled ESM + `.d.ts` (+ source maps and
  `declarationMap` for go-to-definition) under `dist/`, validated by publint
  and arethetypeswrong in CI. JSR continues to ship raw TypeScript source.
- ESM-only, `engines.node >= 20.19` (`require(esm)` works there). Node 18 is
  EOL and no longer claimed.
- CI now actually proves the runtime matrix: Node 20.19/22/24, Deno, and Bun
  all run a conformance smoke against the built artifact on every push.

## Removed / deprecated

- The deprecated `refreshEndpoint` option on `bearerWithRefresh` — use
  `exclude`.
- The internal OAS type-plumbing helpers are no longer exported from the
  package root (`FilterKeys`, `MediaType`, `IsTypedCall`,
  `AvailablePaths`/`AvailableMethods`, the `Resolve*For`/`Resolve*FromPaths`
  family, `OpenAPIPaths`, `OpenAPI*Status`). The documented surface
  (`Routes`, `Schema`, `Infer*`, `PathsToRoutes`, `SchemaOf`,
  `ExtractPathParams`, `MethodShortcutFn`, …) is unchanged.
