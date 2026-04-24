/**
 * Built-in middleware helpers and the middleware chain executor used
 * internally by {@link createFetch}.
 *
 * Ships these first-party middlewares:
 * - {@link authBearer} — attaches `Authorization: Bearer <token>`
 * - {@link bearerWithRefresh} — bearer auth with 401-driven token refresh
 * - {@link cookieAuth} — `Cookie` header auth with login/refresh dance
 * - {@link timeout} — aborts a single request after `ms` milliseconds
 * - {@link retry} — re-invokes the rest of the chain on retryable failures
 *
 * Plus utilities:
 * - {@link parseSetCookie} — extract `name=value` pairs from `Set-Cookie`
 *   headers into a ready-to-send `Cookie` header string
 *
 * @module
 */

import type { Middleware, RetryOptions } from './types.ts';

const DEFAULT_RETRY_STATUSES: readonly number[] = [408, 425, 429, 500, 502, 503, 504];

/**
 * Generic exclude-matcher accepted by auth middlewares
 * ({@link bearerWithRefresh}, {@link cookieAuth}). Identifies request URLs
 * that should bypass the auth/refresh logic — typically login, logout, and
 * refresh endpoints.
 *
 * - `string`: exact pathname match
 * - `string[]`: any of the listed pathnames
 * - `RegExp`: tested against `request.url`
 * - `(req) => boolean`: arbitrary predicate
 */
type ExcludeMatcher<Paths = Record<string, unknown>>
  = | (keyof Paths & string)
    | Array<keyof Paths & string>
    | RegExp
    | ((request: Request) => boolean);

function matchesExclude(request: Request, matcher: ExcludeMatcher): boolean {
  if (typeof matcher === 'function')
    return matcher(request);
  if (matcher instanceof RegExp)
    return matcher.test(request.url);
  if (Array.isArray(matcher))
    return matcher.some(m => matchPathname(request, m));
  return matchPathname(request, matcher);
}

function matchPathname(request: Request, pathname: string): boolean {
  try {
    return new URL(request.url).pathname === pathname;
  }
  catch {
    return request.url.endsWith(pathname);
  }
}

/**
 * Builds a middleware that attaches an `Authorization: Bearer <token>`
 * header on every outgoing request. `getToken` is invoked per-request, so
 * it can return a fresh token each time (e.g. from a token store or a
 * refresh flow) and may be async.
 *
 * @example
 * ```typescript
 * import { authBearer, createFetch } from '@bajustone/fetcher';
 *
 * const f = createFetch({
 *   baseUrl: 'https://api.example.com',
 *   middleware: [authBearer(() => localStorage.getItem('token'))],
 * });
 * ```
 */
export function authBearer(
  getToken: () => string | null | undefined | Promise<string | null | undefined>,
): Middleware {
  return async (request, next) => {
    const token = await getToken();
    if (token) {
      request.headers.set('Authorization', `Bearer ${token}`);
    }
    return next(request);
  };
}

/**
 * Configuration for {@link bearerWithRefresh}.
 */
export interface BearerWithRefreshOptions<Paths = Record<string, unknown>> {
  /**
   * Returns the current access token (or `null` if none is cached). Called
   * before every outgoing request. May be sync or async.
   */
  getToken: () => string | null | undefined | Promise<string | null | undefined>;
  /**
   * Called when the server returns 401. Should obtain and store a fresh
   * access token, then resolve with it. Concurrent 401s share a single
   * in-flight refresh — `refresh` will not be called more than once at a
   * time, so naive implementations are safe.
   *
   * **On rejection** (e.g. expired refresh token → user must log in
   * again): the rejection propagates out of the middleware, the in-flight
   * 401 response is discarded, and the call surfaces via `.result()` as
   * `{ ok: false, error: { kind: 'network', cause: <the rejection> } }`.
   * It does NOT surface as `{ kind: 'http', status: 401 }` — the 401 has
   * been "consumed" by the refresh attempt. Consumers handling
   * "session expired" should check for `kind: 'network'` and inspect
   * `cause`, typically by re-throwing into the app's auth-state machine.
   */
  refresh: () => Promise<string>;
  /**
   * Endpoints that should skip bearer auth entirely — no `Authorization`
   * header, no 401-refresh logic. Typically the login, logout, and refresh
   * endpoints.
   *
   * - `string`: exact pathname match
   * - `string[]`: any of the listed pathnames
   * - `RegExp`: tested against `request.url`
   * - `(req) => boolean`: arbitrary predicate
   *
   * Supersedes the deprecated {@link refreshEndpoint} when both are supplied.
   */
  exclude?:
    | (keyof Paths & string)
    | Array<keyof Paths & string>
    | RegExp
    | ((request: Request) => boolean);
  /**
   * @deprecated Use {@link exclude} instead. Kept for backwards compatibility.
   * When both `exclude` and `refreshEndpoint` are supplied, `exclude` wins.
   */
  refreshEndpoint?:
    | string
    | string[]
    | RegExp
    | ((request: Request) => boolean);
}

