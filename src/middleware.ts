import type { Middleware } from "./types.ts";

/**
 * Attaches a Bearer token to the Authorization header.
 * The `getToken` function is called on every request, so it can return
 * a fresh token each time (e.g., from a token store or refresh flow).
 */
export function authBearer(
  getToken: () => string | null | undefined | Promise<string | null | undefined>,
): Middleware {
  return async (request, next) => {
    const token = await getToken();
    if (token) {
      request.headers.set("Authorization", `Bearer ${token}`);
    }
    return next();
  };
}

/** Executes a middleware chain, ending with the actual fetch call */
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
