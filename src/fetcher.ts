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
  HttpMethod,
  Middleware,
  QuerySerializer,
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
      method: rawMethod = 'GET',
      body,
      params,
      query,
      fetch: callFetchFn,
      middleware: callMiddleware,
      timeout: callTimeout,
      retry: callRetry,
      responseSchema: adHocResponseSchema,
      querySerializer: callQuerySerializer,
      headers: callHeaders,
      ...restInit
    } = options;

    // Lowercase methods are normalized so `method: 'post'` hits the same
    // route definition (and the same validation) as `method: 'POST'`.
    const method = String(rawMethod).toUpperCase();
    const effectiveQuerySerializer = (callQuerySerializer as QuerySerializer | undefined)
      ?? config.querySerializer;

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
    const routeDef = methodMap?.[method];

    // Determine the response schemas (used both for the success path and
    // the synthetic-error path so the wrapper has consistent typing).
    const responseSchema: Schema | undefined
      = (adHocResponseSchema as Schema | undefined) ?? routeDef?.response;
    const errorResponseSchema: Schema | undefined = routeDef?.errorResponse;

    // §4.A3: validate body / params / query into a precomputed error
    // instead of throwing. First-failure-wins, ordered params → query →
    // body. The VALIDATED OUTPUT (not the raw input) is what goes on the
    // wire — Standard Schema transforms and defaults are applied, matching
    // the contract every schema library documents.
    //
    // `body` is validated whenever the route declares a `body` schema —
    // even when the caller omitted it — so a required body that was
    // forgotten is a validation error, not a silent empty request. Schemas
    // for optional bodies model absence explicitly (optional/default).
    let precomputedError: FetcherError | undefined;
    let effectiveParams = params as Record<string, string | number> | undefined;
    let effectiveQuery = query as Record<string, unknown> | undefined;
    let effectiveBody = body;

    if (routeDef?.params && params !== undefined) {
      const r = await routeDef.params['~standard'].validate(params);
      if (r.issues)
        precomputedError = makeValidationError('params', r.issues);
      else
        effectiveParams = r.value as Record<string, string | number>;
    }

    // Like `body`, a declared `query` schema runs even when the caller
    // omitted the query (validated as `{}`): required query parameters are
    // a validation error instead of a silently incomplete request, and
    // query defaults/transforms fire. All-optional query schemas accept {}.
    if (!precomputedError && routeDef?.query) {
      const r = await routeDef.query['~standard'].validate(query ?? {});
      if (r.issues)
        precomputedError = makeValidationError('query', r.issues);
      else
        effectiveQuery = r.value as Record<string, unknown>;
    }

    if (!precomputedError && routeDef?.body) {
      const r = await routeDef.body['~standard'].validate(body);
      if (r.issues)
        precomputedError = makeValidationError('body', r.issues);
      else
        effectiveBody = r.value;
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

    // Build URL. The baseUrl/path join is normalized (exactly one slash at
    // the seam; an absolute-URL path wins over baseUrl entirely), and
    // interpolation runs whether or not a `params` object was passed — a
    // path template with no params at all is a validation error, not a
    // literal `{id}` sent to the server.
    const missingParams: string[] = [];
    let url = interpolatePath(
      joinUrl(baseUrl, path),
      effectiveParams,
      missingParams,
    );
    if (missingParams.length) {
      return wrapResponse(
        Response.error(),
        responseSchema,
        errorResponseSchema,
        makeValidationError(
          'params',
          missingParams.map(key => ({
            code: 'missing',
            message: `Missing path parameter: ${key}`,
            path: [key],
          })),
        ),
      );
    }

    // Query params. Arrays serialize as repeated keys (OpenAPI
    // form/explode=true — what openapi-typescript-generated types imply),
    // `Date` as ISO 8601, and a path that already carries a query string
    // is merged with `&`. Plain-object values have no universal wire
    // encoding — they surface as a validation error instead of
    // `[object Object]`. A custom `querySerializer` overrides all of this.
    if (effectiveQuery && typeof effectiveQuery === 'object') {
      // A throwing user querySerializer must not escape the never-throws
      // funnel — same treatment as getHeaders failures.
      let serialized: ReturnType<typeof serializeQuery>;
      try {
        serialized = serializeQuery(effectiveQuery, effectiveQuerySerializer);
      }
      catch (cause) {
        return wrapResponse(
          Response.error(),
          responseSchema,
          errorResponseSchema,
          { kind: 'network', cause },
        );
      }
      if ('invalidKey' in serialized) {
        return wrapResponse(
          Response.error(),
          responseSchema,
          errorResponseSchema,
          makeValidationError('query', [{
            code: 'unserializable_value',
            message: `Query parameter "${serialized.invalidKey}" is a plain object — provide a querySerializer to encode nested values`,
            path: [serialized.invalidKey],
          }]),
        );
      }
      if (serialized.qs)
        url += `${url.includes('?') ? '&' : '?'}${serialized.qs}`;
    }

    // Everything from here through Request construction can throw on bad
    // input (invalid header names/values, malformed URLs, GET-with-body)
    // — all caller bugs, all funneled into the never-throws contract.
    let request: Request;
    try {
      // Build headers. Precedence (later overrides earlier):
      //   defaultHeaders → getHeaders() → per-call headers.
      const headers = new Headers(defaultHeaders);
      if (getHeaders) {
        const maybe = getHeaders();
        const dynamic = maybe instanceof Promise ? await maybe : maybe;
        for (const [key, value] of Object.entries(dynamic))
          headers.set(key, value);
      }
      if (callHeaders) {
        const h = new Headers(callHeaders as Record<string, string>);
        h.forEach((value, key) => headers.set(key, value));
      }

      // Serialize the (validated) body. Binary and stream payloads pass
      // through untouched — only plain data is JSON-encoded, and the
      // Content-Type default applies only when we did the encoding.
      // `null` sends NO body (0.x behavior — `body: payload ?? null` is a
      // common idiom, and GET/HEAD Requests reject any body on Node/Deno);
      // it is still validated against a declared body schema above.
      let serializedBody: BodyInit | undefined;
      let isStreamBody = false;
      if (effectiveBody !== undefined && effectiveBody !== null) {
        if (
          typeof effectiveBody === 'string'
          || effectiveBody instanceof FormData
          || effectiveBody instanceof Blob
          || effectiveBody instanceof ArrayBuffer
          || effectiveBody instanceof URLSearchParams
          || ArrayBuffer.isView(effectiveBody)
        ) {
          serializedBody = effectiveBody as BodyInit;
        }
        else if (typeof ReadableStream !== 'undefined' && effectiveBody instanceof ReadableStream) {
          serializedBody = effectiveBody;
          isStreamBody = true;
        }
        else {
          serializedBody = JSON.stringify(effectiveBody);
          if (!headers.has('Content-Type')) {
            headers.set('Content-Type', 'application/json');
          }
        }
      }

      // Stream bodies require `duplex: 'half'` per the fetch spec
      // (enforced by Node/undici and Bun; ignored where not needed).
      const init: RequestInit & { duplex?: 'half' } = {
        method,
        headers,
        body: serializedBody,
        ...restInit,
      };
      if (isStreamBody && init.duplex === undefined)
        init.duplex = 'half';

      request = new Request(url, init);
    }
    catch (cause) {
      return wrapResponse(
        Response.error(),
        responseSchema,
        errorResponseSchema,
        { kind: 'network', cause },
      );
    }

    // Pick the fetch implementation
    const actualFetch: FetchFn
      = (callFetchFn as FetchFn | undefined)
        ?? defaultFetchFn
        ?? (req => globalThis.fetch(req));

    // Execute through middleware chain. Catch transport-level rejections
    // and surface them through the never-throws contract, classified:
    // caller-initiated aborts → 'aborted', deadline aborts → 'timeout',
    // everything else → 'network'.
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
        classifyTransportError(cause, request.signal),
      );
    }

    // Wrap the response with .result()
    return wrapResponse(response, responseSchema, errorResponseSchema);
  };

  // Wrap rawFetchFn so every returned promise has `.result()`, `.unwrap()`,
  // and `.query()` shorthands.
  //
  // The returned object is LAZY: the request is dispatched on the first
  // `.then()` / `.result()` / `.unwrap()`, not at call time. This is what
  // makes `.query()` honest — building a descriptor fires nothing, and a
  // rejection can never become an unhandled rejection on a promise nobody
  // consumed. `.query().fn()` issues a FRESH request per invocation so
  // cache refetches always hit the network.
  const fetchFn = (path: string, options: Record<string, unknown> = {}): any => {
    let started: Promise<TypedResponse> | undefined;
    const start = (): Promise<TypedResponse> => (started ??= rawFetchFn(path, options));
    const resultFn = (): Promise<ResultData<unknown>> => start().then((r: TypedResponse) => r.result());
    const unwrapFn = (): Promise<unknown> => resultFn().then((r) => {
      if (r.ok)
        return r.data;
      throw toRequestError(r.error);
    });
    const lazy: PromiseLike<TypedResponse> & Record<string, unknown> = {
      then: (onFulfilled?: any, onRejected?: any) => start().then(onFulfilled, onRejected),
      catch: (onRejected?: any) => start().catch(onRejected),
      finally: (onFinally?: any) => start().finally(onFinally),
      [Symbol.toStringTag as unknown as string]: 'TypedFetchPromise',
      result: resultFn,
      unwrap: unwrapFn,
      query: () => ({
        key: buildQueryKey(
          String(options.method ?? 'GET').toUpperCase(),
          joinUrl(baseUrl, path),
          options.params as Record<string, unknown> | undefined,
          options.query as Record<string, unknown> | undefined,
          options.body,
        ),
        // A fresh lazy call per fn() invocation — refetches re-hit the
        // network instead of replaying a memoized first response.
        fn: () => fetchFn(path, options).unwrap(),
      }),
    };
    return lazy;
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
  const makeShortcut = (method: HttpMethod): any =>
    (path: string, options: Record<string, any> = {}) =>
      fetchFn(path, { ...options, method });

  typed.get = makeShortcut('GET');
  typed.post = makeShortcut('POST');
  typed.put = makeShortcut('PUT');
  typed.delete = makeShortcut('DELETE');
  typed.patch = makeShortcut('PATCH');
  typed.head = makeShortcut('HEAD');
  typed.options = makeShortcut('OPTIONS');

  return typed;
}

