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
  ObjectOptions,
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

/**
 * Throws when `schema` is a `refined`/`transform`/`default_` wrapper.
 * Wrappers copy the inner object's JSON metadata (`type`, `properties`)
 * onto themselves, so the structural guard in {@link rebuildProps} cannot
 * catch them — yet rebuilding from the bare `properties` would silently
 * drop the wrapper's predicate/transform (and the `~defaults` channel,
 * which the wrapper's metadata copy strips). Wrappers are detected via
 * their `~inner` link; `describe`/`title` annotations also carry `~inner`
 * but share the inner schema's `~standard` **by reference** (validation is
 * identical), so the walk descends through them instead of throwing.
 */
function assertNotWrapper(schema: FObject<FProperties>): void {
  let node = schema as unknown as Record<string, unknown>;
  let inner = node['~inner'] as Record<string, unknown> | undefined;
  while (inner !== undefined && typeof inner === 'object') {
    if (inner['~standard'] !== node['~standard']) {
      throw new TypeError(
        'Cannot compose a refined/transform/default_-wrapped object schema: the wrapper\'s behavior would be silently dropped. Compose the base object() first, then re-apply the wrapper.',
      );
    }
    node = inner;
    inner = node['~inner'] as Record<string, unknown> | undefined;
  }
}

/**
 * Rebuilds the `FProperties` shape from a compiled `FObject`.
 *
 * @throws TypeError when `schema` is not structurally an object schema
 * (e.g. a union, a record, or a non-builder Standard Schema), or when it is
 * a `refined`/`transform`/`default_` wrapper over an object (see
 * {@link assertNotWrapper}). Without the guards, composition would silently
 * produce a schema missing the base's validation behavior.
 */
function rebuildProps(schema: FObject<FProperties>): FProperties {
  const s = schema as unknown as { type?: unknown; properties?: unknown } | null;
  if (s === null || typeof s !== 'object' || s.type !== 'object' || s.properties === null || typeof s.properties !== 'object') {
    throw new TypeError(
      'Expected an object schema: the base must be built by object() (type "object" with properties). Unions, records, transforms, and non-builder schemas cannot be composed this way.',
    );
  }
  assertNotWrapper(schema);
  const requiredSet = new Set(schema.required);
  const defaults = schema['~defaults'];
  const optionals = schema['~optionals'];
  // Null-prototype accumulator: a property key literally named '__proto__'
  // must stay an ordinary own entry.
  const out: Record<string, FProperties[string]> = Object.create(null) as Record<string, FProperties[string]>;
  for (const key of Object.keys(schema.properties)) {
    // Preserve the original `default_` wrapper — `properties` only holds the
    // unwrapped inner schema, so without this defaults silently degrade to
    // plain optionals through composition (issue #10).
    if (defaults && Object.hasOwn(defaults, key)) {
      out[key] = defaults[key]!;
      continue;
    }
    // Likewise preserve a refined/transform wrapper over an optional() —
    // rebuilding as optional(inner) would silently drop the predicate or
    // transform.
    if (optionals && Object.hasOwn(optionals, key)) {
      out[key] = optionals[key]!;
      continue;
    }
    const inner = schema.properties[key]!;
    out[key] = requiredSet.has(key) ? inner : optional(inner);
  }
  return out as FProperties;
}

/**
 * Extracts the unknown-key policy an object schema was built with, as an
 * options bag ready to pass back into `object()`. Composition helpers use
 * this so a `'strict'`/`'strip'` base does not silently reset to
 * `'passthrough'` when rebuilt.
 */
function basePolicy(schema: FObject<FProperties>): ObjectOptions {
  const policy = (schema as unknown as { '~unknownKeys'?: 'strip' | 'strict' })['~unknownKeys'];
  return policy === undefined ? {} : { unknownKeys: policy };
}

function isOptional(
  entry: FSchema<unknown> | FOptionalWrapper<FSchema<unknown>>,
): entry is FOptionalWrapper<FSchema<unknown>> {
  return (entry as FOptionalWrapper<FSchema<unknown>>)['~optional'] === true;
}

/**
 * Returns a copy of an object schema with every key made optional (Zod's
 * `.partial()`). The base's `unknownKeys` policy is preserved.
 */
/* @__NO_SIDE_EFFECTS__ */
export function partial<T extends FProperties>(
  schema: FObject<T>,
): FObject<PartialProps<T>> {
  const src = rebuildProps(schema as unknown as FObject<FProperties>);
  const out: Record<string, FSchema<unknown> | FOptionalWrapper<FSchema<unknown>>> = Object.create(null) as Record<string, FSchema<unknown> | FOptionalWrapper<FSchema<unknown>>>;
  for (const key of Object.keys(src)) {
    const entry = src[key]!;
    out[key] = isOptional(entry) ? entry : optional(entry);
  }
  return object(out as FProperties, basePolicy(schema as unknown as FObject<FProperties>)) as unknown as FObject<PartialProps<T>>;
}

/**
 * Returns a copy of an object schema with every optional key made required
 * (unwraps `optional()`). The base's `unknownKeys` policy is preserved.
 *
 * @throws TypeError when an optional key carries a `refined`/`transform`
 * wrapper — unwrapping it would silently drop the predicate/transform.
 * Apply `required()` to the base object and re-apply the wrapper instead.
 */
