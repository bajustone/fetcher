/**
 * Core fetch factory — returns a typed `fetch`-shaped function that validates
 * requests/responses against a `Routes` table and extends each `Response`
 * with a `.result()` method.
 *
 * @module
 */

import type {
  FetchConfig,
  FetcherError,
  FetcherErrorLocation,
  FetchFn,
  Middleware,
  ResultData,
  RetryOptions,
  RouteDefinition,
  Routes,
  Schema,
  StandardSchemaV1Issue,
  TypedFetchFn,
  TypedResponse,
} from './types.ts';
import { executeMiddleware, retry, timeout } from './middleware.ts';

/**
 * Creates a typed fetch function. Returns a function with the same shape as
 * native `fetch` — first arg is path, second is options — but with type
 * inference from route schemas and an extended Response with `.result()`.
 *
 * ```typescript
 * const f = createFetch({
 *   baseUrl: 'https://api.example.com',
 *   routes: fromOpenAPI(spec),
 * })
 *
 * const response = await f('/auth/login', {
 *   method: 'POST',
 *   body: { email: 'a@b.com', password: 'secret' },
 * })
 *
 * // Native Response methods work
 * response.ok      // boolean
 * response.status  // number
 *
 * // Typed + validated
 * const { data, error } = await response.result()
 * ```
 */
export function createFetch<
  OAS = unknown,
  R extends Routes = Routes,
