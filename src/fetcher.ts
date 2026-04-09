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
export function createFetch<R extends Routes = Routes>(
  config: FetchConfig<R>,
): TypedFetchFn<R> {
  const {
    baseUrl,
    routes,
    middleware = [],
    defaultHeaders,
    fetch: defaultFetchFn,
    timeout: configTimeout,
    retry: configRetry,
  } = config;

  const fetchFn = async (path: string, options: Record<string, unknown> = {}): Promise<TypedResponse> => {
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

    // Build headers
    const headers = new Headers(defaultHeaders);
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

  // Cast to the rich interface; properties below are attached imperatively.
  const typed = fetchFn as unknown as TypedFetchFn<R>;

  // §4.B4 — instance forking. `with(overrides)` returns a sibling client
  // that inherits this client's config and applies the overrides on top.
  // The parent is unaffected.
  typed.with = (overrides: Partial<FetchConfig<R>>): TypedFetchFn<R> =>
    createFetch<R>({ ...config, ...overrides });

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
