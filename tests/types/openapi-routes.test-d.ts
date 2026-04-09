/**
 * Type-level tests for §4.A7 — `fromOpenAPI` is generic over the literal
 * spec type and produces a `Routes` shape that preserves path keys and
 * method keys, so call sites get path autocomplete and method narrowing
 * straight from the spec.
 *
 * Body/response *type* inference from the spec's JSON Schemas is the
 * follow-up; this file only checks the structural narrowing.
 */
/* eslint-disable ts/explicit-function-return-type */

import type { InferRoutesFromSpec } from '../../src/types.ts';
import { createFetch } from '../../src/fetcher.ts';
import { fromOpenAPI } from '../../src/openapi.ts';
import petstoreSpec from '../fixtures/petstore.json';

// ---------------------------------------------------------------------------
// Equal / Verify helpers (zero deps; same pattern as ad-hoc-schema test)
// ---------------------------------------------------------------------------

type Equal<X, Y>
  = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2)
    ? true
    : false;

export type Verify<T extends true> = T;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const routes = fromOpenAPI(petstoreSpec);
const f = createFetch({
  baseUrl: 'https://api.example.com',
  routes,
});

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

/** Path keys from the spec are preserved (literal, not widened to string). */
type RoutesType = typeof routes;
export type Case_PetsKey = Verify<'/pets' extends keyof RoutesType ? true : false>;
export type Case_PetsByIdKey = Verify<'/pets/{petId}' extends keyof RoutesType ? true : false>;

/** Method keys per path are preserved and uppercased from the spec. */
export type Case_PetsHasGet = Verify<'GET' extends keyof RoutesType['/pets'] ? true : false>;
export type Case_PetsHasPost = Verify<'POST' extends keyof RoutesType['/pets'] ? true : false>;
export type Case_PetsByIdHasGet = Verify<'GET' extends keyof RoutesType['/pets/{petId}'] ? true : false>;

/** Methods that don't exist in the spec are NOT in the inferred type. */
export type Case_PetsByIdNoPost = Verify<
  Equal<'POST' extends keyof RoutesType['/pets/{petId}'] ? true : false, false>
>;

/** A typed call against an existing path/method should typecheck cleanly. */
function callTypedPath() {
  return f('/pets/{petId}', {
    method: 'GET',
    params: { petId: '42' }, // params required because the path template has {petId}
  });
}
void callTypedPath;

/** Calling f.get with a known path uses the typed branch. */
function callShortcut() {
  return f.get('/pets');
}
void callShortcut;

/** ExtractPathParams still works on the literal path. */
function callWithParams() {
  return f('/pets/{petId}', {
    method: 'GET',
    params: { petId: '1' },
  });
}
void callWithParams;

/**
 * Sanity check: InferRoutesFromSpec on a hand-rolled spec literal produces
 * the expected mapping. Lets us verify the helper independently of the
 * petstore fixture.
 */
interface SmallSpec {
  paths: {
    '/users': {
      get: { responses: object };
      post: { responses: object };
    };
    '/users/{id}': {
      get: { responses: object };
      delete: { responses: object };
    };
  };
}

type Inferred = InferRoutesFromSpec<SmallSpec>;

export type Case_SmallSpec_HasUsers = Verify<'/users' extends keyof Inferred ? true : false>;
export type Case_SmallSpec_HasUsersById = Verify<'/users/{id}' extends keyof Inferred ? true : false>;
export type Case_SmallSpec_UsersGet = Verify<'GET' extends keyof Inferred['/users'] ? true : false>;
export type Case_SmallSpec_UsersPost = Verify<'POST' extends keyof Inferred['/users'] ? true : false>;
export type Case_SmallSpec_UsersByIdDelete = Verify<'DELETE' extends keyof Inferred['/users/{id}'] ? true : false>;

/** PUT was not in the spec — should not be in the inferred mapping. */
export type Case_SmallSpec_UsersNoPut = Verify<
  Equal<'PUT' extends keyof Inferred['/users'] ? true : false, false>
>;
