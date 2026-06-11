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
 * - `@bajustone/fetcher` (this entry) — `createFetch`, middleware, error
 *   classes, types.
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
  FetcherAbortError,
  FetcherHTTPError,
  FetcherNetworkError,
  FetcherRequestError,
  FetcherTimeoutError,
  FetcherValidationError,
} from './fetcher.ts';
export type { JSONSchemaToType } from './infer-spec.ts';
export { authBearer, bearerWithRefresh, cookieAuth, parseSetCookie, retry, timeout } from './middleware.ts';

export type { BearerWithRefreshOptions, CookieAuthOptions, ExcludeMatcher } from './middleware.ts';
// NOTE (v1.0 surface): the OAS type-plumbing helpers that used to be
// re-exported here (FilterKeys, MediaType, the Resolve*For/Resolve*FromPaths
// family, IsTypedCall, AvailablePaths/Methods, OpenAPI*Status, OpenAPIPaths)
// are internal wiring and are no longer part of the public contract. Import
// what you need for wrapper typing from the documented set below.
export type {
  ExtractPathParams,
  FetchConfig,
  FetcherError,
  FetcherErrorLocation,
  FetchFn,
  HttpMethod,
  InferOutput,
  InferRoutesFromSpec,
  InferSchema,
  MethodShortcutFn,
  Middleware,
  PathsToRoutes,
  QueryDescriptor,
  QuerySerializer,
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
