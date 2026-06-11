/**
 * Type-level tests for zero-codegen OpenAPI spec inference.
 *
 * Verifies that `fromOpenAPI(spec)` applied to an inline `as const` spec
 * produces route definitions whose body / response / errorResponse types
 * are inferred from the embedded JSON Schemas via `JSONSchemaToType`.
 *
 * Uses bidirectional mutual-assignability for `Equal`, which is robust to
 * intersection structure and optional-key encoding that strict
 * identity-based comparisons fail on.
 */
/* eslint-disable unused-imports/no-unused-vars, ts/explicit-function-return-type */

import type { InferRoutesFromSpec, InferSchema, JSONSchemaToType } from '../../src/index.ts';
import { createFetch } from '../../src/fetcher.ts';
import { fromOpenAPI } from '../../src/openapi.ts';

type Equal<X, Y>
  = [X] extends [Y] ? ([Y] extends [X] ? true : false) : false;

export type Verify<T extends true> = T;

// ---------------------------------------------------------------------------
// JSONSchemaToType — standalone primitives
// ---------------------------------------------------------------------------

export type T_string = Verify<Equal<JSONSchemaToType<{ type: 'string' }>, string>>;
export type T_integer = Verify<Equal<JSONSchemaToType<{ type: 'integer' }>, number>>;
export type T_number = Verify<Equal<JSONSchemaToType<{ type: 'number' }>, number>>;
export type T_boolean = Verify<Equal<JSONSchemaToType<{ type: 'boolean' }>, boolean>>;
export type T_null = Verify<Equal<JSONSchemaToType<{ type: 'null' }>, null>>;
export type T_const = Verify<Equal<JSONSchemaToType<{ const: 'fixed' }>, 'fixed'>>;
export type T_enum = Verify<Equal<JSONSchemaToType<{ enum: readonly ['a', 'b', 'c'] }>, 'a' | 'b' | 'c'>>;

export type T_array = Verify<Equal<JSONSchemaToType<{ type: 'array'; items: { type: 'string' } }>, string[]>>;

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------

export type T_objectRequired = Verify<Equal<
  JSONSchemaToType<{
    type: 'object';
    properties: { id: { type: 'integer' }; name: { type: 'string' } };
    required: readonly ['id', 'name'];
  }>,
  { id: number; name: string }
>>;

// Mixed required + optional
type PartialObjOut = JSONSchemaToType<{
  type: 'object';
  properties: {
    id: { type: 'integer' };
    tag: { type: 'string' };
  };
  required: readonly ['id'];
}>;
export type T_partialObj_id = Verify<Equal<PartialObjOut['id'], number>>;
export type T_partialObj_tag = Verify<Equal<PartialObjOut['tag'], string | undefined>>;

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

// anyOf → union
export type T_anyOf = Verify<Equal<
  JSONSchemaToType<{ anyOf: readonly [{ type: 'string' }, { type: 'integer' }] }>,
  string | number
>>;

// OpenAPI 3.0 nullable
export type T_nullable = Verify<Equal<
  JSONSchemaToType<{ type: 'string'; nullable: true }>,
  string | null
>>;

// OpenAPI 3.0 nullable on an OBJECT keeps its properties/required
export type T_nullableObject = Verify<Equal<
  JSONSchemaToType<{
    type: 'object';
    properties: { name: { type: 'string' } };
    required: readonly ['name'];
    nullable: true;
  }>,
  { name: string } | null
>>;

// OpenAPI 3.0 nullable on an ARRAY keeps its items
export type T_nullableArray = Verify<Equal<
  JSONSchemaToType<{ type: 'array'; items: { type: 'string' }; nullable: true }>,
  string[] | null
>>;

// OpenAPI 3.1 type arrays → union of mapped member types
export type T_typeArray = Verify<Equal<
  JSONSchemaToType<{ type: readonly ['string', 'null'] }>,
  string | null
>>;

export type T_typeArrayNumeric = Verify<Equal<
  JSONSchemaToType<{ type: readonly ['integer', 'null'] }>,
  number | null
>>;

// 3.1 type array with composite members reads items/properties off the node
export type T_typeArrayObject = Verify<Equal<
  JSONSchemaToType<{
    type: readonly ['object', 'null'];
    properties: { id: { type: 'integer' } };
    required: readonly ['id'];
  }>,
  { id: number } | null
>>;

