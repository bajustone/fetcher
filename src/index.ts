/**
 * @bajustone/fetcher — schema-validated, typed fetch client with OpenAPI support.
 *
 * Wraps the native `fetch` API and extends the returned `Response` with a
 * typed `.result()` method that validates the body against a schema and
 * returns a discriminated union `{ data } | { error }`.
 *
 * Works with any schema library that exposes a `.parse(data): T` method
 * (Zod, Valibot, ArkType, or a custom validator), and ships with an OpenAPI
 * 3.x adapter that builds typed routes from a spec with zero runtime deps.
 *
 * @example Quick start with manual route schemas
 * ```typescript
 * import { createFetch } from '@bajustone/fetcher';
 * import { z } from 'zod';
 *
 * const f = createFetch({
 *   baseUrl: 'https://api.example.com',
 *   routes: {
 *     '/auth/login': {
 *       POST: {
 *         body: z.object({ email: z.string(), password: z.string() }),
 *         response: z.object({ token: z.string() }),
 *       },
 *     },
 *   },
 * });
 *
 * const res = await f('/auth/login', {
 *   method: 'POST',
 *   body: { email: 'a@b.com', password: 'secret' },
 * });
 * const { data, error } = await res.result();
 * ```
 *
 * @example From an OpenAPI spec
 * ```typescript
 * import { createFetch, fromOpenAPI } from '@bajustone/fetcher';
 * import spec from './openapi.json';
 *
 * const f = createFetch({
 *   baseUrl: 'https://api.example.com',
 *   routes: fromOpenAPI(spec),
 * });
 * ```
 *
 * @module
 */

export { createFetch } from './fetcher.ts';
export { JSONSchemaValidator, ValidationError } from './json-schema-validator.ts';
export type { JSONSchemaDefinition } from './json-schema-validator.ts';
export { authBearer } from './middleware.ts';

export { fromOpenAPI } from './openapi.ts';

export type {
  ExtractPathParams,
  FetchConfig,
  FetchFn,
  HttpMethod,
  InferSchema,
  Middleware,
  ResultData,
  RouteDefinition,
  Routes,
  Schema,
  TypedFetchFn,
  TypedResponse,
} from './types.ts';