>(
  config: FetchConfig<R>,
): TypedFetchFn<R, OAS> {
  const {
    baseUrl,
    routes,
    middleware = [],
    defaultHeaders,
    getHeaders,
    fetch: defaultFetchFn,
    timeout: configTimeout,
    retry: configRetry,
  } = config;

  const rawFetchFn = async (path: string, options: Record<string, unknown> = {}): Promise<TypedResponse> => {
    const {
      method = 'GET',
      body,
      params,
      query,
      fetch: callFetchFn,
      middleware: callMiddleware,
      timeout: callTimeout,
      retry: callRetry,
      responseSchema: adHocResponseSchema,
      headers: callHeaders,
      ...restInit
    } = options;

    // Resolve which user middleware chain to use for this call. `false`
    // skips the chain entirely (e.g. for an auth-refresh endpoint that
    // must not trigger the refresh middleware); an array replaces the
    // chain for this call only; `undefined` falls back to the config-level
    // chain.
    const baseMiddleware: Middleware[]
      = callMiddleware === false
        ? []
        : Array.isArray(callMiddleware)
          ? (callMiddleware as Middleware[])
          : middleware;

    // Auto-prepend retry and timeout middlewares. Per-call options override
    // config. Order: retry outermost → timeout → user middleware → fetch.
    // Rationale: this gives each retry attempt a fresh timeout, and lets
    // user middleware (e.g. authBearer) re-run on every attempt.
    const effectiveTimeout: number | undefined = callTimeout !== undefined
      ? (callTimeout as number)
      : configTimeout;
    const effectiveRetry: number | RetryOptions | undefined = callRetry !== undefined
      ? (callRetry as number | RetryOptions)
      : configRetry;

    const builtins: Middleware[] = [];
    if (effectiveRetry !== undefined)
      builtins.push(retry(effectiveRetry));
    if (effectiveTimeout !== undefined)
      builtins.push(timeout(effectiveTimeout));

    const effectiveMiddleware: Middleware[] = builtins.length > 0
      ? [...builtins, ...baseMiddleware]
      : baseMiddleware;

    // Resolve the route definition (if routes defined)
    const methodMap = routes?.[path] as
      | Partial<Record<string, RouteDefinition>>
      | undefined;
    const routeDef = methodMap?.[method as string];

    // Determine the response schemas (used both for the success path and
    // the synthetic-error path so the wrapper has consistent typing).
    const responseSchema: Schema | undefined
      = (adHocResponseSchema as Schema | undefined) ?? routeDef?.response;
    const errorResponseSchema: Schema | undefined = routeDef?.errorResponse;

    // §4.A3: validate body / params / query into a precomputed error
    // instead of throwing. First-failure-wins, ordered params → query →
    // body to match the previous Step 1 behavior.
    let precomputedError: FetcherError | undefined;

    if (routeDef?.params && params !== undefined) {
      const r = await routeDef.params['~standard'].validate(params);
      if (r.issues)
        precomputedError = makeValidationError('params', r.issues);
    }

    if (!precomputedError && routeDef?.query && query !== undefined) {
      const r = await routeDef.query['~standard'].validate(query);
      if (r.issues)
        precomputedError = makeValidationError('query', r.issues);
    }

    if (
      !precomputedError
      && routeDef?.body
      && body !== undefined
      && body !== null
    ) {
      const r = await routeDef.body['~standard'].validate(body);
      if (r.issues)
        precomputedError = makeValidationError('body', r.issues);
    }

    // If client-side validation failed, short-circuit with a synthetic
    // network-error response carrying the precomputed error. The Idea 1
    // invariant holds — `Response.error()` is still a real `Response`.
    if (precomputedError) {
      return wrapResponse(
        Response.error(),
        responseSchema,
        errorResponseSchema,
        precomputedError,
      );
    }

    // Build URL
    let url = interpolatePath(
      `${baseUrl}${path}`,
      params as Record<string, string> | undefined,
    );

    // Query params
    if (query && typeof query === 'object') {
      const searchParams = new URLSearchParams();
      for (const [key, value] of Object.entries(
        query as Record<string, unknown>,
      )) {
        if (value !== undefined && value !== null) {
          searchParams.set(key, String(value));
        }
      }
      const qs = searchParams.toString();
      if (qs)
        url += `?${qs}`;
    }

    // Build headers. Precedence (later overrides earlier):
    //   defaultHeaders → getHeaders() → per-call headers.
    // `getHeaders` runs once per request; its thrown/rejected errors
    // surface as `kind: 'network'` so `.result()` never throws.
    const headers = new Headers(defaultHeaders);
    if (getHeaders) {
      let dynamic: Record<string, string>;
      try {
        const maybe = getHeaders();
        dynamic = maybe instanceof Promise ? await maybe : maybe;
      }
      catch (cause) {
        return wrapResponse(
          Response.error(),
          responseSchema,
          errorResponseSchema,
          { kind: 'network', cause },
        );
      }
      for (const [key, value] of Object.entries(dynamic))
        headers.set(key, value);
    }
    if (callHeaders) {
      const h = new Headers(callHeaders as Record<string, string>);
      h.forEach((value, key) => headers.set(key, value));
    }

    // Serialize body (validation already happened above)
    let serializedBody: string | FormData | Blob | ArrayBuffer | URLSearchParams | undefined;
    if (body !== undefined && body !== null) {
      if (
        typeof body === 'string'
        || body instanceof FormData
        || body instanceof Blob
        || body instanceof ArrayBuffer
        || body instanceof URLSearchParams
      ) {
        serializedBody = body;
      }
      else {
        serializedBody = JSON.stringify(body);
        if (!headers.has('Content-Type')) {
          headers.set('Content-Type', 'application/json');
        }
      }
    }

    // Build the Request
    const request = new Request(url, {
      method: method as string,
      headers,
      body: serializedBody,
      ...restInit,
    });

    // Pick the fetch implementation
    const actualFetch: FetchFn
      = (callFetchFn as FetchFn | undefined)
        ?? defaultFetchFn
        ?? (req => globalThis.fetch(req));

    // Execute through middleware chain. Catch transport-level rejections
    // (network failures, AbortError, etc.) and surface them as
    // `kind: 'network'` precomputed errors so `.result()` never throws.
    let response: Response;
    try {
      response = await executeMiddleware(
        effectiveMiddleware,
        request,
        req => actualFetch(req),
      );
    }
    catch (cause) {
      return wrapResponse(
        Response.error(),
        responseSchema,
        errorResponseSchema,
        { kind: 'network', cause },
      );
    }

    // Wrap the response with .result()
    return wrapResponse(response, responseSchema, errorResponseSchema);
  };

  // Wrap rawFetchFn so every returned promise has `.result()`, `.unwrap()`,
  // and `.query()` shorthands.
  const fetchFn = (path: string, options: Record<string, unknown> = {}): any => {
    const promise = rawFetchFn(path, options);
    const resultFn = (): Promise<ResultData<unknown>> => promise.then((r: TypedResponse) => r.result());
    const unwrapFn = (): Promise<unknown> => resultFn().then((r) => {
      if (r.ok)
        return r.data;
      throw toRequestError(r.error);
    });
    return Object.assign(promise, {
      result: resultFn,
      unwrap: unwrapFn,
      query: () => ({
        key: buildQueryKey(
          (options.method as string) ?? 'GET',
          path,
          options.params as Record<string, string> | undefined,
          options.query as Record<string, unknown> | undefined,
        ),
        fn: () => unwrapFn(),
      }),
    });
  };

  // Cast to the rich interface; properties below are attached imperatively.
  // The OAS generic is a phantom — it carries the user-supplied `paths`
  // interface (when present) through to call-site type inference, but has
  // no runtime representation.
  const typed = fetchFn as unknown as TypedFetchFn<R, OAS>;

  // §4.B4 — instance forking. `with(overrides)` returns a sibling client
  // that inherits this client's config and applies the overrides on top.
  // The parent is unaffected. The OAS generic is propagated explicitly so
  // forks preserve OpenAPI-paths-based type inference.
  typed.with = (overrides: Partial<FetchConfig<R>>): TypedFetchFn<R, OAS> =>
    createFetch<OAS, R>({ ...config, ...overrides });

  // §4.B3 — method shortcuts. Each is a thin wrapper that injects the
  // HTTP method and forwards to the canonical long-form call.
  const makeShortcut = (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',

  ): any =>

    (path: string, options: Record<string, any> = {}) =>
      fetchFn(path, { ...options, method });

  typed.get = makeShortcut('GET');
  typed.post = makeShortcut('POST');
  typed.put = makeShortcut('PUT');
  typed.delete = makeShortcut('DELETE');
  typed.patch = makeShortcut('PATCH');

  return typed;
}

