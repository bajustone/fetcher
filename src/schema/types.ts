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
  readonly '~optional': true;
  readonly '~wrapped': T;
}

/**
 * Wrapper marker returned by {@link default_}. Differs from
 * {@link FOptionalWrapper} in that missing / undefined input substitutes a
 * fallback, so the inferred output type is the base type (not `| undefined`)
 * and the key is required in the object output.
 */
export interface FDefaultWrapper<T extends FSchema<unknown>> extends FSchema<Infer<T>> {
  readonly '~default': true;
  readonly '~fallback': Infer<T>;
  readonly '~wrapped': T;
}

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

export interface StringOptions {
  minLength?: number;
  maxLength?: number;
  length?: number;
  pattern?: string;
  startsWith?: string;
  endsWith?: string;
  includes?: string;
}

export interface NumberOptions {
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
}

export interface ArrayOptions {
  minItems?: number;
  maxItems?: number;
}

export interface ObjectOptions {
  $id?: string;
}

// ---------------------------------------------------------------------------
// Primitive schema interfaces
// ---------------------------------------------------------------------------

export interface FString extends FSchema<string> {
  readonly type: 'string';
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly format?: string;
}

export interface FNumber extends FSchema<number> {
  readonly type: 'number';
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly exclusiveMaximum?: number;
  readonly multipleOf?: number;
}

export interface FInteger extends FSchema<number> {
  readonly type: 'integer';
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly exclusiveMaximum?: number;
  readonly multipleOf?: number;
}

export interface FBoolean extends FSchema<boolean> {
  readonly type: 'boolean';
}

export interface FNull extends FSchema<null> {
  readonly type: 'null';
}

export interface FUnknown extends FSchema<unknown> {}

export interface FAny extends FSchema<any> {}

export interface FNever extends FSchema<never> {}

export interface FUndefined extends FSchema<undefined> {}

export interface FBigInt extends FSchema<bigint> {}

export interface FLiteral<T extends string | number | boolean> extends FSchema<T> {
  readonly const: T;
}

// ---------------------------------------------------------------------------
// Composite schema interfaces
// ---------------------------------------------------------------------------

export interface FArray<T extends FSchema<unknown>> extends FSchema<Infer<T>[]> {
  readonly type: 'array';
  readonly items: T;
  readonly minItems?: number;
  readonly maxItems?: number;
}

export interface FObject<T extends FProperties> extends FSchema<FObjectOutput<T>> {
  readonly type: 'object';
  readonly properties: Record<string, FSchema<unknown>>;
  readonly required: readonly string[];
  readonly $id?: string;
}

export interface FUnion<T extends readonly FSchema<unknown>[]>
  extends FSchema<Infer<T[number]>> {
  readonly anyOf: T;
}

type UnionToIntersection<U>
  = (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void ? I : never;

export interface FIntersect<T extends readonly FSchema<unknown>[]>
  extends FSchema<UnionToIntersection<Infer<T[number]>>> {
  readonly allOf: T;
}

export interface FEnum<T extends string | number | boolean> extends FSchema<T> {
  readonly enum: readonly T[];
}

export interface FDiscriminatedUnion<
  K extends string,
  M extends Record<string, FSchema<unknown>>,
> extends FSchema<Infer<M[keyof M]>> {
  readonly oneOf: readonly FSchema<unknown>[];
  readonly discriminator: { readonly propertyName: K };
}

export interface FRef<T> extends FSchema<T> {
  readonly $ref: string;
}
