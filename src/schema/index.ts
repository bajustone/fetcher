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

export {
  extend,
  keyof_,
  merge,
  omit,
  partial,
  pick,
  required,
} from './composition.ts';

export { discriminatedUnion } from './discriminated.ts';

export { formatIssues } from './format-issues.ts';

export type { FormatIssuesOptions } from './format-issues.ts';

export { date, datetime, email, time, url, uuid } from './formats.ts';

export { brand, describe, title } from './meta.ts';

export type { Brand } from './meta.ts';

export {
  any_,
  bigint_,
  boolean,
  finite,
  integer,
  literal,
  negative,
  never_,
  nonnegative,
  nonpositive,
  null_,
  number,
  positive,
  safe,
  string,
  undefined_,
  unknown,
} from './primitives.ts';

export { record, tuple } from './record-tuple.ts';

export type { FRecord, FTuple } from './record-tuple.ts';

export { default_, refined } from './refinements.ts';

export { compile, ref } from './refs.ts';

export type {
  ArrayOptions,
  FAny,
  FArray,
  FBigInt,
  FBoolean,
  FDefaultWrapper,
  FDiscriminatedUnion,
  FEnum,
  FInteger,
  FIntersect,
  FLiteral,
  FNever,
  FNull,
  FNumber,
  FObject,
  FObjectOutput,
  FOptionalWrapper,
  FProperties,
  FRef,
  FSchema,
  FString,
  FUndefined,
  FUnion,
  FUnknown,
  Infer,
  NumberOptions,
  ObjectOptions,
  StringOptions,
} from './types.ts';
