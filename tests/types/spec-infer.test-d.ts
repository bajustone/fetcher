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
/* eslint-disable unused-imports/no-unused-vars */

import type { InferRoutesFromSpec, InferSchema, JSONSchemaToType } from '../../src/index.ts';

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