/**
 * Joins `baseUrl` and `path` with exactly one slash at the seam. An
 * absolute-URL `path` (anything with a scheme, e.g. `https://...`) is used
 * as-is — it does NOT concatenate onto `baseUrl`, which would silently
 * corrupt the host. A baseUrl read from an env var with a trailing slash
 * and a path with a leading slash no longer produce `//`.
 */
const ABSOLUTE_URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

function joinUrl(baseUrl: string, path: string): string {
  if (ABSOLUTE_URL_RE.test(path))
    return path;
  if (!baseUrl)
    return path;
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return path.startsWith('/') ? `${base}${path}` : `${base}/${path}`;
}

/**
 * Serializes a query object into a query string (no leading `?`). Arrays
 * become repeated keys (`ids=1&ids=2` — OpenAPI form/explode=true), `Date`
 * becomes ISO 8601, `undefined`/`null` entries are dropped. Plain-object
 * values are rejected (returned as `{ invalidKey }`) because they have no
 * universal wire encoding. A user-supplied {@link QuerySerializer} takes
 * over completely when provided.
 */
function serializeQuery(
  query: Record<string, unknown>,
  querySerializer: QuerySerializer | undefined,
): { qs: string } | { invalidKey: string } {
  if (querySerializer) {
    const out = querySerializer(query);
    return { qs: typeof out === 'string' ? out : out.toString() };
  }
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null)
      continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null)
          continue;
        const scalar = toQueryScalar(item);
        if (scalar === null)
          return { invalidKey: key };
        searchParams.append(key, scalar);
      }
      continue;
    }
    const scalar = toQueryScalar(value);
    if (scalar === null)
      return { invalidKey: key };
    searchParams.append(key, scalar);
  }
  return { qs: searchParams.toString() };
}