export type T_typeArrayOfArrays = Verify<Equal<
  JSONSchemaToType<{ type: readonly ['array', 'null']; items: { type: 'string' } }>,
  string[] | null
>>;

// additionalProperties: sub-schema → Record index signature
export type T_additionalProps = Verify<Equal<
  JSONSchemaToType<{ type: 'object'; additionalProperties: { type: 'string' } }>,
  Record<string, string>
>>;

// properties + additionalProperties → mapped props intersected with the record
type PropsAndAdditional = JSONSchemaToType<{
  type: 'object';
  properties: { id: { type: 'integer' } };
  required: readonly ['id'];
  additionalProperties: { type: 'integer' };
}>;
export type T_propsAndAdditional_id = Verify<Equal<PropsAndAdditional['id'], number>>;
export type T_propsAndAdditional_index = Verify<Equal<PropsAndAdditional['anythingElse'], number>>;

// additionalProperties: true/false do not fabricate a typed index signature
export type T_additionalPropsTrue = Verify<Equal<
  JSONSchemaToType<{ type: 'object'; additionalProperties: true }>,
  Record<string, unknown>
>>;

// $ref resolution against a defs bag
interface MyDefs {
  Pet: {
    type: 'object';
    properties: { id: { type: 'integer' } };
    required: readonly ['id'];
  };
}
export type T_ref = Verify<Equal<
  JSONSchemaToType<{ $ref: '#/components/schemas/Pet' }, MyDefs>,
  { id: number }
>>;

// Unknown shape falls through to `unknown`
export type T_unknown = Verify<Equal<JSONSchemaToType<{ weird: true }>, unknown>>;

// ---------------------------------------------------------------------------
// InferRoutesFromSpec — walks a narrow spec into typed routes
// ---------------------------------------------------------------------------

const spec = {
  paths: {
    '/pets/{id}': {
      get: {
        responses: {
          200: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    id: { type: 'integer' },
                    name: { type: 'string' },
                    tag: { type: 'string' },
                  },
                  required: ['id', 'name'],
                },
              },
            },
          },
          404: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { message: { type: 'string' } },
                  required: ['message'],
                },
              },
            },
          },
        },
      },
      post: {
        requestBody: {
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/PetCreate' },
            },
          },
        },
        responses: {
          201: {
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Pet' },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Pet: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
        },
        required: ['id', 'name'],
      },
      PetCreate: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    },
  },
} as const;

type R = InferRoutesFromSpec<typeof spec>;

// GET /pets/{id} 200 response → { id: number; name: string; tag?: string }
type GetResponse = InferSchema<NonNullable<R['/pets/{id}']['GET']['response']>>;
export type T_get_response = Verify<Equal<GetResponse, { id: number; name: string; tag?: string }>>;

// GET /pets/{id} 404 error → { message: string }
type GetError = InferSchema<NonNullable<R['/pets/{id}']['GET']['errorResponse']>>;
export type T_get_error = Verify<Equal<GetError, { message: string }>>;

// POST /pets/{id} body (resolved via $ref to PetCreate) → { name: string }
type PostBody = InferSchema<NonNullable<R['/pets/{id}']['POST']['body']>>;
export type T_post_body = Verify<Equal<PostBody, { name: string }>>;

// POST /pets/{id} 201 response (resolved via $ref to Pet) → { id: number; name: string }
type PostResponse = InferSchema<NonNullable<R['/pets/{id}']['POST']['response']>>;
export type T_post_response = Verify<Equal<PostResponse, { id: number; name: string }>>;

// Method uppercase mapping
export type T_methods = Verify<
  Equal<keyof R['/pets/{id}'], 'GET' | 'POST'>
>;

// ---------------------------------------------------------------------------
// Call-site inference — the layer the route-table assertions above do NOT
// cover. `createFetch({ routes: fromOpenAPI(spec) })` must surface the
// inferred types at `f(...)` / `.result()` call sites (the documented
// zero-codegen flow), not just on the route-table slots.
// ---------------------------------------------------------------------------

const callSpec = {
  paths: {
    '/pets/{id}': {
      get: {
        responses: {
          200: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    id: { type: 'integer' },
                    name: { type: 'string' },
                    tag: { type: 'string' },
                  },
                  required: ['id', 'name'],
                },
              },
            },
          },
          404: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { message: { type: 'string' } },
                  required: ['message'],
                },
              },
            },
          },
        },
      },
      post: {
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  status: { enum: ['available', 'sold'] },
                },
                required: ['name'],
              },
            },
          },
        },
        responses: {
          201: {
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Pet' },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Pet: {
        type: 'object',
        properties: { id: { type: 'integer' }, name: { type: 'string' } },
        required: ['id', 'name'],
      },
    },
  },
} as const;

