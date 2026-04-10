/**
 * @bajustone/fetcher — schema-validated, typed fetch client with OpenAPI support.
 *
 * Wraps the native `fetch` API and extends the returned `Response` with a
 * typed `.result()` method that validates the body against a schema and
 * returns a discriminated union `{ ok: true; data } | { ok: false; error }`.
 *
 * Works with any schema library that implements the
 * [Standard Schema V1](https://standardschema.dev) spec — Zod 3.24+,
 * Valibot, ArkType, the bundled `JSONSchemaValidator`, or any value with a
 * `~standard.validate` property — and ships with an OpenAPI 3.x adapter
 * that builds typed routes from a spec with zero runtime deps.
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
 * const res = await f.post('/auth/login', {
 *   body: { email: 'a@b.com', password: 'secret' },
 * });
 * const result = await res.result();
 * if (result.ok) {
 *   result.data.token; // typed
 * } else {
 *   // result.error: FetcherError — { kind: 'network' | 'validation' | 'http', ... }
 * }
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
 *
 * f('/pets/{petId}', { method: 'GET', params: { petId: '42' } });
 * //  ^ autocompletes from spec               ^ inferred from path template
 * ```
 *
 * @module
 */

export { createFetch } from './fetcher.ts';
export { JSONSchemaValidator, ValidationError } from './json-schema-validator.ts';
export type { JSONSchemaDefinition } from './json-schema-validator.ts';
export { authBearer, bearerWithRefresh, retry, timeout } from './middleware.ts';
export type { BearerWithRefreshOptions } from './middleware.ts';

export { fromOpenAPI } from './openapi.ts';

export { coverage, lintSpec } from './spec-tools.ts';
export type {
  RouteCoverage,
  SpecCoverageReport,
  SpecDriftIssue,
} from './spec-tools.ts';

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
  ResolveBodyFor,
  ResolveBodyFromPaths,
  ResolveErrorResponseFor,
  ResolveErrorResponseFromPaths,
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
