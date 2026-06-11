/**
 * Type infrastructure for the native schema builder.
 *
 * Every factory in this subpath returns an object satisfying both the
 * Standard Schema V1 contract (via `~standard`) and the plain JSON Schema
 * 2020-12 shape for its type (via `type`, `properties`, `items`, etc.). The
 * TypeScript inference for {@link Infer} flows through the `Output` generic
 * of {@link StandardSchemaV1} — no phantom `~types` field is needed.
 *
 * @module
 */

import type { StandardSchemaV1 } from '../types.ts';

/**
 * Base shape of every builder-produced schema. Extends Standard Schema V1
 * so the schema drops directly into `RouteDefinition`, and carries enough
 * structural information for other consumers (inline, OpenAPI tooling) to
 * read the schema as plain JSON Schema.
 */
export interface FSchema<T> extends StandardSchemaV1<unknown, T> {}

/**
 * Extracts the validated output type from a builder schema.
 * `Infer<typeof Pet>` resolves to whatever `Pet` validates to.
 */
export type Infer<T> = T extends StandardSchemaV1<unknown, infer O> ? O : never;

/**
 * Wrapper marker returned by {@link optional} that is unwrapped inside
 * {@link object}. The `~optional`/`~wrapped` fields are internal — they
 * never appear in emitted JSON Schema output.
 */
export interface FOptionalWrapper<T extends FSchema<unknown>>
  extends FSchema<Infer<T> | undefined> {
  /** Internal marker consumed by `object()` — excludes the key from `required`. */
  readonly '~optional': true;
  /** The wrapped inner schema (what gets emitted as the property's JSON Schema). */
  readonly '~wrapped': T;
}

/**
 * Wrapper marker returned by {@link default_}. Differs from
 * {@link FOptionalWrapper} in that missing / undefined input substitutes a
 * fallback, so the inferred output type is the base type (not `| undefined`)
 * and the key is required in the object output.
 */
export interface FDefaultWrapper<T extends FSchema<unknown>> extends FSchema<Infer<T>> {
  /** Internal marker consumed by `object()` — missing keys substitute the fallback. */
  readonly '~default': true;
  /**
   * Static snapshot of the fallback. Absent when the fallback is a factory
   * function (a per-use value has no meaningful static representation).
   */
  readonly '~fallback'?: Infer<T>;
  /** The wrapped inner schema (what gets emitted as the property's JSON Schema). */
  readonly '~wrapped': T;
}

/**
 * Property bag accepted by {@link object}: each value is a plain schema
 * (required key), an {@link FOptionalWrapper} (optional key), or an
 * {@link FDefaultWrapper} (missing key substitutes a fallback).
 */
export type FProperties = Record<
  string,
  FSchema<unknown> | FOptionalWrapper<FSchema<unknown>> | FDefaultWrapper<FSchema<unknown>>
>;

/**
 * Splits object properties into required (no wrapper) and optional (wrapped
 * in {@link FOptionalWrapper}), producing the correct TypeScript object type.
 */
export type FObjectOutput<T extends FProperties>
  = & { [K in keyof T as T[K] extends FOptionalWrapper<FSchema<unknown>> ? K : never]?:
    T[K] extends FOptionalWrapper<infer S extends FSchema<unknown>> ? Infer<S> : never }
    & { [K in keyof T as T[K] extends FOptionalWrapper<FSchema<unknown>> ? never : K]:
      T[K] extends FSchema<unknown> ? Infer<T[K]> : never };

// ---------------------------------------------------------------------------
// Options interfaces — deliberately narrower than JSON Schema itself.
// Keywords not enforced by the runtime are absent from these types, so they
// are inexpressible at the call site.
// ---------------------------------------------------------------------------

/** Constraint options accepted by the `string()` factory. */
export interface StringOptions {
  /** Minimum length, counted in Unicode code points (JSON Schema semantics). */
  minLength?: number;
  /** Maximum length, counted in Unicode code points (JSON Schema semantics). */
  maxLength?: number;
  /** Exact length — shorthand for `minLength === maxLength`. */
  length?: number;
  /** ECMA-262 regex source the string must match (also emitted as `pattern`). */
  pattern?: string;
  /** Required prefix. Non-standard — enforced at validation time, not emitted. */
  startsWith?: string;
  /** Required suffix. Non-standard — enforced at validation time, not emitted. */
  endsWith?: string;
  /** Required substring. Non-standard — enforced at validation time, not emitted. */
  includes?: string;
}

