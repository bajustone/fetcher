/**
 * Type-level tests for §4.A1 — per-call `responseSchema` propagates its
 * inferred output type through to `TypedResponse`'s data generic, with no
 * cast at the call site.
 *
 * Uses a zero-dependency Equal/Verify pattern. tsc compiles this file as
 * part of the normal `bun typecheck` step; any failure surfaces as a TS
 * error. All assertions are exported type aliases so `noUnusedLocals` does
 * not flag them.
 *
 * Lint disables: this is a type-test fixture. The helper functions are
 * intentionally never called at runtime — only `typeof` referenced — so the
 * unused-vars rule does not apply, and writing explicit return types would
 * defeat the purpose of the inference checks.
 */
/* eslint-disable unused-imports/no-unused-vars, ts/explicit-function-return-type */

import type { StandardSchemaV1, TypedResponse } from '../../src/types.ts';
import { createFetch } from '../../src/fetcher.ts';

// ---------------------------------------------------------------------------
// Equal / Verify helpers (zero deps)
// ---------------------------------------------------------------------------

type Equal<X, Y>
  = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2)
    ? true
    : false;

/** Compile-time assertion: the type argument must be exactly `true`. */
export type Verify<T extends true> = T;

// ---------------------------------------------------------------------------
// A minimal Standard Schema V1 helper for fixtures (mirrors Zod/Valibot/etc.)
// ---------------------------------------------------------------------------

function s<T>(): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'fetcher-types-test',
      validate: value => ({ value: value as T }),
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const f = createFetch({ baseUrl: 'https://api.example.com' });

const routedF = createFetch({
  baseUrl: 'https://api.example.com',
  routes: {
    '/users': {
      GET: { response: s<{ id: number }>() },
    },
  },
});

// Top-level call expressions whose return type can be examined.
function case1Call() {
  return f('/anything', {
    method: 'GET',
    responseSchema: s<{ id: string; name: string }>(),
  });
}

const case2Call = () => f('/anything', { method: 'GET' });

const case3RouteOnly = () => routedF('/users', { method: 'GET' });

function case3WithOverride() {
  return routedF('/users', {
    method: 'GET',
    responseSchema: s<{ wrapped: string }>(),
  });
}

// ---------------------------------------------------------------------------
// Type-level assertions (exported so noUnusedLocals leaves them alone)
// ---------------------------------------------------------------------------

/**
 * Case 1 — per-call responseSchema on an untyped path resolves data to T.
 * Expected: `TypedResponse<{ id: string; name: string }>`.
 */
export type Case1 = Verify<
  Equal<
    Awaited<ReturnType<typeof case1Call>>,
    TypedResponse<{ id: string; name: string }>
  >
>;

/**
 * Case 2 — without a responseSchema, an untyped call returns `unknown` data.
 */
export type Case2 = Verify<
  Equal<Awaited<ReturnType<typeof case2Call>>, TypedResponse<unknown>>
>;

/**
 * Case 3a — typed route, no override: data type comes from the route's
 * declared `response` schema (`{ id: number }`).
 */
export type Case3a = Verify<
  Equal<
    Awaited<ReturnType<typeof case3RouteOnly>>,
    TypedResponse<{ id: number }, unknown>
  >
>;

/**
 * Case 3b — typed route with per-call override: the override wins, data
 * type is `{ wrapped: string }` rather than the route's `{ id: number }`.
 */
export type Case3b = Verify<
  Equal<
    Awaited<ReturnType<typeof case3WithOverride>>,
    TypedResponse<{ wrapped: string }, unknown>
  >
>;
