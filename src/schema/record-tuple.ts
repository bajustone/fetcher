/**
 * `record` (string-keyed dictionary) and `tuple` (fixed positional array)
 * composites. Both close over the member validators at construction time.
 *
 * @module
 */

import type {
  StandardSchemaV1Issue,
  StandardSchemaV1PathSegment,
  StandardSchemaV1Result,
} from '../types.ts';
import type { FSchema, Infer } from './types.ts';

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

function prependPath(
  segment: StandardSchemaV1PathSegment,
  issue: StandardSchemaV1Issue,
): StandardSchemaV1Issue {
  return {
    message: issue.message,
    path: issue.path ? [segment, ...issue.path] : [segment],
  };
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
        for (const key in obj) {
          const r = validate(obj[key]);
          if (r.issues) {
            for (let j = 0; j < r.issues.length; j++)
              issues.push(prependPath(key, r.issues[j]!));
          }
        }
        return issues.length
          ? { issues }
          : { value: v as Record<string, Infer<V>> };
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
        for (let i = 0; i < length; i++) {
          const r = validators[i]!(v[i]);
          if (r.issues) {
            for (let j = 0; j < r.issues.length; j++)
              issues.push(prependPath(i, r.issues[j]!));
          }
        }
        return issues.length
          ? { issues }
          : { value: v as { [K in keyof T]: T[K] extends FSchema<unknown> ? Infer<T[K]> : never } };
      },
    },
  } as FTuple<T>;
}