/** Constraint options accepted by the `number()` and `integer()` factories. */
export interface NumberOptions {
  /** Inclusive lower bound. */
  minimum?: number;
  /** Inclusive upper bound. */
  maximum?: number;
  /** Exclusive lower bound. */
  exclusiveMinimum?: number;
  /** Exclusive upper bound. */
  exclusiveMaximum?: number;
  /** Value must be an exact multiple of this number. */
  multipleOf?: number;
}

/** Constraint options accepted by the `array()` factory. */
export interface ArrayOptions {
  /** Minimum element count. */
  minItems?: number;
  /** Maximum element count. */
  maxItems?: number;
}

/** Options accepted by the `object()` factory. */
export interface ObjectOptions {
  /** Emitted as the schema's `$id` (useful for `$ref` targets and tooling). */
  $id?: string;
  /**
   * Unknown-key policy for keys not declared in the shape:
   *
   * - `'passthrough'` (default) — unknown keys are left untouched and, when
   *   no member transforms fire, the output **aliases the input object**
   *   (zero-copy). This is the JSON-Schema-conformant behavior
   *   (`additionalProperties` defaults to true).
   * - `'strip'` — the output is a new object containing only declared keys.
   * - `'strict'` — each unknown key produces an issue (code `unknown_key`);
   *   the emitted JSON Schema gains `additionalProperties: false`.
   */
  unknownKeys?: 'passthrough' | 'strip' | 'strict';
}

// ---------------------------------------------------------------------------
// Primitive schema interfaces
// ---------------------------------------------------------------------------

/** Schema produced by `string()` and the format helpers (`email()`, `uuid()`, …). */
export interface FString extends FSchema<string> {
  /** JSON Schema type keyword. */
  readonly type: 'string';
  /** Minimum length in Unicode code points, when constrained. */
  readonly minLength?: number;
  /** Maximum length in Unicode code points, when constrained. */
  readonly maxLength?: number;
  /** ECMA-262 regex source the value must match, when constrained. */
  readonly pattern?: string;
  /** Semantic format name (`'email'`, `'uuid'`, …) set by the format helpers. */
  readonly format?: string;
}

/** Schema produced by `number()` and its convenience wrappers (`positive()`, …). */
export interface FNumber extends FSchema<number> {
  /** JSON Schema type keyword. */
  readonly type: 'number';
  /** Inclusive lower bound, when constrained. */
  readonly minimum?: number;
  /** Inclusive upper bound, when constrained. */
  readonly maximum?: number;
  /** Exclusive lower bound, when constrained. */
  readonly exclusiveMinimum?: number;
  /** Exclusive upper bound, when constrained. */
  readonly exclusiveMaximum?: number;
  /** Exact-multiple constraint, when set. */
  readonly multipleOf?: number;
}

/** Schema produced by `integer()` — like {@link FNumber} but rejects non-integers. */
export interface FInteger extends FSchema<number> {
  /** JSON Schema type keyword. */
  readonly type: 'integer';
  /** Inclusive lower bound, when constrained. */
  readonly minimum?: number;
  /** Inclusive upper bound, when constrained. */
  readonly maximum?: number;
  /** Exclusive lower bound, when constrained. */
  readonly exclusiveMinimum?: number;
  /** Exclusive upper bound, when constrained. */
  readonly exclusiveMaximum?: number;
  /** Exact-multiple constraint, when set. */
  readonly multipleOf?: number;
}

/** Schema produced by `boolean()`. */
export interface FBoolean extends FSchema<boolean> {
  /** JSON Schema type keyword. */
  readonly type: 'boolean';
}

/** Schema produced by `null_()`. */
export interface FNull extends FSchema<null> {
  /** JSON Schema type keyword. */
  readonly type: 'null';
}

/** Schema produced by `unknown()` — accepts any value, typed `unknown`. */
export interface FUnknown extends FSchema<unknown> {}

/** Schema produced by `any_()` — accepts any value, typed `any`. */
export interface FAny extends FSchema<any> {}

/** Schema produced by `never_()` — rejects every value. */
export interface FNever extends FSchema<never> {}

/** Schema produced by `undefined_()` — accepts only `undefined`. */
export interface FUndefined extends FSchema<undefined> {}

/** Schema produced by `bigint_()` — accepts only `bigint` values (not wire-representable in JSON). */
export interface FBigInt extends FSchema<bigint> {}

