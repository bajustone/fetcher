/**
 * `@bajustone/fetcher` — schema-validated, typed fetch client.
 *
 * Wraps the native `fetch` API and extends the returned `Response` with a
 * typed `.result()` method that validates the body against a schema and
 * returns a discriminated union `{ ok: true; data } | { ok: false; error }`.
 *
 * Works with any schema library that implements the
 * [Standard Schema V1](https://standardschema.dev) spec — Zod 3.24+,
 * Valibot, ArkType, the bundled schema builder, or any value with a
 * `~standard.validate` property.
 *
 * ## Subpaths
 *
 * - `@bajustone/fetcher` (this entry) — `createFetch`, middleware, types,
 *   `inline()`, `fromJSONSchema()`.
 * - `@bajustone/fetcher/schema` — native schema builder (`object`, `string`,
 *   `integer`, `optional`, `ref`, `compile`, formats, etc.). Tree-shakeable
 *   per factory.
 * - `@bajustone/fetcher/openapi` — `fromOpenAPI`, `extractRouteSchemas`,
 *   `extractComponentSchemas`, `bundleComponent`, `translateDialect`,
 *   `JSONSchemaDefinition`.
 * - `@bajustone/fetcher/spec-tools` — `coverage`, `lintSpec`.
 * - `@bajustone/fetcher/vite` — Rollup/Vite plugin.
 *
 * @example Manual route schemas (any Standard Schema V1 validator)
 * ```typescript
 * import { createFetch } from '@bajustone/fetcher';
 * import { object, string } from '@bajustone/fetcher/schema';
 *
 * const f = createFetch({
 *   baseUrl: 'https://api.example.com',
 *   routes: {
 *     '/auth/login': {
 *       POST: {
 *         body: object({ email: string(), password: string() }),
 *         response: object({ token: string() }),
 *       },
 *     },
 *   },
 * });
 * ```
 *
 * @module
 */

export {
  createFetch,
  extractErrorMessage,
  FetcherHTTPError,
  FetcherNetworkError,
  FetcherRequestError,
  FetcherValidationError,
} from './fetcher.ts';
export type { JSONSchemaToType } from './infer-spec.ts';
export { authBearer, bearerWithRefresh, retry, timeout } from './middleware.ts';

export type { BearerWithRefreshOptions } from './middleware.ts';
export type {
  AvailableMethods,
  AvailablePaths,
  ExtractPathParams,
  FetchConfig,
  FetcherError,
  FetcherErrorLocation,
  FetchFn,
  FilterKeys,
  HttpMethod,
  InferOutput,
  InferRoutesFromSpec,
  InferSchema,
  IsTypedCall,
  MediaType,
  MethodShortcutFn,
  Middleware,
  OpenAPIErrorStatus,
  OpenAPILowercaseMethod,
  OpenAPIPaths,
  OpenAPISuccessStatus,
  PathsToRoutes,
  QueryDescriptor,
  ResolveBodyFor,
  ResolveBodyFromPaths,
  ResolveErrorResponseFor,
  ResolveErrorResponseFromPaths,
  ResolveParamsFor,
  ResolveParamsFromPaths,
  ResolveQueryFor,
  ResolveQueryFromPaths,
  ResolveResponseFor,
  ResolveResponseFromPaths,
  ResultData,
  RetryOptions,
  RouteDefinition,
  Routes,
  Schema,
  SchemaOf,
  StandardSchemaV1,
  StandardSchemaV1Issue,
  StandardSchemaV1PathSegment,
  StandardSchemaV1Result,
  TypedFetchFn,
  TypedFetchPromise,
  TypedResponse,
} from './types.ts';

export { withInputType } from './with-input-type.ts';
