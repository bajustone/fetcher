/**
 * Public type definitions shared across `@bajustone/fetcher`: the universal
 * `Schema` contract, the `TypedResponse`/`ResultData` extension of the
 * native `Response`, and the `Routes` / `RouteDefinition` shapes that drive
 * type inference.
 *
 * @module
 */

import type { InferredRouteDefinition } from './infer-spec.ts';

/**
 * A path segment in a Standard Schema V1 issue. Either a property key or a
 * `{ key }` wrapper for keys whose path needs additional metadata.
 */
export type StandardSchemaV1PathSegment = PropertyKey | { readonly key: PropertyKey };

/**
 * A single validation issue produced by a Standard Schema V1 validator.
 */
export interface StandardSchemaV1Issue {
  /** Human-readable description of the failure. */
  readonly message: string;
  /** Path from the validated root to the failing value, when applicable. */
  readonly path?: ReadonlyArray<StandardSchemaV1PathSegment>;
  /**
   * Optional machine-readable code. Emitted by the bundled schema builder
   * (e.g., `expected_string`, `too_short`, `missing`, `unknown_discriminator`)
   * so consumers can map to localized or custom messages without parsing the
   * human-facing `message`. External validators may omit this field.
   */
  readonly code?: string;
}

/**
 * The result of a Standard Schema V1 validation. On success, `value` holds
 * the validated output and `issues` is undefined. On failure, `issues` holds
 * the list of problems and `value` is undefined.
 */
export type StandardSchemaV1Result<Output>
  = | { readonly value: Output; readonly issues?: undefined }
    | { readonly value?: undefined; readonly issues: ReadonlyArray<StandardSchemaV1Issue> };

/**
 * Standard Schema V1 — the lightweight cross-library schema spec implemented
 * by Zod 3.24+, Valibot, ArkType, and others. Any value with a `~standard`
 * property satisfying this shape can be used as a schema in `@bajustone/fetcher`.
 *
 * See https://standardschema.dev for the full spec. The interface is inlined
 * here so the library has no runtime or type dependency on the spec package.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  /** The Standard Schema V1 protocol object: spec version, vendor name, and the validator. */
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) => StandardSchemaV1Result<Output> | Promise<StandardSchemaV1Result<Output>>;
    readonly types?: {
      readonly input: Input;
      readonly output: Output;
    };
  };
}

/**
 * Extracts the validated output type from a Standard Schema V1 schema.
 * `InferOutput<typeof userSchema>` resolves to whatever `userSchema` produces.
 */
export type InferOutput<S extends StandardSchemaV1>
  = S extends StandardSchemaV1<unknown, infer Output> ? Output : unknown;

/**
 * The universal schema type accepted by `@bajustone/fetcher`. Aliases
 * {@link StandardSchemaV1} so any value implementing the spec — Zod v4,
 * Valibot, ArkType, the bundled `JSONSchemaValidator`, or a custom validator
 * — drops in without a wrapper.
 *
 * Users on bare `{ parse(data): T }` validators can wrap them in a five-line
 * adapter; see the README for the snippet.
 */
export type Schema<T = unknown> = StandardSchemaV1<unknown, T>;

/**
 * Unwraps the output type of a {@link Schema}. Equivalent to
 * {@link InferOutput} for Standard Schema V1 schemas; preserved as a separate
 * name for backwards compatibility.
 */
export type InferSchema<S> = S extends StandardSchemaV1<unknown, infer T> ? T : unknown;

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/**
 * Where in the request/response a validation failure originated. `'body'`,
 * `'params'`, `'query'` are client-side validation failures (the request
 * was rejected before being sent); `'response'` is a server-side response
 * that did not match the declared `response`/`errorResponse` schema.
 */
export type FetcherErrorLocation = 'body' | 'params' | 'query' | 'response';

/**
 * Discriminated error type surfaced by {@link TypedResponse.result}. Every
 * failure path collapses into one of five kinds:
 *
 * - `'network'` — the underlying fetch threw (DNS failure, connection
 *   refused, TLS error) or some other transport-level failure occurred.
 *   `cause` holds the raw thrown value (typically an `Error`).
 * - `'timeout'` — the request was aborted by a deadline: the `timeout()`
 *   middleware fired, or any abort whose reason is a `TimeoutError`
 *   `DOMException` (e.g. a user-supplied `AbortSignal.timeout(...)`).
 * - `'aborted'` — the caller cancelled the request on purpose via its
 *   `AbortSignal`. Distinguishing this from `'timeout'`/`'network'` lets
 *   UIs suppress error toasts for intentional cancellations.
 * - `'validation'` — a Standard Schema V1 validator returned `issues` for
 *   the body/params/query (client-side, before the request was sent) or
 *   for the response body (server-side). `location` and `issues` describe
 *   exactly what failed; for `location: 'response'`, `status` carries the
 *   HTTP status code of the response that failed validation.
 * - `'http'` — the server returned a 4xx or 5xx response. `status` holds
 *   the HTTP status code; `body` holds the parsed (and, if a route
 *   `errorResponse` schema was declared, validated) error body. When the
 *   body claimed to be JSON but did not parse, `body` is the raw text.
 *
 * Old-runtime caveat: Chrome 103–123 reported timeouts with an
 * `AbortError` name instead of `TimeoutError`; on those runtimes a
 * middleware-driven timeout may surface as `'aborted'`.
 *
 * @example
 * ```typescript
 * const result = await response.result();
 * if (!result.ok) {
 *   switch (result.error.kind) {
 *     case 'network': console.error('network', result.error.cause); break;
 *     case 'timeout': console.error('timed out', result.error.cause); break;
 *     case 'aborted': break; // intentional — usually no UI feedback needed
 *     case 'validation': console.error('invalid', result.error.location, result.error.issues); break;
 *     case 'http': console.error('http', result.error.status, result.error.body); break;
 *   }
 * }
 * ```
 */