function makeValidationError(
  location: FetcherErrorLocation,
  issues: ReadonlyArray<StandardSchemaV1Issue>,
): FetcherError {
  return { kind: 'validation', location, issues };
}

function wrapResponse<T, HttpErrorBody>(
  response: Response,
  responseSchema?: Schema<T>,
  errorResponseSchema?: Schema<HttpErrorBody>,
  precomputedError?: FetcherError<HttpErrorBody>,
): TypedResponse<T, HttpErrorBody> {
  const typedResponse = response as TypedResponse<T, HttpErrorBody>;

  // Short-circuit: client-side validation or transport failure already
  // produced a typed error. Skip cloning (Response.error() can't be cloned)
  // and surface the precomputed error directly. The Idea 1 invariant still
  // holds — `typedResponse` is the real (synthetic) Response.
  if (precomputedError) {
    typedResponse.result = async (): Promise<ResultData<T, HttpErrorBody>> => ({
      ok: false,
      error: precomputedError,
    });
    return typedResponse;
  }

  // Clone the response so .result() can read the body independently of
  // native methods like .json() or .text(). Cache the parsed result so
  // .result() is idempotent — repeated calls return the same value
  // without re-consuming the (now-used) clone.
  const cloned = response.clone();
  let cached: Promise<ResultData<T, HttpErrorBody>> | undefined;

  typedResponse.result = async (): Promise<ResultData<T, HttpErrorBody>> => {
    if (cached)
      return cached;
    cached = computeResult(cloned, responseSchema, errorResponseSchema);
    return cached;
  };

  return typedResponse;
}

