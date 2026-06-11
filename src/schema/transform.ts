/**
 * Post-validation transformation pipeline.
 *
 * `transform(schema, ...fns)` runs the base schema's validator first. On
 * success, each subsequent function receives the previous step's output
 * and returns the next value. On validation failure, transforms are
 * skipped and the issues propagate. A transform function that **throws**
 * produces a validation issue (code `transform_error`) instead of an
 * uncaught exception, preserving the Standard Schema "validate never
 * throws" expectation.
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
 * Inherits the base schema's JSON Schema shape. Downstream tools that
 * serialize the schema see the *wire* shape; they have no way to know
 * about the transforms. This is honest: `transform` validates wire data,
 * then reshapes. JSON Schema represents the first half.
 *
 * Wrapping an `optional()` (or `default_`) entry keeps that entry's
 * optional/default treatment inside `object()` — the transform composes on
 * top instead of replacing it, and runs even for a missing optional key
 * (receiving `undefined`), so `transform(optional(string()), v => v ?? 'x')`
 * can materialize a value.
 *
 * @module
 */

import type { StandardSchemaV1Result } from '../types.ts';
import type { FSchema } from './types.ts';
import { ensureSync } from './container.ts';
import { wrapperBase } from './wrap.ts';

type SyncValidate<T> = (value: unknown) => StandardSchemaV1Result<T>;

/** Post-validation transform — one reshaping step over the validated value. */
/* @__NO_SIDE_EFFECTS__ */
export function transform<T0, T1>(
  schema: FSchema<T0>,
  t1: (value: T0) => T1,
): FSchema<T1>;
/** Post-validation transform — two reshaping steps, each fed the previous output. */
/* @__NO_SIDE_EFFECTS__ */
export function transform<T0, T1, T2>(
  schema: FSchema<T0>,
  t1: (value: T0) => T1,
  t2: (value: T1) => T2,
): FSchema<T2>;
/** Post-validation transform — three reshaping steps, each fed the previous output. */
/* @__NO_SIDE_EFFECTS__ */
export function transform<T0, T1, T2, T3>(
  schema: FSchema<T0>,
  t1: (value: T0) => T1,
  t2: (value: T1) => T2,
  t3: (value: T2) => T3,
): FSchema<T3>;
/** Post-validation transform — four reshaping steps, each fed the previous output. */
/* @__NO_SIDE_EFFECTS__ */
export function transform<T0, T1, T2, T3, T4>(
  schema: FSchema<T0>,
  t1: (value: T0) => T1,
  t2: (value: T1) => T2,
  t3: (value: T2) => T3,
  t4: (value: T3) => T4,
): FSchema<T4>;
/** Post-validation transform — five reshaping steps, each fed the previous output. */
/* @__NO_SIDE_EFFECTS__ */
export function transform<T0, T1, T2, T3, T4, T5>(
  schema: FSchema<T0>,
  t1: (value: T0) => T1,
  t2: (value: T1) => T2,
  t3: (value: T2) => T3,
  t4: (value: T3) => T4,
  t5: (value: T4) => T5,
): FSchema<T5>;
/** Post-validation transform — six reshaping steps; nest `transform` calls for more. */
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

/**
 * Runs the base schema, then applies the transform functions in sequence to
 * the validated value. See the module docs for failure semantics (a throwing
 * transform yields a `transform_error` issue; base-schema failures skip the
 * transforms entirely).
 */
/* @__NO_SIDE_EFFECTS__ */
export function transform(
  schema: FSchema<unknown>,
  ...fns: Array<(value: unknown) => unknown>
): FSchema<unknown> {
  const innerValidate = schema['~standard'].validate as SyncValidate<unknown>;
  return {
    ...wrapperBase(schema),
    '~standard': {
      version: 1,
      vendor: 'fetcher',
      validate(v): StandardSchemaV1Result<unknown> {
        const r = ensureSync(innerValidate(v));
        if (r.issues)
          return r;
        let out: unknown = r.value;
        try {
          for (let i = 0; i < fns.length; i++)
            out = fns[i]!(out);
        }
        catch (err) {
          return {
            issues: [{
              code: 'transform_error',
              message: err instanceof Error ? err.message : String(err),
            }],
          };
        }
        return { value: out };
      },
    },
  } as FSchema<unknown>;
}