export type FetcherError<HttpBody = unknown>
  = | { readonly kind: 'network'; readonly cause: unknown }
    | { readonly kind: 'timeout'; readonly cause: unknown }
    | { readonly kind: 'aborted'; readonly cause: unknown }
    | {
      readonly kind: 'validation';
      readonly location: FetcherErrorLocation;
      readonly issues: ReadonlyArray<StandardSchemaV1Issue>;
      /** HTTP status of the response, when `location` is `'response'`. */
      readonly status?: number;
    }
    | { readonly kind: 'http'; readonly status: number; readonly body: HttpBody };

/**
 * Discriminated union returned by {@link TypedResponse.result}. Narrow on
 * `result.ok` to access the data or the error:
 *
 * @example
 * ```typescript
 * const result = await response.result();
 * if (result.ok) {
 *   // result.data: T
 * } else {
 *   // result.error: FetcherError<HttpBody>
 * }
 * ```
 */
export type ResultData<T, HttpBody = unknown>
  = | { readonly ok: true; readonly data: T }
    | { readonly ok: false; readonly error: FetcherError<HttpBody> };

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/**
 * A native `Response` augmented with a typed `.result()` method. All native
 * `Response` members (`.ok`, `.status`, `.headers`, `.json()`, `.text()`,
 * ...) continue to work — `.result()` is an additive extension that parses
 * the body and runs it through the route's schema.
 *
 * The two generics: `T` is the success data type; `HttpErrorBody` is the
 * type of `error.body` when `error.kind === 'http'`. Both default to
 * `unknown` when no schemas are declared.
 */
export interface TypedResponse<T = unknown, HttpErrorBody = unknown> extends Response {
  /**
   * Parses the response body and validates it against the route's schema,
   * returning a {@link ResultData} discriminated union. Never throws —
   * network failures, validation errors, and HTTP error responses are all
   * surfaced via `{ ok: false, error }`.
   */
  result: () => Promise<ResultData<T, HttpErrorBody>>;
}

/**
 * Describes a cache-friendly query derived from a typed fetch call.
 * The `key` is deterministic — `[method, url, inputs?]` where `url` is the
 * fully joined request URL and `inputs` bundles whichever of
 * `params` / `query` / `body` were supplied — so two clients pointed at
 * different `baseUrl`s, or two POSTs with different bodies, never collide.
 * The `fn` performs a **fresh request on every invocation** (calling
 * `.unwrap()` internally), so cache refetches always hit the network —
 * compatible with TanStack Query, SWR, Pinia Colada, or any cache that
 * accepts a key + async function.
 *
 * ```typescript
 * const { key, fn } = api.get('/users', { query: { page: 1 } }).query();
 * // key: ['GET', 'https://api.example.com/users', { query: { page: 1 } }]
 * // fn:  () => Promise<User[]>   (each call = a new request)
 *
 * useQuery({ queryKey: key, queryFn: fn });  // TanStack Query
 * useSWR(key, fn);                           // SWR
 * ```
 */
export interface QueryDescriptor<T> {
  /** Deterministic cache key: `[method, fullUrl, { params?, query?, body? }?]`. */
  readonly key: ReadonlyArray<unknown>;
  /** Fetches and unwraps the data — a fresh request on every invocation. */
  readonly fn: () => Promise<T>;
}

/**
 * The promise returned by {@link TypedFetchFn} and its method shortcuts.
 * Extends the native `Promise<TypedResponse>` with three shorthands:
 *
 * - `.result()` — resolves to `ResultData<T>` (never throws)
 * - `.unwrap()` — resolves to `T` directly, throws `FetcherRequestError` on failure
 * - `.query()` — returns `{ key, fn }` for cache libraries (synchronous, does not fetch)
 *
 * **Laziness:** the request is dispatched the first time the promise is
 * consumed — `await`, `.then()`, `.result()`, or `.unwrap()`. Calling only
 * `.query()` dispatches nothing: the descriptor's `fn()` issues a fresh
 * request on each invocation, so caching libraries control exactly when
 * (and how often) the network is hit.
 *
 * ```typescript
 * // Safe — discriminated union, never throws:
 * const result = await f.get('/pets').result();
 *
 * // Throwing — for load functions, server actions, remote functions:
 * const pets = await f.get('/pets').unwrap();
 *
 * // Cache-friendly — for TanStack Query, SWR, etc. (no request fired here):
 * const { key, fn } = f.get('/pets').query();
 * ```
 */
export type TypedFetchPromise<T = unknown, HttpErrorBody = unknown>
  = Promise<TypedResponse<T, HttpErrorBody>> & {
    /** Shorthand: resolves directly to `ResultData<T, HttpErrorBody>`. */
    result: () => Promise<ResultData<T, HttpErrorBody>>;
    /**
     * Returns the data on success, throws {@link FetcherRequestError} on
     * failure. Use in server-side contexts (load functions, remote functions,
     * server actions) where framework error boundaries catch thrown errors.
     */
    unwrap: () => Promise<T>;
    /**
     * Returns a {@link QueryDescriptor} with a deterministic cache `key`
     * and an async `fn`. Does not trigger the fetch — and `fn()` performs a
     * fresh request (via `.unwrap()`) every time the caching library calls
     * it, so refetches and invalidations always reach the network.
     */
    query: () => QueryDescriptor<T>;
  };

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

/** HTTP verbs supported by the router. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';

/**
 * Schema bundle for a single `path × method` pair. Every field is optional;
 * only the schemas you provide are enforced at runtime, and only those
 * types flow into type inference.
 */
export interface RouteDefinition {
  /** Schema applied to the request body before serialization. */
  body?: Schema;
  /** Schema for path parameters (e.g. `{id}` in `/users/{id}`). */
  params?: Schema;
  /** Schema for the URL query string object. */
  query?: Schema;
  /** Schema applied to the response body on 2xx responses. */
  response?: Schema;
  /** Schema applied to the response body on 4xx/5xx responses. */
  errorResponse?: Schema;
}

/**
 * A map of URL paths to per-method {@link RouteDefinition}s. This is the
 * shape {@link TypedFetchFn} keys off for type inference — whatever you
 * pass to `createFetch({ routes: ... })` drives path/method/body/response
 * completion.
 *
 * @example
 * ```typescript
 * const routes = {
 *   '/auth/login': {
 *     POST: {
 *       body: z.object({ email: z.string() }),
 *       response: z.object({ token: z.string() }),
 *     },
 *   },
 * } satisfies Routes;
 * ```
 */