/** Encodes one query value; `null` return = not scalar-encodable. */
function toQueryScalar(value: unknown): string | null {
  if (typeof value === 'string')
    return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
    return String(value);
  if (value instanceof Date)
    return value.toISOString();
  if (typeof value === 'object')
    return null;
  return String(value);
}

/**
 * Classifies a transport-level rejection into the FetcherError union.
 * Order matters: the caller's own signal wins (an abort reason can be any
 * value, so the signal check — not the error name — is authoritative),
 * then `TimeoutError` (what `timeout()` middleware and
 * `AbortSignal.timeout` produce), then other aborts, then plain network
 * failures.
 */
function classifyTransportError(cause: unknown, userSignal: AbortSignal | undefined): FetcherError {
  // A user signal whose reason is a TimeoutError (the idiomatic
  // `signal: AbortSignal.timeout(ms)`) is a deadline, not an intentional
  // cancellation — check the effective reason's name BEFORE the aborted
  // branch so 'timeout' wins, as documented on FetcherError.
  const reason = userSignal?.aborted ? (userSignal.reason ?? cause) : cause;
  if (reason instanceof Error && reason.name === 'TimeoutError')
    return { kind: 'timeout', cause: reason };
  if (userSignal?.aborted)
    return { kind: 'aborted', cause: reason };
  if (reason instanceof Error && reason.name === 'AbortError')
    return { kind: 'aborted', cause: reason };
  return { kind: 'network', cause };
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

  // Clone LAZILY on the first .result() call, so a response whose .result()
  // is never used (status-only checks, streaming consumers) never buffers a
  // second copy of the body in memory. The parsed result is cached so
  // .result() is idempotent.
  //
  // Ordering note: call .result() before (or instead of) consuming the body
  // with native methods. `.result()` first, `.json()` after works — the
  // clone leaves the original stream untouched. The reverse returns a
  // structured error instead of throwing.
  let cached: Promise<ResultData<T, HttpErrorBody>> | undefined;

  typedResponse.result = async (): Promise<ResultData<T, HttpErrorBody>> => {
    if (cached)
      return cached;
    let cloned: Response;
    try {
      // The bodyUsed guard makes the failure deterministic: some runtimes
      // let clone() succeed after a native read but hand back an empty
      // body, which would silently masquerade as a bodiless response.
      if (response.bodyUsed)
        throw new TypeError('.result() called after the response body was consumed — call .result() first, or read the body with native methods only');
      cloned = response.clone();
    }
    catch (cause) {
      cached = Promise.resolve({ ok: false, error: { kind: 'network', cause } });
      return cached;
    }
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
    const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
    // `application/json` plus the RFC 6839 structured-syntax family:
    // application/problem+json, application/vnd.api+json, …
    const isJSON = mime === 'application/json' || mime.endsWith('+json');
    const status = cloned.status;

    // Read as text first: parse failures and empty bodies keep the status
    // instead of degrading into an opaque transport error.
    const text = await cloned.text();

    if (!cloned.ok) {
      // HTTP 4xx/5xx — surface as kind: 'http' with parsed (and, if a
      // schema is declared, validated) body. The HTTP status survives
      // every sub-case: an empty body, a malformed-JSON body (e.g. an
      // HTML 502 page mislabeled as JSON — `body` is then the raw text),
      // and an errorResponse-schema mismatch (status travels on the
      // validation error).
      let parsedBody: unknown;
      if (text.length === 0) {
        parsedBody = undefined;
      }
      else if (isJSON) {
        try {
          parsedBody = JSON.parse(text);
        }
        catch {
          return { ok: false, error: { kind: 'http', status, body: text as HttpErrorBody } };
        }
      }
      else {
        parsedBody = text;
      }

      // The errorResponse schema describes the JSON error contract; it is
      // not applied to non-JSON bodies (a gateway's HTML error page should
      // surface as kind 'http' with its status, not as a validation error).
      if (errorResponseSchema && isJSON && parsedBody !== undefined) {
        const r = await errorResponseSchema['~standard'].validate(parsedBody);
        if (r.issues) {
          return {
            ok: false,
            error: { kind: 'validation', location: 'response', issues: r.issues, status },
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

    // HTTP 2xx with an empty body — 204/205, HEAD, or a bodiless 200.
    // With no schema, data is undefined; with a schema, the schema decides
    // whether absence is acceptable (model it with optional()/default()).
    if (text.length === 0) {
      if (responseSchema) {
        const r = await responseSchema['~standard'].validate(undefined);
        if (r.issues) {
          return {
            ok: false,
            error: { kind: 'validation', location: 'response', issues: r.issues, status },
          };
        }
        return { ok: true, data: r.value as T };
      }
      return { ok: true, data: undefined as T };
    }

    if (isJSON) {
      let jsonBody: unknown;
      try {
        jsonBody = JSON.parse(text);
      }
      catch (cause) {
        // The server claimed JSON and sent something else — a broken
        // response contract, reported with the status it arrived under.
        return {
          ok: false,
          error: {
            kind: 'validation',
            location: 'response',
            status,
            issues: [{
              code: 'invalid_json',
              message: `Response claimed ${mime} but the body is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
            }],
          },
        };
      }

      if (responseSchema) {
        const r = await responseSchema['~standard'].validate(jsonBody);
        if (r.issues) {
          return {
            ok: false,
            error: { kind: 'validation', location: 'response', issues: r.issues, status },
          };
        }
        return { ok: true, data: r.value as T };
      }
      return { ok: true, data: jsonBody as T };
    }

    // Non-JSON 2xx. With a declared response schema, the text is validated
    // rather than silently bypassing the schema — a string() schema accepts
    // it; an object schema rejects with clear issues (and the status).
    if (responseSchema) {
      const r = await responseSchema['~standard'].validate(text);
      if (r.issues) {
        return {
          ok: false,
          error: { kind: 'validation', location: 'response', issues: r.issues, status },
        };
      }
      return { ok: true, data: r.value as T };
    }
    return { ok: true, data: text as T };
  }
  catch (cause) {
    return { ok: false, error: { kind: 'network', cause } };
  }
}

/**
 * Substitutes `{param}` placeholders in `path`. Runs whether or not a
 * `params` object was supplied — a path template with placeholders and no
 * params is a missing-parameter error, never a literal `{id}` sent to the
 * server. Any placeholder whose key is absent is pushed onto `missing`
 * (instead of throwing), so the caller can surface it as a precomputed
 * `kind: 'validation'` error and keep the never-throws contract.
 */
function interpolatePath(
  path: string,
  params: Record<string, string | number> | undefined,
  missing: string[],
): string {
  return path.replace(/\{([^}]+)\}/g, (_, key: string) => {
    const value = params?.[key];
    if (value === undefined) {
      missing.push(key);
      return '';
    }
    return encodeURIComponent(String(value));
  });
}

/**
 * Builds a deterministic cache key from the call arguments. The key format
 * is `[method, url, inputs?]` where `url` is the joined (uninterpolated)
 * request URL and `inputs` bundles whichever of `params` / `query` / `body`
 * were supplied — so clients forked onto different `baseUrl`s, or two
 * mutations with different bodies, never collide on one key. Compatible
 * with TanStack Query's array keys.
 */
function buildQueryKey(
  method: string,
  url: string,
  params?: Record<string, unknown>,
  query?: Record<string, unknown>,
  body?: unknown,
): ReadonlyArray<unknown> {
  const inputs: Record<string, unknown> = {};
  if (params && Object.keys(params).length > 0)
    inputs.params = params;
  if (query) {
    const filtered: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null)
        filtered[k] = v;
    }
    if (Object.keys(filtered).length > 0)
      inputs.query = filtered;
  }
  if (body !== undefined)
    inputs.body = body;
  return Object.keys(inputs).length > 0 ? [method, url, inputs] : [method, url];
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
 * - `kind: 'validation'`, request-side (`body`/`params`/`query`) → `400`
 *   (the caller sent bad input — a client bug, not a server error)
 * - `kind: 'validation'`, `location: 'response'` → the actual HTTP status
 *   when it was an error status, else `502` (the upstream broke its
 *   contract)
 * - `kind: 'timeout'` → `408`
 * - `kind: 'aborted'` → `499` (client closed request)
 * - `kind: 'network'` → `500`
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
  /** The full discriminated {@link FetcherError} that caused the throw. */
  readonly fetcherError: FetcherError<Body>;
  /** Derived HTTP status for framework error boundaries (see the class docs for the mapping). */
  readonly status: number;

  /** Builds the error from a {@link FetcherError}, deriving `message` and `status` from it. */
  constructor(error: FetcherError<Body>) {
    super(extractErrorMessage(error as FetcherError));
    this.name = 'FetcherRequestError';
    this.fetcherError = error;
    this.status = deriveStatus(error as FetcherError);
  }
}

/** Maps a FetcherError to the HTTP status a framework boundary should report. */
function deriveStatus(error: FetcherError): number {
  switch (error.kind) {
    case 'http':
      return error.status;
    case 'validation':
      if (error.location !== 'response')
        return 400;
      return error.status !== undefined && error.status >= 400 ? error.status : 502;
    case 'timeout':
      return 408;
    case 'aborted':
      return 499;
    case 'network':
      return 500;
  }
}

/**
 * Subclass of {@link FetcherRequestError} thrown when the underlying fetch
 * rejected with a transport failure (DNS failure, connection refused, TLS
 * error, etc.). `cause` holds the raw thrown value.
 *
 * ```ts
 * try { await api.get('/pets').unwrap(); }
 * catch (err) {
 *   if (err instanceof FetcherNetworkError) err.cause;
 * }
 * ```
 */
export class FetcherNetworkError extends FetcherRequestError {
  /** Builds the error from the raw value the underlying fetch rejected with. */
  constructor(cause: unknown) {
    super({ kind: 'network', cause });
    this.name = 'FetcherNetworkError';
  }

  /** The raw transport failure the underlying fetch rejected with. */
  override get cause(): unknown {
    const e = this.fetcherError;
    return e.kind === 'network' ? e.cause : undefined;
  }
}

/**
 * Subclass of {@link FetcherRequestError} thrown when the request was
 * aborted by a deadline — the `timeout()` middleware fired, or an abort
 * whose reason is a `TimeoutError` `DOMException`. `status` is `408`.
 */
export class FetcherTimeoutError extends FetcherRequestError {
  /** Builds the error from the abort reason — typically a `TimeoutError` `DOMException`. */
  constructor(cause: unknown) {
    super({ kind: 'timeout', cause });
    this.name = 'FetcherTimeoutError';
  }

  /** The abort reason that expired the deadline (typically a `TimeoutError` `DOMException`). */
  override get cause(): unknown {
    const e = this.fetcherError;
    return e.kind === 'timeout' ? e.cause : undefined;
  }
}

/**
 * Subclass of {@link FetcherRequestError} thrown when the caller cancelled
 * the request via its `AbortSignal`. `cause` holds the abort reason.
 * `status` is `499` (client closed request). Framework boundaries that see
 * this usually want to swallow it rather than render an error page.
 */
export class FetcherAbortError extends FetcherRequestError {
  /** Builds the error from the caller's abort reason (`signal.reason`). */
  constructor(cause: unknown) {
    super({ kind: 'aborted', cause });
    this.name = 'FetcherAbortError';
  }

  /** The caller's abort reason (`signal.reason`). */
  override get cause(): unknown {
    const e = this.fetcherError;
    return e.kind === 'aborted' ? e.cause : undefined;
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
  /** Builds the error from the failing slot, its issue list, and (for response-side failures) the HTTP status. */
  constructor(location: FetcherErrorLocation, issues: ReadonlyArray<StandardSchemaV1Issue>, status?: number) {
    super({ kind: 'validation', location, issues, status });
    this.name = 'FetcherValidationError';
  }

  /** Which slot failed validation: `'body'`, `'params'`, `'query'`, or `'response'`. */
  get location(): FetcherErrorLocation {
    const e = this.fetcherError;
    // Narrowed at runtime — subclass is only constructed with kind: 'validation'.
    return (e as Extract<FetcherError, { kind: 'validation' }>).location;
  }

  /** The raw Standard Schema V1 issue list describing what failed. */
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
  /** Builds the error from the HTTP status and the parsed error body. */
  constructor(status: number, body: Body) {
    super({ kind: 'http', status, body });
    this.name = 'FetcherHTTPError';
  }

  /** The parsed (and, with a declared `errorResponse` schema, validated) error body. */
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
    case 'timeout':
      return new FetcherTimeoutError(error.cause);
    case 'aborted':
      return new FetcherAbortError(error.cause);
    case 'validation':
      return new FetcherValidationError(error.location, error.issues, error.status);
    case 'http':
      return new FetcherHTTPError(error.status, error.body);
  }
}

/**
 * Extracts a human-readable error message from a {@link FetcherError}.
 * Handles every error kind so consumers don't need to write their own
 * switch/case boilerplate.
 *
 * - `'network'` — returns `cause.message` if `cause` is an `Error`, otherwise `String(cause)`
 * - `'timeout'` / `'aborted'` — a short description including the cause when informative
 * - `'validation'` — joins all issue messages with `, `, each prefixed with
 *   its field path (e.g. `user.email: Invalid email`) when the issue has one
 * - `'http'` — looks for `body.error.message` or `body.message` (common API patterns), falls back to `HTTP {status}`
 */
export function extractErrorMessage(error: FetcherError): string {
  switch (error.kind) {
    case 'network':
      return error.cause instanceof Error ? error.cause.message : String(error.cause);
    case 'timeout':
      return error.cause instanceof Error ? error.cause.message : 'Request timed out';
    case 'aborted':
      return error.cause instanceof Error ? error.cause.message : 'Request aborted';
    case 'validation':
      return error.issues
        .map((i) => {
          const path = i.path
            ?.map(seg => typeof seg === 'object' && seg !== null ? String(seg.key) : String(seg))
            .join('.');
          return path ? `${path}: ${i.message}` : i.message;
        })
        .join(', ');
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
