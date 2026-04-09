/**
 * Public type definitions shared across `@bajustone/fetcher`: the universal
 * `Schema` contract, the `TypedResponse`/`ResultData` extension of the
 * native `Response`, and the `Routes` / `RouteDefinition` shapes that drive
 * type inference.
 *
 * @module
 */

/**
 * The universal schema interface accepted by `@bajustone/fetcher`. Any
 * object with a `parse(data): T` method works — Zod v4, Valibot, ArkType,
 * or a hand-rolled validator.
 *
 * `parse` must either return the validated value or throw if the input is
 * invalid.
 */
export interface Schema<T = unknown> {
  /** Validate `data` and return it typed as `T`, or throw on failure. */
  parse: (data: unknown) => T;
}

/**
 * Unwraps the output type of a {@link Schema}. `InferSchema<Schema<User>>`
 * resolves to `User`; any non-Schema falls back to `unknown`.
 */
export type InferSchema<S> = S extends Schema<infer T> ? T : unknown;

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/**
 * Discriminated union returned by {@link TypedResponse.result}. On success
 * the `data` field holds the validated value of type `T`; on failure the
 * `error` field holds a value of type `E` (the validated error body, or a
 * thrown `Error` on network/validation failure).
 *
 * @example
 * ```typescript
 * const { data, error } = await response.result();
 * if (error) {
 *   // error: E
 * } else {
 *   // data: T
 * }
 * ```
 */
export type ResultData<T, E = unknown>
  = | { data: T; error?: undefined }
    | { data?: undefined; error: E };

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/**
 * A native `Response` augmented with a typed `.result()` method. All native
 * `Response` members (`.ok`, `.status`, `.headers`, `.json()`, `.text()`,
 * ...) continue to work — `.result()` is an additive extension that parses
 * the body and runs it through the route's schema.
 */
export interface TypedResponse<T = unknown, E = unknown> extends Response {
  /**
   * Parses the response body and validates it against the route's schema,
   * returning a {@link ResultData} discriminated union. Never throws —
   * network failures, validation errors, and HTTP error responses are all
   * surfaced via `{ error }`.
   */
  result: () => Promise<ResultData<T, E>>;
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

/** HTTP verbs supported by the router. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

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
// Middleware
// ---------------------------------------------------------------------------

/**
 * A request/response middleware function — same shape as Hono / Koa.
 * Middlewares receive the outgoing `Request` and a `next()` continuation
 * that invokes the rest of the chain (and ultimately the real fetch), and
 * return the final `Response`. They may mutate request headers, short-
 * circuit with a synthetic response, or wrap the returned promise.
 */
export type Middleware = (
  request: Request,
  next: () => Promise<Response>,
) => Promise<Response>;

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
   * Custom fetch implementation. Useful for SvelteKit's load `fetch`,
   * Cloudflare Workers, or test mocks. Defaults to `globalThis.fetch`.
   */
  fetch?: FetchFn;
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
 * Call options for a typed fetch invocation. Intersects native `RequestInit`
 * with schema-driven `body`, `params`, and `query` fields. When the matched
 * route declares a `body` schema, `body` becomes required and typed; when
 * the path contains `{param}` placeholders, `params` becomes required.
 */
export type TypedFetchOptions<
  R extends Routes,
  P extends string,
  M extends string,
> = Omit<RequestInit, 'method' | 'body'> & {
  /** HTTP method for this call. Narrowed to keys of the route definition. */
  method: M;
  /** Per-call fetch override. Falls back to `FetchConfig.fetch`, then `globalThis.fetch`. */
  fetch?: FetchFn;
  /** Ad-hoc response schema, used when no `response` is declared on the route. */
  responseSchema?: Schema;
} & (ResolveBody<R, P, M> extends never
  ? { body?: unknown }
  : { body: ResolveBody<R, P, M> })
& ([ExtractPathParams<P>] extends [never]
  ? { params?: undefined }
  : { params: Record<ExtractPathParams<P>, string> }) & {
    /** Query string object. Values are coerced to strings; `undefined`/`null` are dropped. */
    query?: Record<string, string | number | boolean | undefined>;
  };

/**
 * Untyped fetch options accepted when the caller uses a path or method that
 * is not present in the `Routes` table — falls back to `unknown` body and
 * string-keyed params/query.
 */
type UntypedFetchOptions = Omit<RequestInit, 'method' | 'body'> & {
  method: string;
  body?: unknown;
  params?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  fetch?: FetchFn;
  responseSchema?: Schema;
};

/**
 * The typed fetch function returned by {@link createFetch}. Shape mirrors
 * native `fetch` — first arg is the path, second is an options object — but
 * with method/path autocomplete from the `Routes` table, a typed `body`
 * parameter, and a {@link TypedResponse} return type with a typed
 * `.result()` method.
 */
export type TypedFetchFn<R extends Routes> = <
  P extends (keyof R & string) | (string & {}),
  M extends P extends keyof R
    ? (keyof R[P] & string) | (string & {})
    : string,
>(
  path: P,
  options: P extends keyof R
    ? M extends keyof R[P] & string
      ? TypedFetchOptions<R, P, M>
      : UntypedFetchOptions
    : UntypedFetchOptions,
) => Promise<
  P extends keyof R
    ? M extends keyof R[P] & string
      ? TypedResponse<ResolveResponse<R, P, M>, ResolveErrorResponse<R, P, M>>
      : TypedResponse
    : TypedResponse
>;
