/**
 * Core fetch factory — returns a typed `fetch`-shaped function that validates
 * requests/responses against a `Routes` table and extends each `Response`
 * with a `.result()` method.
 *
 * @module
 */

import type {
  FetchConfig,
  FetchFn,
  ResultData,
  RouteDefinition,
  Routes,
  Schema,
  TypedFetchFn,
  TypedResponse,
} from './types.ts';
import { executeMiddleware } from './middleware.ts';

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
  } = config;

  const fetchFn = (path: string, options: Record<string, unknown> = {}): Promise<TypedResponse> => {
    const {
      method = 'GET',
      body,
      params,
      query,
      fetch: callFetchFn,
      responseSchema: adHocResponseSchema,
      headers: callHeaders,
      ...restInit
    } = options;

    // Resolve the route definition (if routes defined)
    const methodMap = routes?.[path] as
      | Partial<Record<string, RouteDefinition>>
      | undefined;
    const routeDef = methodMap?.[method as string];

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

    // Serialize body
    let serializedBody: string | FormData | Blob | ArrayBuffer | URLSearchParams | undefined;
    if (body !== undefined && body !== null) {
      // Validate body against schema if available
      if (routeDef?.body) {
        routeDef.body.parse(body);
      }

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

    // Determine the response schema
    const responseSchema: Schema | undefined
      = (adHocResponseSchema as Schema | undefined) ?? routeDef?.response;

    const errorResponseSchema: Schema | undefined = routeDef?.errorResponse;

    // Pick the fetch implementation
    const actualFetch: FetchFn
      = (callFetchFn as FetchFn | undefined)
        ?? defaultFetchFn
        ?? (req => globalThis.fetch(req));

    // Execute through middleware chain
    const responsePromise = executeMiddleware(
      middleware,
      request,
      req => actualFetch(req),
    );

    // Wrap the response with .result()
    return responsePromise.then(response =>
      wrapResponse(response, responseSchema, errorResponseSchema),
    );
  };

  return fetchFn as unknown as TypedFetchFn<R>;
}

function wrapResponse<T, E>(
  response: Response,
  responseSchema?: Schema<T>,
  errorResponseSchema?: Schema<E>,
): TypedResponse<T, E> {
  const typedResponse = response as TypedResponse<T, E>;

  // Clone the response so .result() can read the body independently of
  // native methods like .json() or .text()
  const cloned = response.clone();

  typedResponse.result = async (): Promise<ResultData<T, E>> => {
    try {
      const contentType = cloned.headers.get('content-type') ?? '';
      const isJSON = contentType.includes('application/json');

      if (!cloned.ok) {
        if (isJSON) {
          const errorBody = await cloned.json();
          const validatedError = errorResponseSchema
            ? errorResponseSchema.parse(errorBody)
            : errorBody;
          return { error: validatedError as E };
        }
        const text = await cloned.text();
        return { error: text as E };
      }

      if (isJSON) {
        const jsonBody = await cloned.json();
        const validatedData = responseSchema
          ? responseSchema.parse(jsonBody)
          : jsonBody;
        return { data: validatedData as T };
      }

      const textBody = await cloned.text();
      return { data: textBody as T };
    }
    catch (err) {
      return {
        error: (err instanceof Error ? err : new Error(String(err))) as E,
      };
    }
  };

  return typedResponse;
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