/** Schema produced by `literal(value)` — accepts exactly one value (emitted as `const`). */
export interface FLiteral<T extends string | number | boolean> extends FSchema<T> {
  /** The single allowed value. */
  readonly const: T;
}

// ---------------------------------------------------------------------------
// Composite schema interfaces
// ---------------------------------------------------------------------------

/** Schema produced by `array(items)`. */
export interface FArray<T extends FSchema<unknown>> extends FSchema<Infer<T>[]> {
  /** JSON Schema type keyword. */
  readonly type: 'array';
  /** Element schema applied to every member. */
  readonly items: T;
  /** Minimum element count, when constrained. */
  readonly minItems?: number;
  /** Maximum element count, when constrained. */
  readonly maxItems?: number;
}

/** Schema produced by `object(props)`. */
export interface FObject<T extends FProperties> extends FSchema<FObjectOutput<T>> {
  /** JSON Schema type keyword. */
  readonly 'type': 'object';
  /** Per-key schemas (optional/default wrappers store their unwrapped inner schema here). */
  readonly 'properties': Record<string, FSchema<unknown>>;
  /** Keys that must be present (non-optional, non-default entries). */
  readonly 'required': readonly string[];
  /** Schema identifier, when supplied via `ObjectOptions.$id`. */
  readonly '$id'?: string;
  /**
   * Emitted only for `unknownKeys: 'strict'`, so the serialized JSON Schema
   * agrees with the runtime's unknown-key rejection.
   */
  readonly 'additionalProperties'?: false;
  /**
   * Default-wrapped fields, keyed by property name. `properties` stores the
   * unwrapped inner schema so emitted JSON Schema stays clean, so the
   * original {@link default_} wrapper would otherwise be lost. Composition
   * helpers (`pick`/`omit`/`merge`/…) consult this to carry defaults through.
   * Internal — never emitted in JSON Schema output.
   */
  readonly '~defaults'?: Record<string, FDefaultWrapper<FSchema<unknown>>>;
  /**
   * Optional-marked fields whose entry is a `refined`/`transform` wrapper
   * over `optional()`, keyed by property name. Like `~defaults`,
   * `properties` only stores the bare inner schema, so without this channel
   * composition helpers would silently drop the wrapper's predicate or
   * transform. Internal — never emitted in JSON Schema output.
   */
  readonly '~optionals'?: Record<string, FOptionalWrapper<FSchema<unknown>>>;
  /**
   * The non-default unknown-key policy the schema was built with (`'strip'`
   * or `'strict'`; absent for `'passthrough'`). Stored so composition
   * helpers rebuild with the same policy instead of silently resetting it.
   * Internal — never emitted in JSON Schema output.
   */
  readonly '~unknownKeys'?: 'strip' | 'strict';
}

/** Schema produced by `union(schemas)` and `nullable(schema)` — emitted as `anyOf`. */
export interface FUnion<T extends readonly FSchema<unknown>[]>
  extends FSchema<Infer<T[number]>> {
  /** The union variants, tried in order at validation time. */
  readonly anyOf: T;
}

type UnionToIntersection<U>
  = (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void ? I : never;

/** Schema produced by `intersect(schemas)` — emitted as `allOf`. */
export interface FIntersect<T extends readonly FSchema<unknown>[]>
  extends FSchema<UnionToIntersection<Infer<T[number]>>> {
  /** The intersection members; the value must satisfy every one. */
  readonly allOf: T;
}

/** Schema produced by `enum_(values)` — a closed value set. */
export interface FEnum<T extends string | number | boolean> extends FSchema<T> {
  /** The allowed values. */
  readonly enum: readonly T[];
}

/** Schema produced by `discriminatedUnion(key, mapping)` — O(1) tagged dispatch. */
export interface FDiscriminatedUnion<
  K extends string,
  M extends Record<string, FSchema<unknown>>,
> extends FSchema<Infer<M[keyof M]>> {
  /** Emitted variants, each constrained on the discriminator tag. */
  readonly oneOf: readonly FSchema<unknown>[];
  /** OpenAPI-style discriminator hint naming the tag property. */
  readonly discriminator: { readonly propertyName: K };
}

/** Schema produced by `ref(name)` — lazy `$ref` bound later by `compile()`. */
export interface FRef<T> extends FSchema<T> {
  /** The emitted JSON Pointer, e.g. `#/$defs/Tree`. */
  readonly $ref: string;
}
