/**
 * Type-level tests for `@bajustone/fetcher/schema` — verifies that `Infer<T>`
 * extracts the correct TypeScript shape for every builder primitive, that
 * `object()` splits required vs optional keys via the `FOptionalWrapper`
 * marker, and that builder schemas drop into `RouteDefinition` without
 * casts.
 *
 * Uses the zero-dependency Equal/Verify pattern shared with the other
 * type-test fixtures. tsc compiles this file as part of `bun typecheck`;
 * any failure surfaces as a TS error.
 */
/* eslint-disable unused-imports/no-unused-vars, ts/explicit-function-return-type */

import type { FSchema, Infer } from '../../src/schema/index.ts';
import type { Schema, StandardSchemaV1 } from '../../src/types.ts';
import { createFetch } from '../../src/fetcher.ts';
import {
  array,
  boolean,
  compile,
  discriminatedUnion,
  enum_,
  integer,
  intersect,
  literal,
  null_,
  nullable,
  number,
  object,
  optional,
  ref,
  string,
  union,
  unknown,
} from '../../src/schema/index.ts';

// ---------------------------------------------------------------------------
// Equal / Verify helpers
// ---------------------------------------------------------------------------

type Equal<X, Y>
  = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2)
    ? true
    : false;

export type Verify<T extends true> = T;

// ---------------------------------------------------------------------------
// Primitives — Infer<typeof X> should resolve to the exact type
// ---------------------------------------------------------------------------

const S_string = string();
const S_number = number();
const S_integer = integer();
const S_boolean = boolean();
const S_null = null_();
const S_literal_a = literal('a' as const);
const S_literal_42 = literal(42 as const);
const S_literal_true = literal(true as const);
const S_unknown = unknown();

export type T_string = Verify<Equal<Infer<typeof S_string>, string>>;
export type T_number = Verify<Equal<Infer<typeof S_number>, number>>;
export type T_integer = Verify<Equal<Infer<typeof S_integer>, number>>;
export type T_boolean = Verify<Equal<Infer<typeof S_boolean>, boolean>>;
export type T_null = Verify<Equal<Infer<typeof S_null>, null>>;
export type T_literal_a = Verify<Equal<Infer<typeof S_literal_a>, 'a'>>;
export type T_literal_42 = Verify<Equal<Infer<typeof S_literal_42>, 42>>;
export type T_literal_true = Verify<Equal<Infer<typeof S_literal_true>, true>>;
export type T_unknown = Verify<Equal<Infer<typeof S_unknown>, unknown>>;

// ---------------------------------------------------------------------------
// Object — required vs optional key derivation
// ---------------------------------------------------------------------------

const S_pet = object({
  id: integer(),
  name: string(),
  tag: optional(string()),
  bio: optional(string()),
});

type Pet = Infer<typeof S_pet>;
// Expected: { id: number; name: string; tag?: string; bio?: string }

export type T_pet_required_id = Verify<Equal<Pet['id'], number>>;
export type T_pet_required_name = Verify<Equal<Pet['name'], string>>;
export type T_pet_optional_tag = Verify<Equal<Pet['tag'], string | undefined>>;
export type T_pet_optional_bio = Verify<Equal<Pet['bio'], string | undefined>>;

// `tag?:` key must be structurally optional (assignable without the key).
export function _petWithoutOptional(): Pet {
  return { id: 1, name: 'Rex' };
}

// ---------------------------------------------------------------------------
// Array
// ---------------------------------------------------------------------------

const S_ids = array(integer());
const S_matrix = array(array(number()));

export type T_ids = Verify<Equal<Infer<typeof S_ids>, number[]>>;
export type T_matrix = Verify<Equal<Infer<typeof S_matrix>, number[][]>>;

// ---------------------------------------------------------------------------
// Nullable — `T | null`
// ---------------------------------------------------------------------------

const S_maybe = nullable(integer());
export type T_maybe = Verify<Equal<Infer<typeof S_maybe>, number | null>>;

// ---------------------------------------------------------------------------
// Union
// ---------------------------------------------------------------------------

const S_strOrNum = union([string(), integer()]);
export type T_strOrNum = Verify<Equal<Infer<typeof S_strOrNum>, string | number>>;

// ---------------------------------------------------------------------------
// Intersect
// ---------------------------------------------------------------------------

const S_withId = object({ id: integer() });
const S_withName = object({ name: string() });
const S_combined = intersect([S_withId, S_withName]);
type Combined = Infer<typeof S_combined>;
// Expected: { id: number } & { name: string }  — accessible as both
export type T_combined_id = Verify<Equal<Combined['id'], number>>;
export type T_combined_name = Verify<Equal<Combined['name'], string>>;

// ---------------------------------------------------------------------------
// Enum
// ---------------------------------------------------------------------------

const S_color = enum_(['red', 'green', 'blue'] as const);
export type T_color = Verify<Equal<Infer<typeof S_color>, 'red' | 'green' | 'blue'>>;

// ---------------------------------------------------------------------------
// Discriminated union — one-of-the-variants
// ---------------------------------------------------------------------------

const S_shape = discriminatedUnion('kind', {
  circle: object({ kind: literal('circle' as const), radius: number() }),
  square: object({ kind: literal('square' as const), side: number() }),
});
type Shape = Infer<typeof S_shape>;
// Expected: { kind: 'circle'; radius: number } | { kind: 'square'; side: number }

export function _shapeCircle(): Shape {
  return { kind: 'circle', radius: 1 };
}
export function _shapeSquare(): Shape {
  return { kind: 'square', side: 2 };
}

// Narrowing via the tag should work
export function tagNarrow(s: Shape): number {
  if (s.kind === 'circle')
    return s.radius;
  return s.side;
}
export type T_shape_narrow = Verify<Equal<ReturnType<typeof tagNarrow>, number>>;

// ---------------------------------------------------------------------------
// Ref — typed via the generic parameter
// ---------------------------------------------------------------------------

interface TreeNode { value: number; children: TreeNode[] }
const S_tree = object({
  value: number(),
  children: array(ref<TreeNode>('Tree')),
});
compile(S_tree, { Tree: S_tree });
type Tree = Infer<typeof S_tree>;
export type T_tree_value = Verify<Equal<Tree['value'], number>>;

// ---------------------------------------------------------------------------
// FSchema assignability — builder output satisfies StandardSchemaV1 and Schema
// ---------------------------------------------------------------------------

export function _asStandard(): StandardSchemaV1<unknown, string> {
  return string();
}
export function _asSchema(): Schema<number> {
  return integer();
}
export function _asFSchema(): FSchema<boolean> {
  return boolean();
}

// Drop-in to RouteDefinition
export function _routeBuilt() {
  return createFetch({
    baseUrl: 'https://api.example.com',
    routes: {
      '/pets/{id}': {
        GET: { response: S_pet, params: object({ id: string() }) },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Nested object with nested optional — inference through multiple layers
// ---------------------------------------------------------------------------

const S_user = object({
  id: integer(),
  profile: object({
    name: string(),
    bio: optional(string()),
  }),
});
type User = Infer<typeof S_user>;
export type T_user_id = Verify<Equal<User['id'], number>>;
export type T_user_profile_name = Verify<Equal<User['profile']['name'], string>>;
export type T_user_profile_bio = Verify<Equal<User['profile']['bio'], string | undefined>>;
