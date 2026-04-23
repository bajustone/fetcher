/**
 * Object composition helpers — `partial`, `required`, `pick`, `omit`,
 * `extend`, `merge`, `keyof_`. Each rebuilds the original `FProperties`
 * shape from an `FObject` by consulting its `required` list, applies the
 * transformation, and produces a fresh `FObject` via `object()`.
 *
 * @module
 */

import type {
  FEnum,
  FObject,
  FObjectOutput,
  FOptionalWrapper,
  FProperties,
  FSchema,
} from './types.ts';
import { enum_, object, optional } from './composites.ts';

type PartialProps<T extends FProperties> = {
  [K in keyof T]: T[K] extends FOptionalWrapper<FSchema<unknown>>
    ? T[K]
    : T[K] extends FSchema<unknown>
      ? FOptionalWrapper<T[K]>
      : never;
};

type RequiredProps<T extends FProperties> = {
  [K in keyof T]: T[K] extends FOptionalWrapper<infer Inner> ? Inner : T[K];
};

function rebuildProps(schema: FObject<FProperties>): FProperties {
  const requiredSet = new Set(schema.required);
  const out: Record<string, FSchema<unknown> | FOptionalWrapper<FSchema<unknown>>> = {};
  for (const key in schema.properties) {
    const inner = schema.properties[key]!;
    out[key] = requiredSet.has(key) ? inner : optional(inner);
  }
  return out as FProperties;
}

function isOptional(
  entry: FSchema<unknown> | FOptionalWrapper<FSchema<unknown>>,
): entry is FOptionalWrapper<FSchema<unknown>> {
  return (entry as FOptionalWrapper<FSchema<unknown>>)['~optional'] === true;
}

/* @__NO_SIDE_EFFECTS__ */
export function partial<T extends FProperties>(
  schema: FObject<T>,
): FObject<PartialProps<T>> {
  const src = rebuildProps(schema as unknown as FObject<FProperties>);
  const out: Record<string, FSchema<unknown> | FOptionalWrapper<FSchema<unknown>>> = {};
  for (const key in src) {
    const entry = src[key]!;
    out[key] = isOptional(entry) ? entry : optional(entry);
  }
  return object(out as FProperties) as unknown as FObject<PartialProps<T>>;
}

/* @__NO_SIDE_EFFECTS__ */
export function required<T extends FProperties>(
  schema: FObject<T>,
): FObject<RequiredProps<T>> {
  const src = rebuildProps(schema as unknown as FObject<FProperties>);
  const out: Record<string, FSchema<unknown>> = {};
  for (const key in src) {
    const entry = src[key]!;
    out[key] = isOptional(entry) ? entry['~wrapped'] : entry;
  }
  return object(out as FProperties) as unknown as FObject<RequiredProps<T>>;
}

/* @__NO_SIDE_EFFECTS__ */
export function pick<T extends FProperties, K extends keyof T & string>(
  schema: FObject<T>,
  keys: readonly K[],
): FObject<Pick<T, K>> {
  const src = rebuildProps(schema as unknown as FObject<FProperties>);
  const out: Record<string, FSchema<unknown> | FOptionalWrapper<FSchema<unknown>>> = {};
  for (const key of keys) {
    if (key in src)
      out[key] = src[key]!;
  }
  return object(out as FProperties) as unknown as FObject<Pick<T, K>>;
}

/* @__NO_SIDE_EFFECTS__ */
export function omit<T extends FProperties, K extends keyof T & string>(
  schema: FObject<T>,
  keys: readonly K[],
): FObject<Omit<T, K>> {
  const src = rebuildProps(schema as unknown as FObject<FProperties>);
  const drop = new Set<string>(keys);
  const out: Record<string, FSchema<unknown> | FOptionalWrapper<FSchema<unknown>>> = {};
  for (const key in src) {
    if (!drop.has(key))
      out[key] = src[key]!;
  }
  return object(out as FProperties) as unknown as FObject<Omit<T, K>>;
}

/* @__NO_SIDE_EFFECTS__ */
export function extend<T extends FProperties, E extends FProperties>(
  schema: FObject<T>,
  extras: E,
): FObject<Omit<T, keyof E> & E> {
  const src = rebuildProps(schema as unknown as FObject<FProperties>);
  const out: Record<string, FSchema<unknown> | FOptionalWrapper<FSchema<unknown>>>
    = { ...src, ...(extras as Record<string, FSchema<unknown> | FOptionalWrapper<FSchema<unknown>>>) };
  return object(out as FProperties) as unknown as FObject<Omit<T, keyof E> & E>;
}

/**
 * Like {@link extend}, but accepts a base whose properties are not statically
 * known at the type level — e.g. a validator produced by `fromJSONSchema` or
 * the `validators.*` entries exported from `virtual:fetcher`. Those are
 * structurally `FObject<FProperties>` at runtime but typed as `FSchema<Base>`,
 * which makes {@link extend} unusable without a cast.
 *
 * `extendSchema` takes the loose input shape and produces an explicit
 * `FSchema<Base & FObjectOutput<Ext>>` output. Runtime behavior is identical
 * to {@link extend} — same property merging, same required-list rebuild.
 *
 * Prefer {@link extend} when the base is a locally-defined `FObject<Props>`;
 * reach for `extendSchema` when the base is an opaque validator.
 *
 * @example
 * ```ts
 * import { validators } from 'virtual:fetcher';
 * import { extendSchema, number } from '@bajustone/fetcher/schema';
 *
 * // validators.CreateUserBody is typed FSchema<CreateUserBody>, not FObject<Props>
 * const withId = extendSchema(validators.CreateUserBody, { id: number() });
 * //    ^? FSchema<CreateUserBody & { id: number }>
 * ```
 */
/* @__NO_SIDE_EFFECTS__ */
export function extendSchema<Base, Ext extends FProperties>(
  base: FSchema<Base>,
  ext: Ext,
): FSchema<Base & FObjectOutput<Ext>> {
  return extend(
    base as unknown as FObject<FProperties>,
    ext,
  ) as unknown as FSchema<Base & FObjectOutput<Ext>>;
}

/* @__NO_SIDE_EFFECTS__ */
export function merge<A extends FProperties, B extends FProperties>(
  a: FObject<A>,
  b: FObject<B>,
): FObject<Omit<A, keyof B> & B> {
  const srcA = rebuildProps(a as unknown as FObject<FProperties>);
  const srcB = rebuildProps(b as unknown as FObject<FProperties>);
  const out = { ...srcA, ...srcB };
  return object(out as FProperties) as unknown as FObject<Omit<A, keyof B> & B>;
}

/* @__NO_SIDE_EFFECTS__ */
export function keyof_<T extends FProperties>(
  schema: FObject<T>,
): FEnum<keyof T & string> {
  return enum_(Object.keys(schema.properties) as (keyof T & string)[]);
}