/**
 * First-party middleware that handles the full token-refresh dance:
 *
 * 1. Attaches `Authorization: Bearer <token>` to every outgoing request
 *    using {@link BearerWithRefreshOptions.getToken}.
 * 2. On a 401 response, calls {@link BearerWithRefreshOptions.refresh}
 *    to obtain a fresh token, then re-runs the rest of the chain (and
 *    the underlying fetch) with the new `Authorization` header. Stream
 *    bodies survive this — the request is `clone()`'d before each attempt.
 * 3. Concurrent 401s across multiple in-flight requests share a single
 *    in-flight refresh promise, so `refresh` is never called more than
 *    once at a time even under concurrent load.
 * 4. Recognizes the refresh endpoint itself (via
 *    {@link BearerWithRefreshOptions.refreshEndpoint}) and skips the
 *    401-handling logic for that one path — without this exclusion the
 *    refresh endpoint would deadlock on its own failure.
 *
 * Depends on the §4.A5 recursive middleware contract: `next(request)` is
 * called more than once on a single invocation, and each call re-runs
 * every downstream middleware (which the previous closure-based dispatcher
 * could not support).
 *
 * @example
 * ```typescript
 * const f = createFetch({
 *   baseUrl: 'https://api.example.com',
 *   middleware: [
 *     bearerWithRefresh({
 *       getToken: () => sessionStorage.getItem('access_token'),
 *       refresh: async () => {
 *         const r = await fetch('/auth/refresh', { method: 'POST' });
 *         const { access_token } = await r.json();
 *         sessionStorage.setItem('access_token', access_token);
 *         return access_token;
 *       },
 *       refreshEndpoint: '/auth/refresh',
 *     }),
 *   ],
 * });
 * ```
 */