export type Routes = Record<string, Partial<Record<HttpMethod, RouteDefinition>>>;

// ---------------------------------------------------------------------------
// OpenAPI inference (§4.A7 — Path A minimum)
// ---------------------------------------------------------------------------

/**
 * Lowercase HTTP method keys as they appear in an OpenAPI 3.x spec.
 * Used by {@link InferRoutesFromSpec} to filter path-item keys (which may
 * also include `summary`, `description`, `parameters`, etc.) down to just
 * the methods this library supports.
 */
type LowercaseHttpMethod = 'get' | 'post' | 'put' | 'delete' | 'patch' | 'head' | 'options';

/**
 * Keys of `PathItem` whose value is actually defined. openapi-typescript
 * emits every unused verb as `head?: never` / `options?: never` markers —
 * without this filter those phantom keys would surface in method
 * autocomplete and {@link IsTypedCall} even though no operation exists.
 */
type DefinedMethodKeys<PathItem>
  = { [K in keyof PathItem]-?: [Exclude<PathItem[K], undefined>] extends [never] ? never : K }[keyof PathItem];

/**
 * Walks the literal type of an OpenAPI spec and produces a narrowed
 * {@link Routes} shape that preserves the spec's path keys, method keys,
 * and — when the spec is sufficiently narrowly typed — the body / response
 * / error-response types inferred from its JSON Schemas.
 *
 * **What is inferred:**
 * - Path keys (e.g. `/pets`, `/pets/{petId}`)
 * - Method keys per path (`GET`, `POST`, etc., uppercased from the spec)
 * - Path parameters from the path template (via `ExtractPathParams`)
 * - Body / response / errorResponse TS types from the spec's JSON Schemas,
 *   via {@link JSONSchemaToType}. `$ref` targets resolve against the
 *   spec's `components.schemas` map.
 *
 * **Practical note:** type-level inference requires the spec to be narrowly
 * typed — pass an inline `as const` object or a JSON import processed
 * through a codegen step. Plain `import spec from './openapi.json'`
 * widens string literals (so `type: 'integer'` becomes `type: string`) and
 * the schema walker collapses to `unknown`. For large specs, prefer the
 * codegen path (`openapi-typescript` → `paths.d.ts` → `createFetch<paths>`);
 * the zero-codegen path trades TypeScript compile time for setup
 * simplicity.
 *
 * **What is NOT inferred:** `params` and `query` schemas stay as
 * `Schema<unknown>` (path params flow through `ExtractPathParams`; query
 * parameter types aren't walked yet).
 *
 * @example — zero-codegen inference from an inline const spec
 * ```ts
 * const spec = {
 *   paths: {
 *     '/pets/{id}': {
 *       get: {
 *         responses: {
 *           '200': {
 *             content: {
 *               'application/json': {
 *                 schema: {
 *                   type: 'object',
 *                   properties: { id: { type: 'integer' }, name: { type: 'string' } },
 *                   required: ['id', 'name'],
 *                 },
 *               },
 *             },
 *           },
 *         },
 *       },
 *     },
 *   },
 * } as const;
 *
 * const f = createFetch({ baseUrl: '...', routes: fromOpenAPI(spec) });
 * const r = await f.get('/pets/{id}', { params: { id: '1' } }).result();
 * if (r.ok) r.data.name; // typed: string
 * ```
 */
export type InferRoutesFromSpec<S>
  = S extends { paths: infer Paths }
    ? Paths extends Record<string, unknown>
      ? {
          [P in keyof Paths & string]: {
            [M in Extract<DefinedMethodKeys<Paths[P]>, LowercaseHttpMethod> as Uppercase<M>]:
            InferredRouteDefinition<Paths[P][M], GetSpecDefs<S>, GetSpecComponents<S>>;
          };
        }
      : Routes
    : Routes;

type GetSpecDefs<S>
  = S extends { components: { schemas: infer D } } ? D : object;

/**
 * The spec's whole `components` object — lets `InferredRouteDefinition`
 * dereference operation-level `requestBody`/`responses` `$ref`s
 * (`#/components/requestBodies/N`, `#/components/responses/N`) like the
 * runtime does.
 */
type GetSpecComponents<S>
  = S extends { components: infer C } ? C : object;

// ---------------------------------------------------------------------------
// OpenAPI paths inference (D6 — typed body/response from generated `paths`)
//
// These types let callers pass a `paths` interface produced by
// `openapi-typescript` (or any equivalent codegen) as a second generic on
// `createFetch`, and have body / response / errorResponse types flow through
// to call sites without a runtime conversion. The runtime continues to
// validate via `fromOpenAPI(spec)` — types and validation are decoupled.
// ---------------------------------------------------------------------------

/** Lowercase HTTP method keys as emitted by `openapi-typescript`. */
export type OpenAPILowercaseMethod
  = | 'get' | 'post' | 'put' | 'delete' | 'patch'
    | 'options' | 'head' | 'trace';

/**
 * Documentation alias for the `paths` interface emitted by
 * `openapi-typescript` — its actual structure is
 * `{ [path]: { [lowercase method]: { parameters?, requestBody?, responses } } }`.
 *
 * **Important:** the {@link createFetch} `OAS` generic is intentionally
 * unconstrained (defaults to `unknown`). openapi-typescript emits
 * `interface paths { ... }` *without* an index signature, so any constraint
 * shaped as `Record<string, ...>` rejects the very input we want to accept.
 * The constraint-free generic accepts the interface as-is and the helper
 * types ({@link AvailablePaths}, {@link IsTypedCall}, {@link ResolveBodyFor},
 * etc.) defensively handle non-paths inputs by checking `keyof OAS` first.
 */
export type OpenAPIPaths = Record<
  string,
  Partial<Record<OpenAPILowercaseMethod, unknown>>
>;

/**
 * For an object `Obj`, returns the union of values whose keys match
 * `Matchers`. Mirrors the helper of the same name in
 * `openapi-typescript-helpers` — used to walk a generated paths tree's
 * status-code → `content` → media-type levels without hard-coding the keys.
 */