/* @__NO_SIDE_EFFECTS__ */
export function required<T extends FProperties>(
  schema: FObject<T>,
): FObject<RequiredProps<T>> {
  const src = rebuildProps(schema as unknown as FObject<FProperties>);
  const out: Record<string, FSchema<unknown>> = Object.create(null) as Record<string, FSchema<unknown>>;
  for (const key of Object.keys(src)) {
    const entry = src[key]!;
    if (isOptional(entry) && Object.hasOwn(entry, '~inner')) {
      throw new TypeError(
        `Cannot make key "${key}" required: it is a refined/transform wrapper over optional(), and unwrapping would silently drop the wrapper. Apply required() to the base object and re-apply the wrapper.`,
      );
    }
    out[key] = isOptional(entry) ? entry['~wrapped'] : entry;
  }
  return object(out as FProperties, basePolicy(schema as unknown as FObject<FProperties>)) as unknown as FObject<RequiredProps<T>>;
}

/**
 * Returns a copy of an object schema containing only the listed keys.
 * The base's `unknownKeys` policy is preserved.
 */
/* @__NO_SIDE_EFFECTS__ */
export function pick<T extends FProperties, K extends keyof T & string>(
  schema: FObject<T>,
  keys: readonly K[],
): FObject<Pick<T, K>> {
  const src = rebuildProps(schema as unknown as FObject<FProperties>);
  const out: Record<string, FSchema<unknown> | FOptionalWrapper<FSchema<unknown>>> = Object.create(null) as Record<string, FSchema<unknown> | FOptionalWrapper<FSchema<unknown>>>;
  for (const key of keys) {
    if (Object.hasOwn(src, key))
      out[key] = src[key]!;
  }
  return object(out as FProperties, basePolicy(schema as unknown as FObject<FProperties>)) as unknown as FObject<Pick<T, K>>;
}

/**
 * Returns a copy of an object schema without the listed keys.
 * The base's `unknownKeys` policy is preserved.
 */
/* @__NO_SIDE_EFFECTS__ */
export function omit<T extends FProperties, K extends keyof T & string>(
  schema: FObject<T>,
  keys: readonly K[],
): FObject<Omit<T, K>> {
  const src = rebuildProps(schema as unknown as FObject<FProperties>);
  const drop = new Set<string>(keys);
  const out: Record<string, FSchema<unknown> | FOptionalWrapper<FSchema<unknown>>> = Object.create(null) as Record<string, FSchema<unknown> | FOptionalWrapper<FSchema<unknown>>>;
  for (const key of Object.keys(src)) {
    if (!drop.has(key))
      out[key] = src[key]!;
  }
  return object(out as FProperties, basePolicy(schema as unknown as FObject<FProperties>)) as unknown as FObject<Omit<T, K>>;
}

/**
 * Returns a copy of an object schema with extra properties added (extras win
 * on key collisions). The base's `unknownKeys` policy is preserved.
 */
/* @__NO_SIDE_EFFECTS__ */
export function extend<T extends FProperties, E extends FProperties>(
  schema: FObject<T>,
  extras: E,
): FObject<Omit<T, keyof E> & E> {
  const src = rebuildProps(schema as unknown as FObject<FProperties>);
  const out: Record<string, FSchema<unknown> | FOptionalWrapper<FSchema<unknown>>>
    = { ...src, ...(extras as Record<string, FSchema<unknown> | FOptionalWrapper<FSchema<unknown>>>) };
  return object(out as FProperties, basePolicy(schema as unknown as FObject<FProperties>)) as unknown as FObject<Omit<T, keyof E> & E>;
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
 * to {@link extend} — same property merging, same required-list rebuild,
 * same `unknownKeys` preservation.
 *
 * Prefer {@link extend} when the base is a locally-defined `FObject<Props>`;
 * reach for `extendSchema` when the base is an opaque validator.
 *
 * @throws TypeError when the base is not structurally an object schema
 * (e.g. a union, a refined/transform-wrapped schema, or a non-builder
 * schema) — base validation would otherwise be silently dropped.
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

/**
 * Combines two object schemas into one (the second schema's keys win on
 * collisions). The **second** schema's `unknownKeys` policy wins outright —
 * the same convention as the key collisions (and Zod's `.merge()`): merging
 * a strict `a` with a passthrough `b` yields a passthrough schema. Build `b`
 * with the desired policy (or wrap the result) when that is not what you
 * want.
 */
/* @__NO_SIDE_EFFECTS__ */
export function merge<A extends FProperties, B extends FProperties>(
  a: FObject<A>,
  b: FObject<B>,
): FObject<Omit<A, keyof B> & B> {
  const srcA = rebuildProps(a as unknown as FObject<FProperties>);
  const srcB = rebuildProps(b as unknown as FObject<FProperties>);
  const out = { ...srcA, ...srcB };
  return object(out as FProperties, basePolicy(b as unknown as FObject<FProperties>)) as unknown as FObject<Omit<A, keyof B> & B>;
}

/**
 * Enum schema of an object schema's property names (Zod's `.keyof()`).
 * Trailing underscore because `keyof` is a TS reserved word — the builder's
 * naming convention for colliding factory names.
 */
/* @__NO_SIDE_EFFECTS__ */
export function keyof_<T extends FProperties>(
  schema: FObject<T>,
): FEnum<keyof T & string> {
  return enum_(Object.keys(schema.properties) as (keyof T & string)[]);
}