async function computeResult<T, HttpErrorBody>(
  cloned: Response,
  responseSchema?: Schema<T>,
  errorResponseSchema?: Schema<HttpErrorBody>,
): Promise<ResultData<T, HttpErrorBody>> {
  try {
    const contentType = cloned.headers.get('content-type') ?? '';
    const isJSON = contentType.includes('application/json');

    if (!cloned.ok) {
      // HTTP 4xx/5xx — surface as kind: 'http' with parsed (and, if a
      // schema is declared, validated) body.
      const status = cloned.status;
      let parsedBody: unknown;

      if (isJSON) {
        try {
          parsedBody = await cloned.json();
        }
        catch (cause) {
          return { ok: false, error: { kind: 'network', cause } };
        }
      }
      else {
        parsedBody = await cloned.text();
      }

      if (errorResponseSchema && parsedBody !== undefined) {
        const r = await errorResponseSchema['~standard'].validate(parsedBody);
        if (r.issues) {
          return {
            ok: false,
            error: { kind: 'validation', location: 'response', issues: r.issues },
          };
        }
        return {
          ok: false,
          error: { kind: 'http', status, body: r.value as HttpErrorBody },
        };
      }

      return {
        ok: false,
        error: { kind: 'http', status, body: parsedBody as HttpErrorBody },
      };
    }

    // HTTP 2xx — parse the success body and run it through the success schema.
    if (isJSON) {
      let jsonBody: unknown;
      try {
        jsonBody = await cloned.json();
      }
      catch (cause) {
        return { ok: false, error: { kind: 'network', cause } };
      }

      if (responseSchema) {
        const r = await responseSchema['~standard'].validate(jsonBody);
        if (r.issues) {
          return {
            ok: false,
            error: { kind: 'validation', location: 'response', issues: r.issues },
          };
        }
        return { ok: true, data: r.value as T };
      }
      return { ok: true, data: jsonBody as T };
    }

    const textBody = await cloned.text();
    return { ok: true, data: textBody as T };
  }
  catch (cause) {
    return { ok: false, error: { kind: 'network', cause } };
  }
}

function interpolatePath(
  path: string,
  params?: Record<string, string>,
): string {
  if (!params)
    return path;
  return path.replace(/\{([^}]+)\}/g, (_, key: string) => {
    const value = params[key];
    if (value === undefined) {
      throw new Error(`Missing path parameter: ${key}`);
    }
    return encodeURIComponent(value);
  });
}

/**
 * Builds a deterministic cache key from the call arguments. The key format
 * is `[method, path, params?, query?]` — compatible with TanStack Query's
 * array keys and serializable for SWR's string keys.
 */
function buildQueryKey(
  method: string,
  path: string,
  params?: Record<string, string>,
  query?: Record<string, unknown>,
): ReadonlyArray<string | Record<string, unknown>> {
  const key: Array<string | Record<string, unknown>> = [method, path];
  if (params && Object.keys(params).length > 0)
    key.push(params);
  if (query) {
    const filtered: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null)
        filtered[k] = v;
    }
    if (Object.keys(filtered).length > 0)
      key.push(filtered);
  }
  return key;
}

/**
 * Error thrown by {@link TypedFetchPromise.unwrap} when the result is not ok.
 * Base class of {@link FetcherNetworkError}, {@link FetcherValidationError},
 * and {@link FetcherHTTPError} — catch `FetcherRequestError` to handle any
 * unwrap failure, or `instanceof` the subclass you care about for narrowed
 * access to `cause` / `issues` / `body`.
 *
 * Carries the full {@link FetcherError} discriminated union plus a derived
 * HTTP `status` code so framework error boundaries can map it directly.
 *
 * - `kind: 'http'` → `status` is the HTTP status code (4xx/5xx)
 * - `kind: 'network'` or `'validation'` → `status` is `500`
 *
 * ```typescript
 * try {
 *   const data = await api.get('/users').unwrap();
 * } catch (err) {
 *   if (err instanceof FetcherHTTPError) {
 *     // err.body is narrowed to the declared 4xx response type
 *     err.status;
 *   } else if (err instanceof FetcherValidationError) {
 *     err.issues; // readonly StandardSchemaV1Issue[]
 *   } else if (err instanceof FetcherNetworkError) {
 *     err.cause;  // unknown — the raw transport failure
 *   }
 * }
 * ```
 *
 * The `Body` generic flows through from {@link TypedFetchPromise} and is
 * narrowed on {@link FetcherHTTPError}. `FetcherRequestError<Body>.fetcherError`
 * remains the full discriminated union.
 */
export class FetcherRequestError<Body = unknown> extends Error {
  readonly fetcherError: FetcherError<Body>;
  readonly status: number;

  constructor(error: FetcherError<Body>) {
    super(extractErrorMessage(error as FetcherError));
    this.name = 'FetcherRequestError';
    this.fetcherError = error;
    this.status = error.kind === 'http' ? error.status : 500;
  }
}

