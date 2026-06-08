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
import { collectMember, finalizeContainer } from './container.ts';

type SyncValidate<T> = (value: unknown) => StandardSchemaV1Result<T>;

export interface FRecord<V extends FSchema<unknown>>
  extends FSchema<Record<string, Infer<V>>> {
  readonly type: 'object';
  readonly additionalProperties: V;
}

export interface FTuple<T extends readonly FSchema<unknown>[]>
  extends FSchema<{ [K in keyof T]: T[K] extends FSchema<unknown> ? Infer<T[K]> : never }> {
  readonly type: 'array';
  readonly prefixItems: T;
  readonly items: false;
  readonly minItems: number;
  readonly maxItems: number;
}

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
        const obj = v as Record<string, unknown>;
        const issues: StandardSchemaV1Issue[] = [];
        let out: Record<string, unknown> | null = null;
        for (const key in obj) {
          out = collectMember(out, obj, key, obj[key], validate(obj[key]), issues);
        }
        return finalizeContainer(out, obj, issues) as StandardSchemaV1Result<Record<string, Infer<V>>>;
      },
    },
  } as FRecord<V>;
}

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
          out = collectMember(out, v, i, v[i], validators[i]!(v[i]), issues);
        }
        return finalizeContainer(out, v, issues) as StandardSchemaV1Result<{ [K in keyof T]: T[K] extends FSchema<unknown> ? Infer<T[K]> : never }>;
      },
    },
  } as FTuple<T>;
}
