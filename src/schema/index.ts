/**
 * Native schema builder for `@bajustone/fetcher`.
 *
 * Each factory produces a plain JSON Schema object augmented with a
 * pre-compiled `~standard.validate` closure. Schemas drop directly into
 * `RouteDefinition` slots (body, params, query, response, errorResponse)
 * because `FSchema<T>` structurally satisfies `StandardSchemaV1<unknown, T>`.
 *
 * Import only what you use — every factory is marked
 * `/*\@\_\_NO\_SIDE\_EFFECTS\_\_* /` so a bundler can eliminate unused ones.
 *
 * @example
 * ```ts
 * import { object, integer, string, optional, email } from '@bajustone/fetcher/schema';
 * import type { Infer } from '@bajustone/fetcher/schema';
 *
 * const Pet = object({
 *   id:    integer(),
 *   name:  string({ minLength: 1 }),
 *   email: email(),
 *   tag:   optional(string()),
 * });
 *
 * type Pet = Infer<typeof Pet>;
 * // { id: number; name: string; email: string; tag?: string }
 * ```
 *
 * @module
 */

export {
  array,
  enum_,
  intersect,
  nullable,
  object,
  optional,
  union,
} from './composites.ts';

export { discriminatedUnion } from './discriminated.ts';

export { date, datetime, email, time, url, uuid } from './formats.ts';

export {
  boolean,
  integer,
  literal,
  null_,
  number,
  string,
  unknown,
} from './primitives.ts';

export { compile, ref } from './refs.ts';

export type {
  ArrayOptions,
  FArray,
  FBoolean,
  FDiscriminatedUnion,
  FEnum,
  FInteger,
  FIntersect,
  FLiteral,
  FNull,
  FNumber,
  FObject,
  FObjectOutput,
  FOptionalWrapper,
  FProperties,
  FRef,
  FSchema,
  FString,
  FUnion,
  FUnknown,
  Infer,
  NumberOptions,
  ObjectOptions,
  StringOptions,
} from './types.ts';