export type FilterKeys<Obj, Matchers> = Obj extends object
  ? { [K in keyof Obj]: K extends Matchers ? Obj[K] : never }[keyof Obj]
  : never;

/** Matches any `${type}/${subtype}` media type literal (e.g. `application/json`). */
export type MediaType = `${string}/${string}`;

/**
 * Status code keys that count as a success response. Numeric 2xx values
 * matching openapi-typescript's emitted keys, plus the wildcard form spec
 * authors sometimes write by hand. Note: `'default'` is intentionally NOT
 * here — it's treated as an error catch-all by {@link OpenAPIErrorStatus},
 * so an endpoint with `200 + default` resolves the success body to the
 * 200 schema and the error body to the default schema (matching how most
 * OpenAPI authors mean it).
 */
export type OpenAPISuccessStatus
  = | 200 | 201 | 202 | 203 | 204 | 205 | 206
    | '2XX' | '2xx';

/**
 * Status code keys that count as an error response — 4xx/5xx in numeric
 * form (matching openapi-typescript output), the wildcard variants, and
 * `'default'` (treated as the catch-all error case).
 */
export type OpenAPIErrorStatus
  = | 400 | 401 | 402 | 403 | 404 | 405 | 406 | 407 | 408 | 409
    | 410 | 411 | 412 | 413 | 414 | 415 | 416 | 417 | 418 | 422
    | 425 | 426 | 428 | 429 | 431 | 451
    | 500 | 501 | 502 | 503 | 504 | 505 | 506 | 507 | 508 | 510 | 511
    | '4XX' | '5XX' | '4xx' | '5xx' | 'default';

/**
 * Operation lookup with case-folding from the uppercase `M` we get at the
 * call site to the lowercase keys openapi-typescript emits.
 */
type OpenAPIOperation<P, Path extends string, M extends string>
  = Path extends keyof P
    ? Lowercase<M> extends keyof P[Path]
      ? P[Path][Lowercase<M>]
      : never
    : never;

/**
 * Resolves the success response body type from a generated `paths` interface.
 * Returns `never` when no path / method / 2xx response / JSON content match —
 * the `never` signal lets {@link ResolveResponseFor} fall back to `unknown`.
 */
export type ResolveResponseFromPaths<P, Path extends string, M extends string>
  = OpenAPIOperation<P, Path, M> extends { responses: infer Resp }
    ? FilterKeys<Resp, OpenAPISuccessStatus> extends { content: infer Content }
      ? FilterKeys<Content, MediaType>
      : never
    : never;

/**
 * Resolves the error response body type from a generated `paths` interface.
 * Returns `never` when no error response is declared.
 */
export type ResolveErrorResponseFromPaths<P, Path extends string, M extends string>
  = OpenAPIOperation<P, Path, M> extends { responses: infer Resp }
    ? FilterKeys<Resp, OpenAPIErrorStatus> extends { content: infer Content }
      ? FilterKeys<Content, MediaType>
      : never
    : never;

/**
 * Resolves the request body type from a generated `paths` interface.
 * Returns `never` when no request body is declared, which causes `body`
 * to become optional in {@link TypedFetchOptions}.
 */
export type ResolveBodyFromPaths<P, Path extends string, M extends string>
  = OpenAPIOperation<P, Path, M> extends { requestBody: infer Body }
    ? Body extends { content: infer Content }
      ? FilterKeys<Content, MediaType>
      : never
    : never;

/**
 * Resolves the query parameter type from a generated `paths` interface.
 * Returns `never` when no query parameters are declared.
 */
export type ResolveQueryFromPaths<P, Path extends string, M extends string>
  = OpenAPIOperation<P, Path, M> extends { parameters: infer Params }
    ? Params extends { query?: infer Q }
      ? Q & {}
      : never
    : never;

/**
 * Resolves the path parameter type from a generated `paths` interface.
 * Returns `never` when no path parameters are declared.
 */
export type ResolveParamsFromPaths<P, Path extends string, M extends string>
  = OpenAPIOperation<P, Path, M> extends { parameters: infer Params }
    ? Params extends { path?: infer Q }
      ? Q & {}
      : never
    : never;

/**
 * True when `OAS` carries any path entries — i.e. the caller supplied a
 * generated `paths` interface as the OAS generic on `createFetch`. Used as
 * the switch between Routes-based and OAS-based inference.
 */
type HasPaths<OAS> = [keyof OAS] extends [never] ? false : true;

/**
 * Path-key constraint that prefers OAS keys when an OAS paths interface is
 * supplied, otherwise uses the Routes table. The `(string & {})` tail
 * preserves literal autocomplete while still accepting arbitrary strings.
 */
export type AvailablePaths<R extends Routes, OAS>
  = HasPaths<OAS> extends true
    ? (keyof OAS & string) | (string & {})
    : (keyof R & string) | (string & {});

/**
 * Method-key constraint per path. With OAS supplied, the lowercase method
 * keys from the generated `paths` interface are uppercased (to match the
 * runtime `Routes` table) and restricted to the five verbs the library
 * supports (`options` / `head` / `trace` are dropped). The `(string & {})`
 * tail preserves literal-autocomplete while still accepting arbitrary
 * strings — so paths/methods not declared in the spec fall through to
 * {@link UntypedFetchOptions} via {@link IsTypedCall}.
 *
 * The Routes branch retains the existing autocomplete behavior because it
 * doesn't need a case-folding wrapper.
 */
export type AvailableMethods<R extends Routes, OAS, Path extends string>
  = HasPaths<OAS> extends true
    ? Path extends keyof OAS
      ? Uppercase<Extract<DefinedMethodKeys<OAS[Path]>, LowercaseHttpMethod>> | (string & {})
      : string
    : Path extends keyof R
      ? (keyof R[Path] & string) | (string & {})
      : string;

/**
 * Returns `true` when the `path` × `method` pair is "known" — present in
 * either the OAS paths interface (when supplied) or the Routes table
 * (otherwise). Used to switch the call-site between
 * {@link TypedFetchOptions} and `UntypedFetchOptions`.
 */
