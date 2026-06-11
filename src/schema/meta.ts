/**
 * Meta helpers — `brand` (type-level nominal typing, runtime passthrough)
 * and `describe`/`title` (attach JSON Schema annotations without altering
 * the validator).
 *
 * @module
 */

import type { FSchema, Infer } from './types.ts';

/** Type-level-only unique symbol carrying the brand tag. Never exists at runtime. */
export declare const BRAND: unique symbol;

/**
 * Nominal-typing helper: `Brand<number, 'UserId'>` is a `number` that does
 * not assign to `Brand<number, 'OrderId'>`. Produced by {@link brand}.
 */
export type Brand<T, B extends string> = T & { readonly [BRAND]: B };

/**
 * Type-level nominal brand. Runtime is an identity passthrough — the
 * underlying `~standard.validate` is unchanged. Use to distinguish types
 * that share the same wire shape but should not mix (e.g. `UserId` vs
 * `OrderId`, both numbers).
 *
 * @example
 * ```ts
 * const UserId = brand<'UserId'>()(integer());
 * type UserId = Infer<typeof UserId>;  // number & { readonly [BRAND]: 'UserId' }
 * ```
 */
/* @__NO_SIDE_EFFECTS__ */
export function brand<B extends string>(): <S extends FSchema<unknown>>(schema: S) => FSchema<Brand<Infer<S>, B>> {
  return <S extends FSchema<unknown>>(schema: S): FSchema<Brand<Infer<S>, B>> =>
    schema as unknown as FSchema<Brand<Infer<S>, B>>;
}

/**
 * Attaches a JSON Schema `description` annotation. Returns a new schema
 * object sharing the same `~standard` (so validation is identical). The
 * original schema stays reachable via the internal `~inner` link, so
 * annotating a `ref()` before `compile()` does not break ref binding.
 */
/* @__NO_SIDE_EFFECTS__ */
export function describe<S extends FSchema<unknown>>(
  schema: S,
  description: string,
): S {
  return { ...schema, 'description': description, '~inner': schema } as S;
}

/**
 * Attaches a JSON Schema `title` annotation. Returns a new schema object
 * sharing the same `~standard` (so validation is identical); like
 * {@link describe}, the original schema stays reachable via `~inner` so
 * `compile()` can still bind an annotated `ref()`.
 */
/* @__NO_SIDE_EFFECTS__ */
export function title<S extends FSchema<unknown>>(
  schema: S,
  title: string,
): S {
  return { ...schema, title, '~inner': schema } as S;
}
