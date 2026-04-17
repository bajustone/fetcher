/**
 * Meta helpers — `brand` (type-level nominal typing, runtime passthrough)
 * and `describe`/`title` (attach JSON Schema annotations without altering
 * the validator).
 *
 * @module
 */

import type { FSchema, Infer } from './types.ts';

export declare const BRAND: unique symbol;

export type Brand<T, B extends string> = T & { readonly [BRAND]: B };

/**
 * Type-level nominal brand. Runtime is an identity passthrough — the
 * underlying `~standard.validate` is unchanged. Use to distinguish types
 * that share the same wire shape but should not mix (e.g. `UserId` vs
 * `OrderId`, both numbers).
 *
 * @example
 * ```ts
 * const UserId = brand<'UserId'>(integer());
 * type UserId = Infer<typeof UserId>;  // number & { readonly [BRAND]: 'UserId' }
 * ```
 */
/* @__NO_SIDE_EFFECTS__ */
export function brand<B extends string>() {
  return <S extends FSchema<unknown>>(schema: S): FSchema<Brand<Infer<S>, B>> =>
    schema as unknown as FSchema<Brand<Infer<S>, B>>;
}

/**
 * Attaches a JSON Schema `description` annotation. Returns a new schema
 * object sharing the same `~standard` (so validation is identical).
 */
/* @__NO_SIDE_EFFECTS__ */
export function describe<S extends FSchema<unknown>>(
  schema: S,
  description: string,
): S {
  return { ...schema, description } as S;
}

/**
 * Attaches a JSON Schema `title` annotation.
 */
/* @__NO_SIDE_EFFECTS__ */
export function title<S extends FSchema<unknown>>(
  schema: S,
  title: string,
): S {
  return { ...schema, title } as S;
}