export type IsTypedCall<R extends Routes, OAS, P extends string, M extends string>
  = HasPaths<OAS> extends true
    ? P extends keyof OAS
      ? Lowercase<M> extends DefinedMethodKeys<OAS[P]>
        ? true
        : false
      : false
    : P extends keyof R
      ? M extends keyof R[P] & string
        ? true
        : false
      : false;

/**
 * Unified body resolver — prefers the OAS path when supplied, falls back
 * to the Routes-based {@link ResolveBody}. Returns `never` when neither
 * source declares a body, which makes the `body` field optional.
 */
export type ResolveBodyFor<R extends Routes, OAS, P extends string, M extends string>
  = HasPaths<OAS> extends true
    ? ResolveBodyFromPaths<OAS, P, M>
    : ResolveBody<R, P, M>;

/**
 * Unified query resolver — prefers the OAS path when supplied, falls back
 * to the Routes-based {@link ResolveQuery}. Returns `never` when neither
 * source declares query params, which keeps `query` as a generic Record.
 */
export type ResolveQueryFor<R extends Routes, OAS, P extends string, M extends string>
  = HasPaths<OAS> extends true
    ? ResolveQueryFromPaths<OAS, P, M>
    : ResolveQuery<R, P, M>;

/**
 * Unified path-params resolver — prefers OAS `parameters.path` when
 * supplied, falls back to {@link ExtractPathParams} template extraction.
 * Returns `never` when neither source declares path params.
 */
export type ResolveParamsFor<R extends Routes, OAS, P extends string, M extends string>
  = HasPaths<OAS> extends true
    ? [ResolveParamsFromPaths<OAS, P, M>] extends [never]
        ? [ExtractPathParams<P>] extends [never]
            ? never
            : Record<ExtractPathParams<P>, string | number>
        : ResolveParamsFromPaths<OAS, P, M>
    : R extends Routes
      ? [ExtractPathParams<P>] extends [never]
          ? never
          : Record<ExtractPathParams<P>, string | number>
      : never;

/**
 * Unified success-response resolver — prefers OAS, falls back to Routes,
 * and finally to `unknown` if neither source has a typed response.
 */
export type ResolveResponseFor<R extends Routes, OAS, P extends string, M extends string>
  = HasPaths<OAS> extends true
    ? [ResolveResponseFromPaths<OAS, P, M>] extends [never]
        ? unknown
        : ResolveResponseFromPaths<OAS, P, M>
    : ResolveResponse<R, P, M>;

/**
 * Unified error-response resolver — prefers OAS, falls back to Routes,
 * and finally to `unknown`.
 */
export type ResolveErrorResponseFor<R extends Routes, OAS, P extends string, M extends string>
  = HasPaths<OAS> extends true
    ? [ResolveErrorResponseFromPaths<OAS, P, M>] extends [never]
        ? unknown
        : ResolveErrorResponseFromPaths<OAS, P, M>
    : ResolveErrorResponse<R, P, M>;

// ---------------------------------------------------------------------------
// Schema extraction
// ---------------------------------------------------------------------------

/**
 * Walks an `openapi-typescript`-generated `paths` interface and produces a
 * narrow {@link Routes} shape where each slot (`body`, `params`, `query`,
 * `response`, `errorResponse`) is typed to the specific JSON-Schema output
 * that applies at that path × method — inferred via the same
 * {@link ResolveBodyFromPaths} / {@link ResolveResponseFromPaths} family
 * used at call sites.
 *
 * Method keys are emitted uppercase (`POST`, `GET`) to match the runtime
 * `Routes` table populated by {@link fromOpenAPI} and `extractRouteSchemas`.
 * Non-supported HTTP verbs in the spec (`options`, `head`, `trace`) are
 * filtered out.
 *
 * **Intended consumer:** the Vite/Rollup plugin's `virtual:fetcher` type
 * declaration. With this alias, `routes[path][method].body` resolves to
 * `Schema<ConcreteBody>` instead of the bare `Schema` that users previously
 * had to re-derive via a shim file.
 */
export type PathsToRoutes<P> = {
  [Path in keyof P & string]: {
    [M in Extract<DefinedMethodKeys<P[Path]>, LowercaseHttpMethod> as Uppercase<M>]: {
      body?: Schema<ResolveBodyFromPaths<P, Path, Uppercase<M>>>;
      params?: Schema<ResolveParamsFromPaths<P, Path, Uppercase<M>>>;
      query?: Schema<ResolveQueryFromPaths<P, Path, Uppercase<M>>>;
      response?: Schema<ResolveResponseFromPaths<P, Path, Uppercase<M>>>;
      errorResponse?: Schema<ResolveErrorResponseFromPaths<P, Path, Uppercase<M>>>;
    };
  };
};

/**
 * Extracts a named component schema from an `openapi-typescript`-generated
 * `components` interface. Saves consumers from writing the full path
 * `components['schemas']['Name']` at every type reference.
 *
 * @example
 * ```typescript
 * import type { SchemaOf } from '@bajustone/fetcher';
 * import type { components } from './generated/petstore-paths';
 *
 * type Pet = SchemaOf<components, 'Pet'>;
 * //   ^? { id: number; name: string; tag?: string }
 * ```
 */
export type SchemaOf<Components, Name extends string>
  = Components extends { schemas: infer S }
    ? Name extends keyof S ? S[Name] : never
    : never;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * A request/response middleware function — Hono/Koa-shaped, with one
 * extension: the `next` continuation accepts an optional `Request` argument.
 *
 * Calling `next()` (no argument) re-runs the rest of the chain with the
 * same `Request` the middleware received. Calling `next(modifiedRequest)`
 * passes a new `Request` down the chain, which is what makes retry,
 * request-signing, and token-refresh middleware expressible without leaving
 * the pipeline.
 *
 * Middleware MAY call `next` more than once (e.g. retry on a 5xx). Each
 * call re-runs every downstream middleware *and* the final fetch — the
 * dispatcher is recursive, not stateful.
 *
 * **Stream-body caveat:** if the original `request.body` is a stream, the
 * stream is consumed by the first call. Retry middleware that may invoke
 * `next` more than once should `request.clone()` between attempts.
 */
