/**
 * End-to-end regression test for the documented OpenAPI `<paths>` workflow.
 *
 * `tests/fixtures/petstore-paths.d.ts` is the **real** output of
 * `bunx openapi-typescript@latest tests/fixtures/petstore.json`. Checking it
 * in keeps the test hermetic (no `bunx` in CI) while still verifying the
 * prototype against actual codegen output rather than a hand-rolled mock.
 *
 * To regenerate after the petstore fixture changes:
 *
 * ```sh
 * bunx openapi-typescript@latest tests/fixtures/petstore.json -o tests/fixtures/petstore-paths.d.ts
 * ```
 *
 * What this test asserts:
 *
 * 1. The generated `paths` interface composes with `createFetch<paths>(...)`
 *    against a mock fetch — the runtime call/response cycle works end-to-end.
 * 2. The type-level resolvers (`ResolveResponseFor`, `ResolveBodyFor`,
 *    `ResolveErrorResponseFor`) narrow `data` and `error.body` to the right
 *    schemas when fed openapi-typescript's nested `operations[...]` indirection.
 *    This is a stricter test than the hand-rolled fixture in
 *    `tests/types/openapi-paths-inference.test-d.ts` because it uses real
 *    codegen output.
 * 3. `lintSpec(petstore)` returns `[]` (the fixture is intentionally clean).
 * 4. `coverage(petstore)` reports all 3 routes as fully Tier 0 ready.
 */

import type { components, paths } from './fixtures/petstore-paths.d.ts';
import { describe, expect, it } from 'bun:test';
import { createFetch } from '../src/fetcher.ts';
import { coverage, lintSpec } from '../src/spec-tools.ts';
import petstoreSpec from './fixtures/petstore.json';

type Pet = components['schemas']['Pet'];
type ApiError = components['schemas']['Error'];

// ---------------------------------------------------------------------------
// Type-level assertions: the generated paths interface composes with
// createFetch<paths>(...) and resolves to the expected response shapes.
// ---------------------------------------------------------------------------

type Equal<X, Y>
  = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2)
    ? true
    : false;
type Verify<T extends true> = T;

const fTypeProbe = createFetch<paths>({ baseUrl: 'https://example.test' });

// Probe functions are referenced via `typeof` only. The leading underscore
// satisfies `unused-imports/no-unused-vars`. No explicit return type — the
// type assertions further down rely on inference.
function _getPetByIdProbe() {
  return fTypeProbe('/pets/{petId}', { method: 'GET', params: { petId: '42' } });
}
function _listPetsProbe() {
  return fTypeProbe('/pets', { method: 'GET' });
}
function _createPetProbe() {
  return fTypeProbe('/pets', { method: 'POST', body: { id: 1, name: 'Rex' } });
}

// Helpers to peel into the discriminated `ResultData` union. The double
// `Extract` on `HttpErrorBody` is load-bearing: `error` is itself a union
// (`network | validation | http`), and a single `extends { kind: 'http'; body: infer B }`
// would require the *entire* union to match the http variant, which fails.
// Extract the http variant first, then index `body`.
type SuccessData<R> = Extract<R, { ok: true }> extends { data: infer D } ? D : never;
type HttpErrorBody<R> = Extract<
  Extract<R, { ok: false }> extends { error: infer E } ? E : never,
  { kind: 'http' }
> extends { body: infer B } ? B : never;

// `data` resolves to Pet for GET /pets/{petId}; error body resolves to
// `unknown` because the petstore fixture's GET /pets/{petId} declares no
// error response.
type _GetPetReturn = Awaited<ReturnType<typeof _getPetByIdProbe>>;
type _GetPetResult = Awaited<ReturnType<_GetPetReturn['result']>>;
type _Case_GetPet_Data = Verify<Equal<SuccessData<_GetPetResult>, Pet>>;

// `data` resolves to Pet[] for GET /pets; error body is ApiError because the
// `default` response declares one (and `'default'` lives in the error status
// set per OpenAPIErrorStatus).
type _ListPetsReturn = Awaited<ReturnType<typeof _listPetsProbe>>;
type _ListPetsResult = Awaited<ReturnType<_ListPetsReturn['result']>>;
type _Case_ListPets_Data = Verify<Equal<SuccessData<_ListPetsResult>, Pet[]>>;
type _Case_ListPets_ErrorBody = Verify<Equal<HttpErrorBody<_ListPetsResult>, ApiError>>;

