/**
 * `record` (string-keyed dictionary) and `tuple` (fixed positional array)
 * composites. Both close over the member validators at construction time.
 *
 * @module
 */

import type {
  StandardSchemaV1Issue,
  StandardSchemaV1Result,
} from '../types.ts';
import type { FSchema, Infer } from './types.ts';
import { collectMember, ensureSync, finalizeContainer } from './container.ts';

type SyncValidate<T> = (value: unknown) => StandardSchemaV1Result<T>;

/** Schema produced by `record(value)` — a string-keyed dictionary. */
export interface FRecord<V extends FSchema<unknown>>
  extends FSchema<Record<string, Infer<V>>> {
  /** JSON Schema type keyword. */
  readonly type: 'object';
  /** The value schema applied to every entry. */
  readonly additionalProperties: V;
}

/** Schema produced by `tuple(schemas)` — a fixed-length positional array. */
export interface FTuple<T extends readonly FSchema<unknown>[]>
  extends FSchema<{ [K in keyof T]: T[K] extends FSchema<unknown> ? Infer<T[K]> : never }> {
  /** JSON Schema type keyword. */
  readonly type: 'array';
  /** Positional member schemas. */
  readonly prefixItems: T;
  /** No elements are allowed beyond the declared positions. */
  readonly items: false;
  /** Exact length lower bound (equals the member count). */
  readonly minItems: number;
  /** Exact length upper bound (equals the member count). */
  readonly maxItems: number;
}

/**
 * String-keyed dictionary schema.
 *
 * Accepts **plain objects only** (prototype `Object.prototype` or `null`) —
 * `Map`, `Set`, `Date`, and class instances are rejected with an
 * `expected_object` issue, because their entries do not live in enumerable
 * own properties and would otherwise pass with zero validation. Only own
 * enumerable keys (`Object.keys`) are validated; inherited properties are
 * never read, and keys named `'__proto__'` round-trip safely.
 */
/* @__NO_SIDE_EFFECTS__ */
export function record<V extends FSchema<unknown>>(value: V): FRecord<V> {
  const validate = value['~standard'].validate as SyncValidate<Infer<V>>;
  return {
    'type': 'object',
    'additionalProperties': value,
    '~standard': {
      version: 1,
      vendor: 'fetcher',
      validate(v): StandardSchemaV1Result<Record<string, Infer<V>>> {
        if (typeof v !== 'object' || v === null || Array.isArray(v))
          return { issues: [{ code: 'expected_object', message: 'Expected object' }] };
        const proto: unknown = Object.getPrototypeOf(v);
        if (proto !== Object.prototype && proto !== null)
          return { issues: [{ code: 'expected_object', message: 'Expected plain object' }] };
        const obj = v as Record<string, unknown>;
        const issues: StandardSchemaV1Issue[] = [];
        let out: Record<string, unknown> | null = null;
        const ownKeys = Object.keys(obj);
        for (let i = 0; i < ownKeys.length; i++) {
          const key = ownKeys[i]!;
          out = collectMember(out, obj, key, obj[key], ensureSync(validate(obj[key])), issues);
        }
        return finalizeContainer(out, obj, issues) as StandardSchemaV1Result<Record<string, Infer<V>>>;
      },
    },
  } as FRecord<V>;
}

/**
 * Fixed-length positional array schema. Emitted as `prefixItems` with
 * `items: false` and exact `minItems`/`maxItems` bounds.
 */
/* @__NO_SIDE_EFFECTS__ */
export function tuple<T extends readonly [FSchema<unknown>, ...FSchema<unknown>[]]>(
  schemas: T,
): FTuple<T> {
  const validators = schemas.map(s => s['~standard'].validate as SyncValidate<unknown>);
  const length = schemas.length;
  return {
    'type': 'array',
    'prefixItems': schemas,
    'items': false,
    'minItems': length,
    'maxItems': length,
    '~standard': {
      version: 1,
      vendor: 'fetcher',
      validate(v): StandardSchemaV1Result<{ [K in keyof T]: T[K] extends FSchema<unknown> ? Infer<T[K]> : never }> {
        if (!Array.isArray(v))
          return { issues: [{ code: 'expected_array', message: 'Expected array' }] };
        if (v.length !== length)
          return { issues: [{ code: v.length < length ? 'too_short' : 'too_long', message: v.length < length ? 'Too short' : 'Too long' }] };
        const issues: StandardSchemaV1Issue[] = [];
        let out: unknown[] | null = null;
        for (let i = 0; i < length; i++) {
          out = collectMember(out, v, i, v[i], ensureSync(validators[i]!(v[i])), issues);
        }
        return finalizeContainer(out, v, issues) as StandardSchemaV1Result<{ [K in keyof T]: T[K] extends FSchema<unknown> ? Infer<T[K]> : never }>;
      },
    },
  } as FTuple<T>;
}