const fCallSite = createFetch({
  baseUrl: 'https://api.example.com',
  routes: fromOpenAPI(callSpec),
});

// Helpers to peel the ResultData discriminated union.
type SuccessData<Res> = Extract<Res, { ok: true }> extends { data: infer D } ? D : never;
type HttpErrorBody<Res> = Extract<
  Extract<Res, { ok: false }> extends { error: infer E } ? E : never,
  { kind: 'http' }
> extends { body: infer B } ? B : never;

function getPetCall() {
  return fCallSite('/pets/{id}', { method: 'GET', params: { id: 1 } });
}
function createPetCall() {
  return fCallSite('/pets/{id}', {
    method: 'POST',
    params: { id: 1 },
    body: { name: 'Rex', status: 'available' },
  });
}
function getPetShortcut() {
  return fCallSite.get('/pets/{id}', { params: { id: '1' } });
}

type GetPetResult = Awaited<ReturnType<Awaited<ReturnType<typeof getPetCall>>['result']>>;
type CreatePetResult = Awaited<ReturnType<Awaited<ReturnType<typeof createPetCall>>['result']>>;
type GetPetShortcutResult = Awaited<ReturnType<Awaited<ReturnType<typeof getPetShortcut>>['result']>>;

// `result.data` is the inferred 200 schema — NOT `unknown`.
export type T_callsite_data = Verify<Equal<
  SuccessData<GetPetResult>,
  { id: number; name: string; tag?: string }
>>;

// `result.error.body` (kind: 'http') is the inferred 404 schema.
export type T_callsite_errorBody = Verify<Equal<
  HttpErrorBody<GetPetResult>,
  { message: string }
>>;

// POST resolves the $ref'd 201 response at the call site.
export type T_callsite_postData = Verify<Equal<
  SuccessData<CreatePetResult>,
  { id: number; name: string }
>>;

// Method shortcuts thread the same inference.
export type T_callsite_shortcutData = Verify<Equal<
  SuccessData<GetPetShortcutResult>,
  { id: number; name: string; tag?: string }
>>;

// `.unwrap()` resolves to the data type directly.
function unwrapCall() {
  return fCallSite('/pets/{id}', { method: 'GET', params: { id: 1 } }).unwrap();
}
export type T_callsite_unwrap = Verify<Equal<
  Awaited<ReturnType<typeof unwrapCall>>,
  { id: number; name: string; tag?: string }
>>;

// Narrowing inside the result branches.
async function _consumeGetPet() {
  const r = await getPetCall().result();
  if (r.ok) {
    const _name: string = r.data.name;
    void _name;
    // @ts-expect-error — `bogus` is not a property of the inferred response
    void r.data.bogus;
  }
  else if (r.error.kind === 'http') {
    const _msg: string = r.error.body.message;
    void _msg;
  }
}
void _consumeGetPet;

// ---------------------------------------------------------------------------
// Negative input-side assertions — wrong/missing bodies and params must be
// compile errors, not runtime validation failures.
// ---------------------------------------------------------------------------

function _negWrongBodyFieldType() {
  return fCallSite('/pets/{id}', {
    method: 'POST',
    params: { id: 1 },
    // @ts-expect-error — `name` must be a string
    body: { name: 123 },
  });
}

function _negUnknownEnumMember() {
  return fCallSite('/pets/{id}', {
    method: 'POST',
    params: { id: 1 },
    // @ts-expect-error — 'bogus' is not in the status enum
    body: { name: 'Rex', status: 'bogus' },
  });
}

function _negMissingRequiredBody() {
  // @ts-expect-error — POST declares `required: true` body; omitting it is a compile error
  return fCallSite('/pets/{id}', { method: 'POST', params: { id: 1 } });
}

function _negMissingRequiredParams() {
  // @ts-expect-error — the path template has {id}; `params` is required
  return fCallSite('/pets/{id}', { method: 'GET' });
}

function _negShortcutRequiresOptions() {
  // @ts-expect-error — the POST shortcut requires the options argument (body + params)
  return fCallSite.post('/pets/{id}');
}

