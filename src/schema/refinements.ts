/**
 * Pure-validation extensions — `refined` (custom predicate on top of any
 * base schema) and `default_` (undefined-only fallback substitution).
 *
 * Neither mutates input data nor transforms output type beyond what the
 * base schema already produces. Transforms, coerce, pipe, preprocess, and
 * catch are intentionally out of scope.
 *
 * @module
 */

import type { StandardSchemaV1Result } from '../types.ts';
import type { FDefaultWrapper, FSchema, Infer } from './types.ts';

type SyncValidate<T> = (value: unknown) => StandardSchemaV1Result<T>;

/**
 * Wraps a schema with an additional predicate check. The base schema runs
 * first; if it passes, the predicate is invoked with the validated value
 * and must return `true` to accept. Predicate failure emits an issue with
 * code `refine_failed`.
 *
 * Use for cross-field rules, business constraints, or checks that can't be
 * expressed through the standard options.
 *
 * @example
 * ```ts
 * const Password = refined(
 *   string({ minLength: 8 }),
 *   (s) => /[A-Z]/.test(s) && /\d/.test(s),
 *   'must contain uppercase and digit',
 * );
 * ```
 */
/* @__NO_SIDE_EFFECTS__ */
export function refined<T>(
  schema: FSchema<T>,
  predicate: (value: T) => boolean,
  message = 'Refinement failed',
): FSchema<T> {
  const innerValidate = schema['~standard'].validate as SyncValidate<T>;
  return {
    ...schema,
    '~standard': {
      version: 1,
      vendor: 'fetcher',
      validate(v): StandardSchemaV1Result<T> {
        const r = innerValidate(v);
        if (r.issues)
          return r;
        if (!predicate(r.value as T))
          return { issues: [{ code: 'refine_failed', message }] };
        return r;
      },
    },
  } as FSchema<T>;
}

/**
 * Wraps a schema with an undefined-only fallback. If the input is
 * `undefined` (including a missing object key), `fallback` is returned
 * without invoking the base validator. Any other value goes through the
 * base schema normally.
 *
 * Used inside `object({...})` to make a key's missing value substitute a
 * default rather than produce a `missing` issue. At the type level, the
 * key remains required — the consumer always sees the value.
 *
 * @example
 * ```ts
 * const User = object({
 *   name: string(),
 *   theme: default_(enum_(['light', 'dark'] as const), 'light'),
 * });
 * // Input {} → Output { theme: 'light' }  (name still required → error)
 * ```
 */
/* @__NO_SIDE_EFFECTS__ */
export function default_<S extends FSchema<unknown>>(
  schema: S,
  fallback: Infer<S>,
): FDefaultWrapper<S> {
  const innerValidate = schema['~standard'].validate as SyncValidate<Infer<S>>;
  return {
    ...schema,
    '~default': true,
    '~fallback': fallback,
    '~wrapped': schema,
    'default': fallback,
    '~standard': {
      version: 1,
      vendor: 'fetcher',
      validate(v: unknown): StandardSchemaV1Result<Infer<S>> {
        if (v === undefined)
          return { value: fallback };
        return innerValidate(v);
      },
    },
  } as unknown as FDefaultWrapper<S>;
}
