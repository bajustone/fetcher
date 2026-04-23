/**
 * Type-level tests for `PathsToRoutes<P>` — the `paths`-aware narrowing that
 * the Vite/Rollup plugin emits on `virtual:fetcher`'s `routes` export.
 *
 * Validates:
 * - Each slot (`body`, `params`, `query`, `response`, `errorResponse`) is
 *   typed via `Schema<ConcreteT>` rather than the bare `Schema`.
 * - Method keys are uppercased (matches the runtime's
 *   `method.toUpperCase()` write in `extractRouteSchemas` / `fromOpenAPI`).
 * - Non-supported HTTP verbs in the spec (options/head/trace) are filtered
 *   out — they don't appear on the narrowed route entry.
 */

import type { PathsToRoutes, Schema } from '../../src/types.ts';

// ---------------------------------------------------------------------------
// Equal / Verify helpers
// ---------------------------------------------------------------------------

type Equal<X, Y>
  = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2)
    ? true
    : false;

export type Verify<T extends true> = T;

// ---------------------------------------------------------------------------
// Hand-rolled `paths` — mirrors openapi-typescript's emission for a spec
// with a POST request body, path params, query params, 2xx + 4xx responses,
// and an `options` method that should get filtered out.
// ---------------------------------------------------------------------------

interface Pet { id: number; name: string }
interface ApiError { code: number; message: string }
interface CreatePet { name: string; tag?: string }

interface paths {
  '/pets': {
    get: {
      parameters: { query?: { limit?: number } };
      responses: {
        200: { content: { 'application/json': Pet[] } };
        default: { content: { 'application/json': ApiError } };
      };
    };
    post: {
      requestBody: { content: { 'application/json': CreatePet } };
      responses: {
        201: { content: { 'application/json': Pet } };
        400: { content: { 'application/json': ApiError } };
      };
    };
    // Non-supported verb — must not appear in PathsToRoutes<paths>['/pets']
    options: { responses: { 200: Record<string, never> } };
  };
  '/pets/{id}': {
    get: {
      parameters: { path: { id: number } };
      responses: {
        200: { content: { 'application/json': Pet } };
        404: { content: { 'application/json': ApiError } };
      };
    };
  };
}

type Routes = PathsToRoutes<paths>;

// ---------------------------------------------------------------------------
// Method-key uppercasing + unsupported-verb filtering
// ---------------------------------------------------------------------------

// Methods are uppercased from openapi-typescript's lowercase keys.
export type _MethodsOnPets = Verify<
  Equal<keyof Routes['/pets'], 'GET' | 'POST'>
>;
// `options` → filtered out entirely (not 'OPTIONS').
export type _NoOptions = Verify<
  'OPTIONS' extends keyof Routes['/pets'] ? false : true
>;

// ---------------------------------------------------------------------------
// Slot typing — each slot carries the concrete JSON-Schema-derived type
// ---------------------------------------------------------------------------

// POST /pets body is CreatePet.
export type _PostBody = Verify<
  Equal<Routes['/pets']['POST']['body'], Schema<CreatePet> | undefined>
>;

// POST /pets 2xx response is Pet.
export type _PostResponse = Verify<
  Equal<Routes['/pets']['POST']['response'], Schema<Pet> | undefined>
>;

// POST /pets 4xx response is ApiError.
export type _PostErrorResponse = Verify<
  Equal<Routes['/pets']['POST']['errorResponse'], Schema<ApiError> | undefined>
>;

// GET /pets query is { limit?: number }.
export type _GetQuery = Verify<
  Equal<Routes['/pets']['GET']['query'], Schema<{ limit?: number }> | undefined>
>;

// GET /pets/{id} params is { id: number }.
export type _GetParams = Verify<
  Equal<Routes['/pets/{id}']['GET']['params'], Schema<{ id: number }> | undefined>
>;