void _negWrongBodyFieldType;
void _negUnknownEnumMember;
void _negMissingRequiredBody;
void _negMissingRequiredParams;
void _negShortcutRequiresOptions;

// ---------------------------------------------------------------------------
// Slot presence/absence semantics on the inferred route table
// ---------------------------------------------------------------------------

type CallRoutes = InferRoutesFromSpec<typeof callSpec>;

// `required: true` body → the slot is a required property (not undefined-able).
export type T_requiredBodySlot = Verify<Equal<
  undefined extends CallRoutes['/pets/{id}']['POST']['body'] ? true : false,
  false
>>;

// Optional request body (OpenAPI default) → optional, but still typed.
const optionalBodySpec = {
  paths: {
    '/search': {
      post: {
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { q: { type: 'string' } },
                required: ['q'],
              },
            },
          },
        },
        responses: {},
      },
    },
  },
} as const;
type OptionalBodyRoutes = InferRoutesFromSpec<typeof optionalBodySpec>;
export type T_optionalBodySlot_acceptsUndefined = Verify<
  undefined extends OptionalBodyRoutes['/search']['POST']['body'] ? true : false
>;
export type T_optionalBodySlot_typed = Verify<Equal<
  InferSchema<NonNullable<OptionalBodyRoutes['/search']['POST']['body']>>,
  { q: string }
>>;

// `default` is the error catch-all at the type level too: no success slot,
// errorResponse typed from the default schema.
const defaultOnlySpec = {
  paths: {
    '/health': {
      get: {
        responses: {
          default: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { message: { type: 'string' } },
                  required: ['message'],
                },
              },
            },
          },
        },
      },
    },
  },
} as const;
type DefaultOnlyRoutes = InferRoutesFromSpec<typeof defaultOnlySpec>;
export type T_defaultOnly_noResponse = Verify<Equal<
  DefaultOnlyRoutes['/health']['GET']['response'],
  undefined
>>;
export type T_defaultOnly_error = Verify<Equal<
  InferSchema<NonNullable<DefaultOnlyRoutes['/health']['GET']['errorResponse']>>,
  { message: string }
>>;

// Wildcard '2XX' keys and `+json` media types are matched at the type level
// (parity with the runtime extractor).
const wideSpec = {
  paths: {
    '/wide': {
      get: {
        responses: {
          '2XX': {
            content: {
              'application/json; charset=utf-8': {
                schema: {
                  type: 'object',
                  properties: { ok: { type: 'boolean' } },
                  required: ['ok'],
                },
              },
            },
          },
          '400': {
            content: {
              'application/problem+json': {
                schema: {
                  type: 'object',
                  properties: { title: { type: 'string' } },
                  required: ['title'],
                },
              },
            },
          },
        },
      },
    },
  },
} as const;
type WideRoutes = InferRoutesFromSpec<typeof wideSpec>;
export type T_wildcard2xx = Verify<Equal<
  InferSchema<NonNullable<WideRoutes['/wide']['GET']['response']>>,
  { ok: boolean }
>>;
export type T_problemJson = Verify<Equal<
  InferSchema<NonNullable<WideRoutes['/wide']['GET']['errorResponse']>>,
  { title: string }
>>;

// ---------------------------------------------------------------------------
// Operation-level $ref requestBody resolves at the TYPE level too (review
// follow-up): a required $ref'd body must make the body slot required, so a
// call without options fails to compile instead of failing at runtime.
// ---------------------------------------------------------------------------
const refBodySpec = {
  components: {
    requestBodies: {
      CreatePet: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: { name: { type: 'string' } },
              required: ['name'],
            },
          },
        },
      },
    },
  },
  paths: {
    '/pets': {
      post: {
        requestBody: { $ref: '#/components/requestBodies/CreatePet' },
        responses: {
          201: {
            content: {
              'application/json': {
                schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
              },
            },
          },
        },
      },
    },
  },
} as const;
type RefBodyRoutes = InferRoutesFromSpec<typeof refBodySpec>;
export type T_refBodyTyped = Verify<Equal<
  InferSchema<RefBodyRoutes['/pets']['POST']['body']>,
  { name: string }
>>;

{
  const f = createFetch({ baseUrl: 'https://x', routes: {} as RefBodyRoutes });
  // @ts-expect-error — the $ref'd requestBody is required: true, so the
  // shortcut must demand an options argument with a body.
  void f.post('/pets');
  void f.post('/pets', { body: { name: 'Rex' } });
}