/**
 * Subclass of {@link FetcherRequestError} thrown when the underlying fetch
 * rejected (network failure, DNS failure, AbortError not triggered by the
 * user's signal, etc.). `cause` holds the raw thrown value.
 *
 * ```ts
 * try { await api.get('/pets').unwrap(); }
 * catch (err) {
 *   if (err instanceof FetcherNetworkError) err.cause;
 * }
 * ```
 */
export class FetcherNetworkError extends FetcherRequestError {
  constructor(cause: unknown) {
    super({ kind: 'network', cause });
    this.name = 'FetcherNetworkError';
  }

  override get cause(): unknown {
    const e = this.fetcherError;
    return e.kind === 'network' ? e.cause : undefined;
  }
}

/**
 * Subclass of {@link FetcherRequestError} thrown when a Standard Schema V1
 * validator rejected the request body/params/query (client-side, before the
 * request left the process) or the response body (server-side).
 *
 * `location` tells you which slot failed; `issues` is the raw issue list.
 */
export class FetcherValidationError extends FetcherRequestError {
  constructor(location: FetcherErrorLocation, issues: ReadonlyArray<StandardSchemaV1Issue>) {
    super({ kind: 'validation', location, issues });
    this.name = 'FetcherValidationError';
  }

  get location(): FetcherErrorLocation {
    const e = this.fetcherError;
    // Narrowed at runtime — subclass is only constructed with kind: 'validation'.
    return (e as Extract<FetcherError, { kind: 'validation' }>).location;
  }

  get issues(): ReadonlyArray<StandardSchemaV1Issue> {
    const e = this.fetcherError;
    return (e as Extract<FetcherError, { kind: 'validation' }>).issues;
  }
}

/**
 * Subclass of {@link FetcherRequestError} thrown on a 4xx/5xx HTTP response.
 * `status` is the HTTP status code; `body` is the parsed (and, if the route
 * declared an `errorResponse` schema, validated) error body, narrowed to the
 * spec's declared error shape via the `Body` generic.
 *
 * ```ts
 * try { await api.get('/pets/{id}').unwrap(); }
 * catch (err) {
 *   if (err instanceof FetcherHTTPError && err.status === 404) {
 *     err.body; // narrowed to the 4xx response schema
 *   }
 * }
 * ```
 */
export class FetcherHTTPError<Body = unknown> extends FetcherRequestError<Body> {
  constructor(status: number, body: Body) {
    super({ kind: 'http', status, body });
    this.name = 'FetcherHTTPError';
  }

  get body(): Body {
    const e = this.fetcherError;
    // Narrowed at runtime — subclass is only constructed with kind: 'http'.
    return (e as Extract<FetcherError<Body>, { kind: 'http' }>).body;
  }
}

/**
 * Dispatches a {@link FetcherError} to the matching {@link FetcherRequestError}
 * subclass. Used by `.unwrap()` so thrown errors are `instanceof`-narrowable
 * without the `err.fetcherError.kind === 'http'` dance.
 */
function toRequestError(error: FetcherError): FetcherRequestError {
  switch (error.kind) {
    case 'network':
      return new FetcherNetworkError(error.cause);
    case 'validation':
      return new FetcherValidationError(error.location, error.issues);
    case 'http':
      return new FetcherHTTPError(error.status, error.body);
  }
}

/**
 * Extracts a human-readable error message from a {@link FetcherError}.
 * Handles all three error kinds so consumers don't need to write their
 * own switch/case boilerplate.
 *
 * - `'network'` — returns `cause.message` if `cause` is an `Error`, otherwise `String(cause)`
 * - `'validation'` — joins all issue messages with `, `
 * - `'http'` — looks for `body.error.message` or `body.message` (common API patterns), falls back to `HTTP {status}`
 */
export function extractErrorMessage(error: FetcherError): string {
  switch (error.kind) {
    case 'network':
      return error.cause instanceof Error ? error.cause.message : String(error.cause);
    case 'validation':
      return error.issues.map(i => i.message).join(', ');
    case 'http': {
      if (typeof error.body === 'object' && error.body !== null) {
        const b = error.body as Record<string, unknown>;
        const msg = b.error && typeof b.error === 'object'
          ? (b.error as Record<string, unknown>).message
          : b.message;
        if (typeof msg === 'string')
          return msg;
      }
      return `HTTP ${error.status}`;
    }
  }
}