export type Middleware = (
  request: Request,
  next: (request?: Request) => Promise<Response>,
) => Promise<Response>;

// ---------------------------------------------------------------------------
// Retry / timeout
// ---------------------------------------------------------------------------

/**
 * Configuration for the `retry` middleware. Pass a number as a shorthand
 * for `{ attempts: n }`.
 */
export interface RetryOptions {
  /**
   * Maximum number of attempts (including the first). Default: 3.
   * Values below 1 are clamped to 1 — the request is always sent at
   * least once; `attempts: 1` means "no retries".
   */
  attempts?: number;
  /** Initial backoff delay in milliseconds. Default: 100. */
  backoff?: number;
  /** Backoff multiplier applied between attempts. Default: 2. */
  factor?: number;
  /** Maximum backoff delay in milliseconds. Default: 30_000. */
  maxBackoff?: number;
  /**
   * HTTP status codes that should trigger a retry. Network rejections
   * (the underlying fetch throwing) are always retried unless they were
   * caused by the user's AbortSignal.
   *
   * Default: `[408, 425, 429, 500, 502, 503, 504]`
   */
  retryOn?: readonly number[];
  /**
   * HTTP methods eligible for retry. Defaults to the idempotent methods
   * per RFC 9110 §9.2.2 — `GET`, `HEAD`, `PUT`, `DELETE`, `OPTIONS`,
   * `TRACE`. `POST`/`PATCH` are **not** retried by default because a
   * request that failed at the network layer may still have been applied
   * by the server; re-sending it can double-apply the operation. Opt in
   * explicitly (e.g. `methods: ['GET', 'POST']`) when the endpoint is
   * known to be idempotent — ideally paired with an `Idempotency-Key`
   * header. Matching is case-insensitive.
   */
  methods?: readonly string[];
  /**
   * Upper bound (in milliseconds) applied to a server-sent `Retry-After`
   * header, so a hostile or misconfigured server cannot stall the client
   * indefinitely (e.g. `Retry-After: 86400`). Defaults to `maxBackoff`.
   */
  maxRetryAfter?: number;
}

/**
 * Serializes the per-call `query` object into a query string. Return either
 * a ready-to-append string (without the leading `?`) or a `URLSearchParams`.
 * Overrides the built-in serializer (repeated keys for arrays — OpenAPI
 * `form`/`explode=true` style; `Date` → ISO 8601; `undefined`/`null`
 * dropped).
 */
export type QuerySerializer = (query: Record<string, unknown>) => string | URLSearchParams;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * A minimal fetch-compatible function. Narrower than `typeof globalThis.fetch`
 * so that simple mocks (e.g. `async () => new Response(...)`) assign cleanly
 * without having to implement static properties like `preconnect`.
 */
export type FetchFn = (request: Request) => Promise<Response>;

/**
 * Options passed to {@link createFetch}. The `routes` generic parameter
 * drives all downstream type inference — pass the object literally (or use
 * `satisfies Routes`) for best autocomplete.
 */
export interface FetchConfig<R extends Routes = Routes> {
  /** Base URL prepended to every request path. No trailing slash required. */
  baseUrl: string;
  /**
   * Route schema table. Typically produced by {@link fromOpenAPI} or
   * written by hand with Zod/Valibot/ArkType schemas.
   */
  routes?: R;
  /** Middleware chain executed in order around every request. */
  middleware?: Middleware[];
  /** Default headers merged into every outgoing request. Per-call headers win. */
  defaultHeaders?: Record<string, string>;
  /**
   * Called once per request (after `defaultHeaders`, before per-call
   * `headers`) to produce headers that depend on per-request state —
   * auth tokens read from a request-scoped context, CSRF tokens, a trace
   * ID, etc.
   *
   * The classic use case is server-side rendering where each request has
   * its own auth context (SvelteKit's `getRequestEvent().cookies`,
   * Cloudflare Workers' per-request env, Next.js server actions). The
   * middleware chain gives you the same power but requires writing a
   * middleware wrapper at every client; `getHeaders` is the one-line
   * shortcut for the common "inject a few dynamic headers" case.
   *
   * **Header precedence** (later overrides earlier):
   * `defaultHeaders` → `getHeaders()` → per-call `headers`
   *
   * May return a Promise for async sources (token refresh, async context
   * lookup). Errors thrown from `getHeaders` surface as a
   * `kind: 'network'` error via `.result()`.
   *
   * @example
   * ```ts
   * export const api = createFetch({
   *   baseUrl,
   *   routes,
   *   getHeaders: () => {
   *     const { accessToken } = getAuthCookies(getRequestEvent().cookies);
   *     return { Authorization: `Bearer ${accessToken}` };
   *   },
   * });
   * ```
   */
  getHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
  /**
   * Custom fetch implementation. Useful for SvelteKit's load `fetch`,
   * Cloudflare Workers, or test mocks. Defaults to `globalThis.fetch`.
   */
  fetch?: FetchFn;
  /**
   * If set, every request gets a per-attempt timeout (in milliseconds)
   * via an auto-prepended `timeout()` middleware. Per-call `timeout`
   * overrides this for individual requests.
   */
  timeout?: number;
  /**
   * If set, retryable failures (network errors and 408/425/429/500/502/
   * 503/504 responses) on idempotent methods are automatically retried via
   * an auto-prepended `retry()` middleware. Pass a number as shorthand for
   * `{ attempts: n }`. Per-call `retry` overrides this for individual
   * requests.
   */
  retry?: number | RetryOptions;
  /**
   * Custom query-string serializer applied to every call's `query` object.
   * Per-call `querySerializer` overrides this for individual requests.
   * See {@link QuerySerializer} for the built-in behavior it replaces.
   */
  querySerializer?: QuerySerializer;
}

// ---------------------------------------------------------------------------
// Type-level helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the path parameter names from a template string as a union.
 *
 * @example
 * ```typescript
 * type P = ExtractPathParams<'/users/{id}/posts/{postId}'>;
 * //   ^? "id" | "postId"
 * ```
 */
export type ExtractPathParams<Path extends string>
  = Path extends `${string}{${infer Param}}${infer Rest}`
    ? Param | ExtractPathParams<Rest>
    : never;