export function bearerWithRefresh<Paths = Record<string, unknown>>(opts: BearerWithRefreshOptions<Paths>): Middleware {
  const { getToken, refresh, exclude, refreshEndpoint } = opts;

  // Shared in-flight refresh promise. Concurrent 401s await this same
  // promise so only one refresh runs at a time. Cleared when refresh
  // settles (resolved or rejected).
  let inFlight: Promise<string> | null = null;
  const sharedRefresh = (): Promise<string> => {
    if (!inFlight) {
      inFlight = refresh().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  };

  return async (request, next) => {
    // Skip auth entirely for excluded endpoints (login, logout, refresh,
    // etc.). `exclude` supersedes the deprecated `refreshEndpoint`.
    const matcher = exclude ?? refreshEndpoint;
    if (matcher && matchesExclude(request, matcher))
      return next(request);

    // First attempt: attach the current token (if any).
    const initialToken = await getToken();
    const firstAttempt = request.clone();
    if (initialToken)
      firstAttempt.headers.set('Authorization', `Bearer ${initialToken}`);
    const response = await next(firstAttempt);

    // Not a 401? Done.
    if (response.status !== 401)
      return response;

    // 401 — refresh and retry exactly once. Concurrent 401s share the
    // same in-flight refresh promise.
    const newToken = await sharedRefresh();
    const retryAttempt = request.clone();
    retryAttempt.headers.set('Authorization', `Bearer ${newToken}`);
    return next(retryAttempt);
  };
}

/**
 * Configuration for {@link cookieAuth}.
 */
export interface CookieAuthOptions<Paths = Record<string, unknown>> {
  /**
   * Performs the login request and returns the new `Cookie` header value
   * (e.g. `"sid=abc; csrf=xyz"`). Called lazily on the first authenticated
   * request, again proactively when {@link refreshAfterMs} elapses, and
   * reactively whenever the server returns 401.
   *
   * Concurrent invocations are deduplicated — under load `login` is never
   * called more than once at a time, so naive implementations are safe.
   * Returning an empty string suppresses the `Cookie` header for that
   * window.
   *
   * **On rejection** (e.g. credentials no longer valid): the rejection
   * propagates out of the middleware. If the rejection happened while
   * refreshing in response to a 401, the call surfaces via `.result()` as
   * `{ ok: false, error: { kind: 'network', cause: <the rejection> } }`
   * — the 401 has been consumed by the refresh attempt. Consumers handling
   * "session expired" should check for `kind: 'network'` and inspect
   * `cause`.
   */
  login: () => Promise<string>;
  /**
   * Optional proactive refresh window. When set, requests issued more
   * than `refreshAfterMs` milliseconds after the last successful `login`
   * trigger a fresh `login` call before they're sent — independent of
   * any 401 response. Reactive 401-driven refresh remains active in any
   * case (servers can invalidate sessions early; clock skew is real),
   * so this is a complement, not a replacement.
   *
   * Omit for purely reactive (401-only) behavior.
   */
  refreshAfterMs?: number;
  /**
   * Endpoints that should skip cookie auth entirely — no `Cookie` header,
   * no 401-refresh logic. **The login endpoint itself MUST be excluded**
   * or you'll get an infinite loop the first time `login` returns 401.
   * Logout endpoints are typically excluded too.
   */
  exclude?: ExcludeMatcher<Paths>;
}

/**
 * Cookie-based session auth with login/refresh handling, intended for
 * server-side runtimes (Node, Deno, Bun, edge workers) that drive cookie
 * state manually. In a browser you would just set
 * `credentials: 'include'` and let the browser manage cookies — this
 * middleware exists for the runtimes where that's not on the table.
 *
 * Behaviour:
 *
 * 1. **Lazy initial login.** No `login` call is made at construction —
 *    the first non-excluded request triggers it, after which the
 *    resulting `Cookie` header value is cached in closure state.
 * 2. **Proactive refresh** (`refreshAfterMs`). Before each request, if
 *    `now - lastLoginAt >= refreshAfterMs`, a fresh `login` runs first.
 *    Predictable, no 401 churn from session expiry.
 * 3. **Reactive refresh.** A 401 response from the server triggers
 *    `login` and one retry of the same request. Active even when
 *    `refreshAfterMs` is set — the server can revoke a session at any
 *    time and we should recover transparently.
 * 4. **Single in-flight.** Concurrent requests that all need a fresh
 *    cookie share one `login` promise. Even under heavy load, `login`
 *    is never called more than once at a time.
 * 5. **Body cloning.** The request is `clone()`'d before each attempt,
 *    so stream bodies survive the retry.
 * 6. **Exclude.** Endpoints matched by {@link CookieAuthOptions.exclude}
 *    bypass everything — no header attached, no 401 handling. The login
 *    endpoint itself must be excluded or the middleware will deadlock
 *    on its own failure.
 *
 * The `login` function is user-supplied; it typically posts credentials,
 * parses the `Set-Cookie` headers via {@link parseSetCookie}, and
 * returns the resulting `Cookie` header value.
 *
 * @example
 * ```typescript
 * import { cookieAuth, createFetch, parseSetCookie } from '@bajustone/fetcher';
 *
 * const f = createFetch({
 *   baseUrl: 'https://api.example.com',
 *   middleware: [
 *     cookieAuth({
 *       login: async () => {
 *         const r = await fetch('https://api.example.com/auth/login', {
 *           method: 'POST',
 *           headers: { 'content-type': 'application/json' },
 *           body: JSON.stringify({ user: USER, pass: PASS }),
 *         });
 *         if (!r.ok) throw new Error(`login failed: ${r.status}`);
 *         return parseSetCookie(r.headers);
 *       },
 *       refreshAfterMs: 25 * 60_000, // proactive: re-login every 25 min
 *       exclude: ['/auth/login', '/auth/logout'],
 *     }),
 *   ],
 * });
 * ```
 */
export function cookieAuth<Paths = Record<string, unknown>>(opts: CookieAuthOptions<Paths>): Middleware {
  const { login, refreshAfterMs, exclude } = opts;

  // Closure state: current Cookie header value, when we last logged in,
  // and the in-flight login promise (for concurrent dedup).
  let cookie: string | null = null;
  let lastLoginAt = 0;
  let inFlight: Promise<string> | null = null;

  const sharedLogin = (): Promise<string> => {
    if (!inFlight) {
      inFlight = login()
        .then((c) => {
          cookie = c;
          lastLoginAt = Date.now();
          return c;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  };

  return async (request, next) => {
    if (exclude && matchesExclude(request, exclude as ExcludeMatcher))
      return next(request);

    // Lazy initial login, or proactive expiry-based refresh. Both gate
    // on the same `sharedLogin` so concurrent requests dedupe.
    const expired = refreshAfterMs !== undefined
      && lastLoginAt > 0
      && Date.now() - lastLoginAt >= refreshAfterMs;
    if (cookie === null || expired)
      await sharedLogin();

    const firstAttempt = request.clone();
    if (cookie)
      firstAttempt.headers.set('Cookie', cookie);
    const response = await next(firstAttempt);

    // Not a 401? Done.
    if (response.status !== 401)
      return response;

    // 401 — re-login and retry exactly once. Concurrent 401s share the
    // same in-flight login promise.
    await sharedLogin();
    const retryAttempt = request.clone();
    if (cookie)
      retryAttempt.headers.set('Cookie', cookie);
    return next(retryAttempt);
  };
}

/**
 * Extracts cookie `name=value` pairs from one or more `Set-Cookie` header
 * values and returns a string ready to use as a `Cookie` request header.
 * Attributes (`Path`, `Domain`, `Expires`, `Max-Age`, `HttpOnly`,
 * `Secure`, `SameSite`, …) are stripped — only the leading `name=value`
 * is retained. Duplicate names follow last-write-wins.
 *
 * Accepts:
 * - `Headers`: pulls every `Set-Cookie` via `Headers.getSetCookie()` if
 *   available (Node ≥ 19.7, undici, modern browsers), otherwise falls
 *   back to the joined `get('set-cookie')` value (which can be
 *   ambiguous if cookie attributes contain commas — pass `string[]` if
 *   you need disambiguation).
 * - `string[]`: array of individual `Set-Cookie` header values, exactly
 *   as the server sent them.
 * - `string`: a single `Set-Cookie` header value.
 *
 * Empty / missing input returns `""`.
 *
 * @example
 * ```typescript
 * const r = await fetch('/login', { method: 'POST', body });
 * const cookie = parseSetCookie(r.headers);
 * // → "sid=abc123; csrf=xyz"
 * ```
 */
export function parseSetCookie(input: Headers | readonly string[] | string | null | undefined): string {
  if (input == null)
    return '';

  let raw: readonly string[];
  if (typeof input === 'string') {
    raw = input ? [input] : [];
  }
  else if (Array.isArray(input)) {
    raw = input;
  }
  else if (typeof Headers !== 'undefined' && input instanceof Headers) {
    const h = input as Headers & { getSetCookie?: () => string[] };
    if (typeof h.getSetCookie === 'function') {
      raw = h.getSetCookie();
    }
    else {
      const single = input.get('set-cookie');
      raw = single ? [single] : [];
    }
  }
  else {
    raw = [];
  }

  // Map preserves insertion order; later writes overwrite earlier
  // (last-write-wins for duplicate names within a single response).
  const cookies = new Map<string, string>();
  for (const entry of raw) {
    if (!entry)
      continue;
    // First segment before `;` is `name=value`; rest are attributes.
    const semicolonIdx = entry.indexOf(';');
    const pair = (semicolonIdx === -1 ? entry : entry.slice(0, semicolonIdx)).trim();
    if (!pair)
      continue;
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1)
      continue;
    const name = pair.slice(0, eqIdx).trim();
    if (!name)
      continue;
    const value = pair.slice(eqIdx + 1).trim();
    cookies.set(name, value);
  }

  return Array.from(cookies, ([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * Middleware that aborts a single downstream request after `ms`
 * milliseconds. The timeout signal is merged with any user-supplied
 * `request.signal` via `AbortSignal.any([...])`, so explicit user
 * cancellation continues to work alongside the timeout.
 *
 * On timeout the underlying fetch rejects with `AbortError`, which
 * `.result()` surfaces as `{ ok: false, error: { kind: 'network', cause } }`.
 *
 * Usually configured via `FetchConfig.timeout` (or per-call `timeout`)
 * rather than added to `middleware: [...]` by hand — `createFetch`
 * auto-prepends a `timeout(ms)` to the chain when those options are set.
 *
 * @example
 * ```typescript
 * const f = createFetch({ baseUrl: '...', timeout: 5_000 });
 * ```
 */
export function timeout(ms: number): Middleware {
  return async (request, next) => {
    const timeoutSignal = AbortSignal.timeout(ms);
    const merged = AbortSignal.any([request.signal, timeoutSignal]);
    return next(new Request(request, { signal: merged }));
  };
}

/**
 * Middleware that re-invokes the rest of the chain on retryable failures.
 * "Retryable" means either:
 *
 * - the underlying fetch rejected (network error), unless the rejection
 *   was caused by the user's `request.signal` aborting; or
 * - the response's status is in `retryOn` (default: 408, 425, 429, 5xx).
 *
 * Between attempts, the request body is re-cloned via `request.clone()`
 * so stream bodies remain consumable. Backoff is exponential with ±25%
 * jitter; if the server returned a `Retry-After` header, that delay is
 * honored instead.
 *
 * Pass a number as shorthand for `{ attempts: n }`.
 *
 * Usually configured via `FetchConfig.retry` (or per-call `retry`) rather
 * than added to `middleware: [...]` by hand — `createFetch` auto-prepends
 * `retry()` outside any `timeout()` so each attempt gets a fresh timeout.
 *
 * @example
 * ```typescript
 * const f = createFetch({ baseUrl: '...', retry: 3, timeout: 5_000 });
 * ```
 */
export function retry(opts: number | RetryOptions = 3): Middleware {
  const cfg: Required<RetryOptions> = {
    attempts: typeof opts === 'number' ? opts : (opts.attempts ?? 3),
    backoff: typeof opts === 'number' ? 100 : (opts.backoff ?? 100),
    factor: typeof opts === 'number' ? 2 : (opts.factor ?? 2),
    maxBackoff: typeof opts === 'number' ? 30_000 : (opts.maxBackoff ?? 30_000),
    retryOn: typeof opts === 'number' ? DEFAULT_RETRY_STATUSES : (opts.retryOn ?? DEFAULT_RETRY_STATUSES),
  };

  return async (request, next) => {
    let lastError: unknown;

    for (let attempt = 1; attempt <= cfg.attempts; attempt++) {
      // Clone before each attempt so a stream body remains readable.
      const attemptReq = request.clone();

      let response: Response | undefined;
      try {
        response = await next(attemptReq);
      }
      catch (err) {
        // User-initiated cancellation: never retry.
        if (request.signal.aborted)
          throw err;
        // Last attempt: surface the rejection.
        if (attempt === cfg.attempts)
          throw err;
        lastError = err;
        await sleep(computeBackoff(attempt, cfg), request.signal);
        continue;
      }

      // Successful return — check whether the status is retryable.
      if (!cfg.retryOn.includes(response.status) || attempt === cfg.attempts) {
        return response;
      }

      // Honor Retry-After if present, otherwise exponential backoff.
      const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
      const delay = retryAfter ?? computeBackoff(attempt, cfg);
      await sleep(delay, request.signal);
    }

    // Unreachable in normal flow (the loop always returns or throws),
    // but kept for type safety.
    throw lastError ?? new Error('retry: exhausted attempts');
  };
}

function computeBackoff(attempt: number, cfg: Required<RetryOptions>): number {
  const base = cfg.backoff * cfg.factor ** (attempt - 1);
  const capped = Math.min(base, cfg.maxBackoff);
  // ±25% jitter
  const jitter = capped * 0.25 * (Math.random() * 2 - 1);
  return Math.max(0, capped + jitter);
}

function parseRetryAfter(value: string | null): number | null {
  if (!value)
    return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds))
    return seconds * 1000;
  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    const delta = date - Date.now();
    return delta > 0 ? delta : 0;
  }
  return null;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(toError(signal.reason));
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(toError(signal.reason));
    };
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Runs a middleware chain around a final fetch call. Implemented as a
 * **recursive dispatcher** — each call to `next` re-enters the chain at
 * `i + 1`, which means a middleware that calls `next` more than once
 * (e.g. a retry middleware) re-runs every downstream middleware AND the
 * final fetch on each attempt. The previous closure-with-shared-index
 * implementation could not support replay.
 *
 * `next` accepts an optional `Request`; when omitted, the request the
 * middleware was given is forwarded unchanged. This is what lets retry
 * middleware swap in a fresh `request.clone()` between attempts.
 *
 * Exported for advanced use (e.g. composing custom clients); the typical
 * consumer should configure middlewares via `createFetch({ middleware })`.
 *
 * @internal
 */
export function executeMiddleware(
  middlewares: Middleware[],
  request: Request,
  finalFetch: (request: Request) => Promise<Response>,
): Promise<Response> {
  function dispatch(i: number, req: Request): Promise<Response> {
    if (i >= middlewares.length)
      return finalFetch(req);
    const mw = middlewares[i]!;
    return mw(req, (nextReq: Request = req) => dispatch(i + 1, nextReq));
  }

  return dispatch(0, request);
}
