/** Universal schema interface — works with Zod v4, Valibot, ArkType, or any custom validator */
export interface Schema<T = unknown> {
  parse: (data: unknown) => T;
}

/** Infer the output type of a Schema */
export type InferSchema<S> = S extends Schema<infer T> ? T : unknown;

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export type ResultData<T, E = unknown>
  = | { data: T; error?: undefined }
    | { data?: undefined; error: E };

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

export interface TypedResponse<T = unknown, E = unknown> extends Response {
  result: () => Promise<ResultData<T, E>>;
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

export interface RouteDefinition {
  body?: Schema;
  params?: Schema;
  query?: Schema;
  response?: Schema;
  errorResponse?: Schema;
}

export type Routes = Record<string, Partial<Record<HttpMethod, RouteDefinition>>>;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

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

export interface FetchConfig<R extends Routes = Routes> {
  baseUrl: string;
  routes?: R;
  middleware?: Middleware[];
  defaultHeaders?: Record<string, string>;
  fetch?: FetchFn;
}

// ---------------------------------------------------------------------------
// Type-level helpers
// ---------------------------------------------------------------------------

/** Extract path parameter names from a template string like "/users/{id}/posts/{postId}" */
export type ExtractPathParams<Path extends string>
  = Path extends `${string}{${infer Param}}${infer Rest}`
    ? Param | ExtractPathParams<Rest>
    : never;

/** Resolve the response type for a given path + method from routes */
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

/** Resolve the error response type for a given path + method from routes */
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

/** Resolve the body type for a given path + method from routes */
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

/** Options for a typed fetch call */
export type TypedFetchOptions<
  R extends Routes,
  P extends string,
  M extends string,
> = Omit<RequestInit, 'method' | 'body'> & {
  method: M;
  fetch?: FetchFn;
  responseSchema?: Schema;
} & (ResolveBody<R, P, M> extends never
  ? { body?: unknown }
  : { body: ResolveBody<R, P, M> })
& ([ExtractPathParams<P>] extends [never]
  ? { params?: undefined }
  : { params: Record<ExtractPathParams<P>, string> }) & {
    query?: Record<string, string | number | boolean | undefined>;
  };

/** Untyped fetch options for unknown routes */
type UntypedFetchOptions = Omit<RequestInit, 'method' | 'body'> & {
  method: string;
  body?: unknown;
  params?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  fetch?: FetchFn;
  responseSchema?: Schema;
};

/** The typed fetch function returned by createFetch */
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