/**
 * Resolves the success response type for a given path + method from a
 * {@link Routes} table. Falls back to `unknown` if the route or its
 * `response` schema is not declared.
 */
export type ResolveResponse<
  R extends Routes,
  P extends string,
  M extends string,
> = P extends keyof R
  ? M extends keyof R[P]
    ? R[P][M] extends { response: Schema<infer T> }
      ? T
      : unknown
    : unknown
  : unknown;

/**
 * Resolves the error response type for a given path + method from a
 * {@link Routes} table. Falls back to `unknown` if the route or its
 * `errorResponse` schema is not declared.
 */
export type ResolveErrorResponse<
  R extends Routes,
  P extends string,
  M extends string,
> = P extends keyof R
  ? M extends keyof R[P]
    ? R[P][M] extends { errorResponse: Schema<infer T> }
      ? T
      : unknown
    : unknown
  : unknown;

/**
 * Resolves the request body type for a given path + method from a
 * {@link Routes} table. Returns `never` when no `body` schema exists, which
 * causes `body` to become optional in {@link TypedFetchOptions}.
 */
export type ResolveBody<
  R extends Routes,
  P extends string,
  M extends string,
> = P extends keyof R
  ? M extends keyof R[P]
    ? R[P][M] extends { body: Schema<infer T> }
      ? T
      : never
    : never
  : never;

/**
 * Resolves the query parameter type for a given path + method from a
 * {@link Routes} table. Returns `never` when no `query` schema exists.
 */
export type ResolveQuery<
  R extends Routes,
  P extends string,
  M extends string,
> = P extends keyof R
  ? M extends keyof R[P]
    ? R[P][M] extends { query: Schema<infer T> }
      ? T
      : never
    : never
  : never;

/**
 * Resolves the response type for a single call when an ad-hoc
 * `responseSchema` is supplied. If the call passes a schema, its inferred
 * output wins; otherwise the type falls back to `FromRoute` (which is
 * usually {@link ResolveResponse} for typed routes, or `unknown` for
 * untyped paths).
 */
export type ResolveAdHocResponse<AdHoc, FromRoute>
  = AdHoc extends StandardSchemaV1<unknown, infer T>
    ? T
    : FromRoute;

/**
 * Call options for a typed fetch invocation. Intersects native `RequestInit`
 * with schema-driven `body`, `params`, and `query` fields. When the matched
 * route declares a `body` schema, `body` becomes required and typed; when
 * the path contains `{param}` placeholders, `params` becomes required.
 *
 * The optional `AdHoc` generic captures the per-call `responseSchema` so its
 * inferred output flows through to the {@link TypedResponse} return type
 * (see {@link ResolveAdHocResponse}). Defaults to `undefined`, in which
 * case the route's declared `response` schema is used instead.
 */
export type TypedFetchOptions<
  R extends Routes,
  P extends string,
  M extends string,
  AdHoc extends StandardSchemaV1 | undefined = undefined,
  OAS = unknown,
> = Omit<RequestInit, 'method' | 'body'> & {
  /** HTTP method for this call. Narrowed to keys of the route definition. */
  method: M;
  /** Per-call fetch override. Falls back to `FetchConfig.fetch`, then `globalThis.fetch`. */
  fetch?: FetchFn;
  /**
   * Per-call middleware override. Pass `false` to skip the configured chain
   * entirely (e.g. for an auth-refresh endpoint that must not trigger the
   * refresh middleware), or an array to replace it for this call only.
   * When omitted, the chain configured via `FetchConfig.middleware` is used.
   */
  middleware?: Middleware[] | false;
  /**
   * Per-call timeout in milliseconds. Overrides `FetchConfig.timeout` for
   * this request only.
   */
  timeout?: number;
  /**
   * Per-call retry configuration. Overrides `FetchConfig.retry` for this
   * request only.
   */
  retry?: number | RetryOptions;
  /**
   * Ad-hoc response schema. When provided, its inferred output type drives
   * the return type of `.result()` — overriding any `response` declared on
   * the matched route.
   */
  responseSchema?: AdHoc;
  /**
   * Per-call query-string serializer. Overrides `FetchConfig.querySerializer`
   * and the built-in serializer for this request only.
   */
  querySerializer?: QuerySerializer;
} & ([ResolveBodyFor<R, OAS, P, M>] extends [never]
  ? { body?: unknown }
  : { body: ResolveBodyFor<R, OAS, P, M> })
& ([ResolveParamsFor<R, OAS, P, M>] extends [never]
  ? { params?: undefined }
  : { params: ResolveParamsFor<R, OAS, P, M> })
& ([ResolveQueryFor<R, OAS, P, M>] extends [never]
  ? { /** Query string object. Arrays become repeated keys; `Date` → ISO 8601; `undefined`/`null` are dropped. */ query?: Record<string, string | number | boolean | Date | ReadonlyArray<string | number | boolean> | undefined> }
  : { /** Typed query parameters from the route definition. */ query?: ResolveQueryFor<R, OAS, P, M> });

/**
 * Untyped fetch options accepted when the caller uses a path or method that
 * is not present in the `Routes` table — falls back to `unknown` body and
 * string-keyed params/query. The `AdHoc` generic carries the optional
 * per-call `responseSchema` for inference parity with {@link TypedFetchOptions}.
 */
type UntypedFetchOptions<
  AdHoc extends StandardSchemaV1 | undefined = undefined,
> = Omit<RequestInit, 'method' | 'body'> & {
  method: string;
  body?: unknown;
  params?: Record<string, string | number>;
  query?: Record<string, string | number | boolean | Date | ReadonlyArray<string | number | boolean> | undefined>;
  fetch?: FetchFn;
  middleware?: Middleware[] | false;
  timeout?: number;
  retry?: number | RetryOptions;
  responseSchema?: AdHoc;
  querySerializer?: QuerySerializer;
};

/**
 * True when a typed call at `path` × `method` has at least one required
 * input — a declared request body or path parameters. Drives whether the
 * shortcut's `options` argument is itself required: `f.post('/login')`
 * must not typecheck when the route demands a body, and
 * `f.get('/users/{id}')` must not typecheck without `params`.
 */
