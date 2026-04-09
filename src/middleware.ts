/**
 * Built-in middleware helpers and the middleware chain executor used
 * internally by {@link createFetch}.
 *
 * @module
 */

import type { Middleware } from './types.ts';

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
    return next();
  };
}

/**
 * Runs a middleware chain around a final fetch call. Each middleware in
 * `middlewares` is invoked in order; calling `next()` inside a middleware
 * advances to the next one, and the terminal `next()` invokes `finalFetch`.
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
  let index = 0;

  function next(): Promise<Response> {
    if (index < middlewares.length) {
      const mw = middlewares[index]!;
      index++;
      return mw(request, next);
    }
    return finalFetch(request);
  }

  return next();
}