// `data` resolves to Pet for POST /pets; body field is required and typed.
type _CreatePetReturn = Awaited<ReturnType<typeof _createPetProbe>>;
type _CreatePetResult = Awaited<ReturnType<_CreatePetReturn['result']>>;
type _Case_CreatePet_Data = Verify<Equal<SuccessData<_CreatePetResult>, Pet>>;

// Suppress unused-type warnings.
export type _ExportedTypeAssertions
  = | _Case_GetPet_Data
    | _Case_ListPets_Data
    | _Case_ListPets_ErrorBody
    | _Case_CreatePet_Data;

// ---------------------------------------------------------------------------
// Runtime mock-fetch test: full request/response cycle through createFetch<paths>.
// ---------------------------------------------------------------------------

describe('openapi-typescript paths workflow', () => {
  it('GET /pets/{petId} narrows result.data to Pet via mock fetch', async () => {
    const pet: Pet = { id: 42, name: 'Rex', tag: 'good-boy' };
    const mockFetch = async (req: Request): Promise<Response> => {
      expect(req.url).toBe('https://example.test/pets/42');
      expect(req.method).toBe('GET');
      return new Response(JSON.stringify(pet), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const f = createFetch<paths>({ baseUrl: 'https://example.test', fetch: mockFetch });
    const response = await f('/pets/{petId}', { method: 'GET', params: { petId: '42' } });
    const result = await response.result();

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Type-level: result.data is `Pet`. Runtime: same value.
      expect(result.data.id).toBe(42);
      expect(result.data.name).toBe('Rex');
      expect(result.data.tag).toBe('good-boy');
    }
  });

  it('GET /pets narrows result.data to Pet[] via mock fetch', async () => {
    const pets: Pet[] = [
      { id: 1, name: 'Rex' },
      { id: 2, name: 'Buddy', tag: 'friendly' },
    ];
    const mockFetch = async (): Promise<Response> => new Response(JSON.stringify(pets), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

    const f = createFetch<paths>({ baseUrl: 'https://example.test', fetch: mockFetch });
    const response = await f('/pets', { method: 'GET' });
    const result = await response.result();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(2);
      expect(result.data[0]!.name).toBe('Rex');
      expect(result.data[1]!.tag).toBe('friendly');
    }
  });

  it('GET /pets surfaces a 5xx default error as ApiError on result.error.body', async () => {
    const apiError: ApiError = { code: 503, message: 'service unavailable' };
    const mockFetch = async (): Promise<Response> => new Response(JSON.stringify(apiError), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });

    const f = createFetch<paths>({ baseUrl: 'https://example.test', fetch: mockFetch });
    const response = await f('/pets', { method: 'GET' });
    const result = await response.result();

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'http') {
      expect(result.error.status).toBe(503);
      // Type-level: result.error.body is `ApiError` (from the `default` response).
      expect(result.error.body.code).toBe(503);
      expect(result.error.body.message).toBe('service unavailable');
    }
  });

  it('POST /pets requires and types the body via mock fetch', async () => {
    const pet: Pet = { id: 99, name: 'Snowy' };
    const mockFetch = async (req: Request): Promise<Response> => {
      expect(req.method).toBe('POST');
      const sent = await req.json();
      expect(sent).toEqual({ id: 99, name: 'Snowy' });
      return new Response(JSON.stringify(pet), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    };

    const f = createFetch<paths>({ baseUrl: 'https://example.test', fetch: mockFetch });
    const response = await f('/pets', { method: 'POST', body: { id: 99, name: 'Snowy' } });
    const result = await response.result();

    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.data.name).toBe('Snowy');
  });

  // -------------------------------------------------------------------------
  // Spec-tools sanity checks against the canonical petstore fixture.
  // (Detailed unit tests live in tests/spec-tools.test.ts; these are
  // smoke tests pinning the documented workflow to the same fixture.)
  // -------------------------------------------------------------------------

  it('lintSpec(petstore) returns []', () => {
    expect(lintSpec(petstoreSpec)).toEqual([]);
  });

  it('coverage(petstore) reports 3/3 routes fully Tier 0 ready', () => {
    const report = coverage(petstoreSpec);
    expect(report.summary.total).toBe(3);
    expect(report.summary.fullyTyped).toBe(3);
    expect(report.summary.partial).toBe(0);
    expect(report.summary.untyped).toBe(0);
  });
});