type RequiresOptions<R extends Routes, OAS, P extends string, M extends string>
  = [ResolveBodyFor<R, OAS, P, M>] extends [never]
    ? [ResolveParamsFor<R, OAS, P, M>] extends [never]
        ? false
        : true
    : true;

/**
 * Per-method shortcut type used by {@link TypedFetchFn}'s `.get`, `.post`,
 * etc. Mirrors {@link TypedFetchFn} but pins the HTTP method `M` and omits
 * the `method` field from the options object — so callers write
 * `f.get('/users')` instead of `f('/users', { method: 'GET' })`.
 *
 * The `options` argument is **required** whenever the route declares a
 * request body or the path contains `{param}` placeholders, so a missing
 * body/params is a compile error instead of a runtime validation failure.
 */
export type MethodShortcutFn<
  R extends Routes,
  M extends HttpMethod,
  OAS = unknown,
> = <
  P extends AvailablePaths<R, OAS>,
  AdHoc extends StandardSchemaV1 | undefined = undefined,
>(
  ...args: IsTypedCall<R, OAS, P, M> extends true
    ? RequiresOptions<R, OAS, P, M> extends true
      ? [path: P, options: Omit<TypedFetchOptions<R, P, M, AdHoc, OAS>, 'method'>]
      : [path: P, options?: Omit<TypedFetchOptions<R, P, M, AdHoc, OAS>, 'method'>]
    : [path: P, options?: Omit<UntypedFetchOptions<AdHoc>, 'method'>]
) => TypedFetchPromise<
  IsTypedCall<R, OAS, P, M> extends true
    ? ResolveAdHocResponse<AdHoc, ResolveResponseFor<R, OAS, P, M>>
    : ResolveAdHocResponse<AdHoc, unknown>,
  IsTypedCall<R, OAS, P, M> extends true
    ? ResolveErrorResponseFor<R, OAS, P, M>
    : unknown
>;

/**
 * The typed fetch function returned by {@link createFetch}. Shape mirrors
 * native `fetch` — first arg is the path, second is an options object — but
 * with method/path autocomplete from the `Routes` table, a typed `body`
 * parameter, and a {@link TypedResponse} return type with a typed
 * `.result()` method.
 *
 * The third inner generic (`AdHoc`) is inferred from the call's optional
 * `responseSchema` field; when supplied, its output type takes precedence
 * over the route's declared `response` schema.
 *
 * Also exposes:
 * - {@link MethodShortcutFn | per-method shortcuts} (`.get`, `.post`, ...)
 * - `.with(overrides)` — fork this client with config overrides applied
 */
export interface TypedFetchFn<R extends Routes, OAS = unknown> {
  <
    P extends AvailablePaths<R, OAS>,
    M extends AvailableMethods<R, OAS, P>,
    AdHoc extends StandardSchemaV1 | undefined = undefined,
  >(
    path: P,
    options: IsTypedCall<R, OAS, P, M> extends true
      ? TypedFetchOptions<R, P, M, AdHoc, OAS>
      : UntypedFetchOptions<AdHoc>,
  ): TypedFetchPromise<
    IsTypedCall<R, OAS, P, M> extends true
      ? ResolveAdHocResponse<AdHoc, ResolveResponseFor<R, OAS, P, M>>
      : ResolveAdHocResponse<AdHoc, unknown>,
    IsTypedCall<R, OAS, P, M> extends true
      ? ResolveErrorResponseFor<R, OAS, P, M>
      : unknown
  >;

  /**
   * Forks this typed fetch into a sibling that inherits everything from
   * the parent's config except the supplied `overrides`. Useful for
   * deriving an auth-free client for the login/refresh endpoints from a
   * parent that has an auth middleware installed:
   *
   * ```typescript
   * const api = createFetch({ baseUrl, middleware: [authBearer(...)] });
   * const noAuth = api.with({ middleware: [] });
   * ```
   *
   * **The merge is shallow.** Arrays do NOT concatenate — passing
   * `{ middleware: [extra] }` REPLACES the parent's middleware chain
   * entirely with `[extra]`. To extend the parent's chain, spread it
   * yourself in the override:
   *
   * ```typescript
   * const parentMiddleware = [authBearer(getToken), retry(3)];
   * const api = createFetch({ baseUrl, middleware: parentMiddleware });
   *
   * // Append a logging middleware to the parent's chain
   * const noisy = api.with({
   *   middleware: [...parentMiddleware, async (req, next) => {
   *     console.log(req.method, req.url);
   *     return next(req);
   *   }],
   * });
   * ```
   *
   * The parent is unaffected — `with` returns a brand-new function over a
   * shallow-merged config.
   */
  with: (overrides: Partial<FetchConfig<R>>) => TypedFetchFn<R, OAS>;

  /** Method shortcut: `f.get(path, opts?)` ≡ `f(path, { ...opts, method: 'GET' })` */
  get: MethodShortcutFn<R, 'GET', OAS>;
  /** Method shortcut: `f.post(path, opts?)` ≡ `f(path, { ...opts, method: 'POST' })` */
  post: MethodShortcutFn<R, 'POST', OAS>;
  /** Method shortcut: `f.put(path, opts?)` ≡ `f(path, { ...opts, method: 'PUT' })` */
  put: MethodShortcutFn<R, 'PUT', OAS>;
  /** Method shortcut: `f.delete(path, opts?)` ≡ `f(path, { ...opts, method: 'DELETE' })` */
  delete: MethodShortcutFn<R, 'DELETE', OAS>;
  /** Method shortcut: `f.patch(path, opts?)` ≡ `f(path, { ...opts, method: 'PATCH' })` */
  patch: MethodShortcutFn<R, 'PATCH', OAS>;
  /** Method shortcut: `f.head(path, opts?)` ≡ `f(path, { ...opts, method: 'HEAD' })` */
  head: MethodShortcutFn<R, 'HEAD', OAS>;
  /** Method shortcut: `f.options(path, opts?)` ≡ `f(path, { ...opts, method: 'OPTIONS' })` */
  options: MethodShortcutFn<R, 'OPTIONS', OAS>;
}
