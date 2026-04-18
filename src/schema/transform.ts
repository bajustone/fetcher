/**
 * Post-validation transformation pipeline.
 *
 * `transform(schema, ...fns)` runs the base schema's validator first. On
 * success, each subsequent function receives the previous step's output
 * and returns the next value. On validation failure, transforms are
 * skipped and the issues propagate.
 *
 * Plain functions only — no issue channel mid-pipeline. To reject a value
 * after a transform, wrap the result with {@link refined}:
 *
 * ```ts
 * refined(
 *   transform(string(), (s) => s.toLowerCase()),
 *   (s) => s.length > 3,
 *   'too short',
 * )
 * ```
 *
 * Inherits the base schema's JSON Schema shape (via spread). Downstream
 * tools that serialize the schema see the *wire* shape; they have no way
 * to know about the transforms. This is honest: `transform` validates
 * wire data, then reshapes. JSON Schema represents the first half.
 *
 * @module
 */

import type { StandardSchemaV1Result } from '../types.ts';
import type { FSchema } from './types.ts';

type SyncValidate<T> = (value: unknown) => StandardSchemaV1Result<T>;

/* @__NO_SIDE_EFFECTS__ */
export function transform<T0, T1>(
  schema: FSchema<T0>,
  t1: (value: T0) => T1,
): FSchema<T1>;
/* @__NO_SIDE_EFFECTS__ */
export function transform<T0, T1, T2>(
  schema: FSchema<T0>,
  t1: (value: T0) => T1,
  t2: (value: T1) => T2,
): FSchema<T2>;
/* @__NO_SIDE_EFFECTS__ */
export function transform<T0, T1, T2, T3>(
  schema: FSchema<T0>,
  t1: (value: T0) => T1,
  t2: (value: T1) => T2,
  t3: (value: T2) => T3,
): FSchema<T3>;
/* @__NO_SIDE_EFFECTS__ */
export function transform<T0, T1, T2, T3, T4>(
  schema: FSchema<T0>,
  t1: (value: T0) => T1,
  t2: (value: T1) => T2,
  t3: (value: T2) => T3,
  t4: (value: T3) => T4,
): FSchema<T4>;
/* @__NO_SIDE_EFFECTS__ */
export function transform<T0, T1, T2, T3, T4, T5>(
  schema: FSchema<T0>,
  t1: (value: T0) => T1,
  t2: (value: T1) => T2,
  t3: (value: T2) => T3,
  t4: (value: T3) => T4,
  t5: (value: T4) => T5,
): FSchema<T5>;
/* @__NO_SIDE_EFFECTS__ */
export function transform<T0, T1, T2, T3, T4, T5, T6>(
  schema: FSchema<T0>,
  t1: (value: T0) => T1,
  t2: (value: T1) => T2,
  t3: (value: T2) => T3,
  t4: (value: T3) => T4,
  t5: (value: T4) => T5,
  t6: (value: T5) => T6,
): FSchema<T6>;

/* @__NO_SIDE_EFFECTS__ */
export function transform(
  schema: FSchema<unknown>,
  ...fns: Array<(value: unknown) => unknown>
): FSchema<unknown> {
  const innerValidate = schema['~standard'].validate as SyncValidate<unknown>;
  return {
    ...schema,
    '~standard': {
      version: 1,
      vendor: 'fetcher',
      validate(v): StandardSchemaV1Result<unknown> {
        const r = innerValidate(v);
        if (r.issues)
          return r;
        let out: unknown = r.value;
        for (let i = 0; i < fns.length; i++)
          out = fns[i]!(out);
        return { value: out };
      },
    },
  } as FSchema<unknown>;
}
