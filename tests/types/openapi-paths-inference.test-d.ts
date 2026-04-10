/**
 * Type-level tests for D6 — body / response / errorResponse inference from
 * a generated `paths` interface (the kind `openapi-typescript` emits).
 *
 * The hand-rolled `paths` interface below mirrors the literal shape that
 * `openapi-typescript` produces for the petstore fixture: nested
 * `path → method → { parameters, requestBody, responses → status → content
 * → mediaType }`. By passing it as the second generic to `createFetch<paths>`,
 * the call site should infer:
 *
 *   - `result.data` from the 2xx JSON response
 *   - `result.error.body` (when `kind: 'http'`) from the 4xx/5xx JSON response
 *   - `body` from `requestBody.content['application/json']`
 *
 * No runtime — these assertions all live at the type level.
 *
 * Lint disables: same as the other type-test fixtures.
 */
/* eslint-disable unused-imports/no-unused-vars, ts/explicit-function-return-type */

import type { ResultData, TypedResponse } from '../../src/types.ts';
import { createFetch } from '../../src/fetcher.ts';

// ---------------------------------------------------------------------------
// Equal / Verify helpers
// ---------------------------------------------------------------------------

type Equal<X, Y>
  = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2)
    ? true
    : false;

export type Verify<T extends true> = T;

// ---------------------------------------------------------------------------
// Hand-rolled `paths` interface — same shape openapi-typescript emits.
// This is what the user would `import type { paths } from './generated'`.
// ---------------------------------------------------------------------------

interface Pet {
  id: number;
  name: string;
  tag?: string;
}

interface ApiError {
  code: number;
  message: string;
}

interface paths {
  '/pets': {
    get: {
      parameters: {
        query?: { limit?: number };
      };
      responses: {
        200: {
          content: {
            'application/json': Pet[];
          };
        };
        default: {
          content: {
            'application/json': ApiError;
          };
        };
      };
    };
    post: {
      requestBody: {
        content: {
          'application/json': Pet;
        };
      };
      responses: {
        201: {
          content: {
            'application/json': Pet;
          };
        };
      };
    };
  };
  '/pets/{petId}': {
    get: {
      parameters: {
        path: { petId: string };
      };
      responses: {
        200: {
          content: {
            'application/json': Pet;
          };
        };
        404: {
          content: {
            'application/json': ApiError;
          };
        };
      };
    };
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const f = createFetch<paths>({ baseUrl: 'https://api.example.com' });

// Top-level call expressions whose return type can be examined by tsc.
function getPetById() {
  return f('/pets/{petId}', {
    method: 'GET',
    params: { petId: '42' },
  });
}

function listPets() {
  return f('/pets', { method: 'GET' });
}

function createPet() {
  return f('/pets', {
    method: 'POST',
    body: { id: 1, name: 'Rex' },
  });
}

function listPetsViaShortcut() {
  return f.get('/pets');
}

function createPetViaShortcut() {
  return f.post('/pets', { body: { id: 1, name: 'Rex' } });
}

// ---------------------------------------------------------------------------
// Type-level assertions (exported so noUnusedLocals leaves them alone)
// ---------------------------------------------------------------------------

/**
 * Case 1 — `GET /pets/{petId}` resolves the success body to `Pet` and the
 * error body to `ApiError` (from the 404 response).
 */
export type Case_GetPet = Verify<
  Equal<
    Awaited<ReturnType<typeof getPetById>>,
    TypedResponse<Pet, ApiError>
  >
>;

/**
 * Case 2 — `GET /pets` has both `200` (Pet[]) and `default` (ApiError).
 * `'default'` is in `OpenAPIErrorStatus`, so it becomes the error body;
 * `200` is in `OpenAPISuccessStatus`, so it becomes the success body.
 */
export type Case_ListPets = Verify<
  Equal<
    Awaited<ReturnType<typeof listPets>>,
    TypedResponse<Pet[], ApiError>
  >
>;

/**
 * Case 3 — `POST /pets` resolves the success body to `Pet`. No error
 * response is declared, so the error body falls back to `unknown`.
 */
export type Case_CreatePet = Verify<
  Equal<
    Awaited<ReturnType<typeof createPet>>,
    TypedResponse<Pet, unknown>
  >
>;

/**
 * Case 4 — `f.get('/pets')` shortcut produces the same typed response as
 * the long-form call. Validates that `MethodShortcutFn` threads the `OAS`
 * generic through correctly. Error body is `ApiError` from the `default`
 * response (same reasoning as Case 2).
 */
export type Case_ListPetsShortcut = Verify<
  Equal<
    Awaited<ReturnType<typeof listPetsViaShortcut>>,
    TypedResponse<Pet[], ApiError>
  >
>;

/**
 * Case 5 — `f.post('/pets', { body })` shortcut requires and types the body
 * field. If the body type were wrong here, `createPetViaShortcut` would
 * fail to compile, which is the assertion.
 */
export type Case_CreatePetShortcut = Verify<
  Equal<
    Awaited<ReturnType<typeof createPetViaShortcut>>,
    TypedResponse<Pet, unknown>
  >
>;

/**
 * Case 6 — `.result()` narrows correctly: on `ok: true`, `data` is the
 * inferred `Pet`; on `ok: false` with `kind: 'http'`, `body` is `ApiError`.
 */
async function consumeGetPet() {
  const response = await getPetById();
  const result: ResultData<Pet, ApiError> = await response.result();
  if (result.ok) {
    // result.data is Pet
    const _id: number = result.data.id;
    const _name: string = result.data.name;
    void _id;
    void _name;
  }
  else if (result.error.kind === 'http') {
    // result.error.body is ApiError
    const _code: number = result.error.body.code;
    const _msg: string = result.error.body.message;
    void _code;
    void _msg;
  }
}
void consumeGetPet;

// ---------------------------------------------------------------------------
// Negative-ish checks: paths/methods NOT in the interface fall through to
// the untyped branch instead of typechecking against the wrong shape.
// ---------------------------------------------------------------------------

function unknownPath() {
  return f('/not/a/real/path', { method: 'GET' });
}

/** Unknown path → untyped → `TypedResponse<unknown>`. */
export type Case_UnknownPath = Verify<
  Equal<Awaited<ReturnType<typeof unknownPath>>, TypedResponse<unknown>>
>;

function unknownMethodOnKnownPath() {
  return f('/pets/{petId}', {
    method: 'DELETE',
    params: { petId: '42' },
  });
}

/**
 * Known path, method not declared in the spec → untyped fallback.
 * `f('/pets/{petId}', { method: 'DELETE', ... })` should not fail to compile,
 * but should resolve to `TypedResponse<unknown>` rather than the GET shape.
 */
export type Case_UnknownMethod = Verify<
  Equal<
    Awaited<ReturnType<typeof unknownMethodOnKnownPath>>,
    TypedResponse<unknown>
  >
>;
