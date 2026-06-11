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

import type { StandardSchemaV1PathSegment, StandardSchemaV1Result } from '../types.ts';
import type { FDefaultWrapper, FSchema, Infer } from './types.ts';
import { ensureSync } from './container.ts';
import { emissionTarget, schemaMeta, wrapperBase } from './wrap.ts';

type SyncValidate<T> = (value: unknown) => StandardSchemaV1Result<T>;

/**
 * Options bag accepted as the third argument of {@link refined} in place of
 * a plain message string.
 */
export interface RefinedOptions {
  /** Human-readable failure message. Default: `'Refinement failed'`. */
  readonly message?: string;
  /** Machine-readable issue code. Default: `'refine_failed'`. */
  readonly code?: string;
  /**
   * Issue path — lets a cross-field rule attribute its failure to a
   * specific field (e.g. `['confirm']` for a password-confirmation check)
   * so `groupIssuesByField`/`parseForm` route it correctly.
   */
  readonly path?: ReadonlyArray<StandardSchemaV1PathSegment>;
}

/**
 * Wraps a schema with an additional predicate check. The base schema runs
 * first; if it passes, the predicate is invoked with the validated value
 * and must return `true` to accept. Predicate failure emits an issue with
 * code `refine_failed` by default; pass an options object to customize the
 * `message`, `code`, and `path` of the issue.
 *
 * Use for cross-field rules, business constraints, or checks that can't be
 * expressed through the standard options. Wrapping an `optional()` (or
 * `default_`) entry keeps that entry's optional/default treatment inside
 * `object()` — the predicate composes on top instead of replacing it.
 *
 * @example
 * ```ts
 * const Password = refined(
 *   string({ minLength: 8 }),
 *   (s) => /[A-Z]/.test(s) && /\d/.test(s),
 *   'must contain uppercase and digit',
 * );
 *
 * const Signup = refined(
 *   object({ password: string(), confirm: string() }),
 *   (o) => o.password === o.confirm,
 *   { message: 'Passwords must match', path: ['confirm'] },
 * );
 * ```
 */
/* @__NO_SIDE_EFFECTS__ */
export function refined<T>(
  schema: FSchema<T>,
  predicate: (value: T) => boolean,
  messageOrOptions: string | RefinedOptions = 'Refinement failed',
): FSchema<T> {
  const opts = typeof messageOrOptions === 'string' ? { message: messageOrOptions } : messageOrOptions;
  const message = opts.message ?? 'Refinement failed';
  const code = opts.code ?? 'refine_failed';
  const path = opts.path;
  const innerValidate = schema['~standard'].validate as SyncValidate<T>;
  return {
    ...wrapperBase(schema),
    '~standard': {
      version: 1,
      vendor: 'fetcher',
      validate(v): StandardSchemaV1Result<T> {
        const r = ensureSync(innerValidate(v));
        if (r.issues)
          return r;
        if (!predicate(r.value as T))
          return { issues: [{ code, message, ...(path !== undefined && { path }) }] };
        return r;
      },
    },
  } as FSchema<T>;
}

/**
 * Wraps a schema with an undefined-only fallback. If the input is
 * `undefined` (including a missing object key), the fallback is returned
 * without invoking the base validator. Any other value goes through the
 * base schema normally.
 *
 * Fallback forms:
 * - a **function** is treated as a factory and called once per use;
 * - a **plain object or array** (prototype `Object.prototype`/`null`, or
 *   `Array.isArray`) is `structuredClone`d per use, so no two validations
 *   ever share (and can cross-pollute) one mutable instance. A plain
 *   fallback that cannot be cloned (it contains a function, symbol, or
 *   other non-cloneable value) throws a `TypeError` at **construction**
 *   time — never at validate time;
 * - **any other object** (class instances, `Map`, `Date`, …) is passed
 *   through **by reference** — cloning would strip its prototype. Use a
 *   factory (`() => new Thing()`) when each use needs a fresh instance;
 * - primitives are returned as-is.
 *
 * The JSON Schema `default` annotation is emitted only for value fallbacks
 * (a factory has no static representation and is never invoked at
 * construction time).
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
 *   tags: default_(array(string()), () => []),
 * });
 * // Input {} → Output { theme: 'light', tags: [] }  (name still required → error)
 * ```
 */
/* @__NO_SIDE_EFFECTS__ */
export function default_<S extends FSchema<unknown>>(
  schema: S,
  fallback: Infer<S> | (() => Infer<S>),
): FDefaultWrapper<S> {
  const innerValidate = schema['~standard'].validate as SyncValidate<Infer<S>>;
  const isFactory = typeof fallback === 'function';
  const isObjectValue = !isFactory && typeof fallback === 'object' && fallback !== null;
  // Only plain objects/arrays are cloned per use — structuredClone of a
  // class instance returns a prototype-stripped plain object, so non-plain
  // objects pass through by reference instead (see the JSDoc above).
  const proto: unknown = isObjectValue ? Object.getPrototypeOf(fallback) : undefined;
  const isPlain = isObjectValue
    && (Array.isArray(fallback) || proto === Object.prototype || proto === null);
  if (isPlain) {
    // Probe ONCE at construction so a non-cloneable fallback fails fast and
    // descriptively here, instead of `validate()` throwing DataCloneError
    // later (validate must never throw).
    try {
      structuredClone(fallback);
    }
    catch {
      throw new TypeError(
        'default_ fallback cannot be structuredClone\'d (it contains a function, symbol, or other non-cloneable value). Pass a factory instead: default_(schema, () => fallback).',
      );
    }
  }
  const produce: () => Infer<S> = isFactory
    ? fallback as () => Infer<S>
    : isPlain
      ? () => structuredClone(fallback) as Infer<S>
      : () => fallback as Infer<S>;
  return {
    ...schemaMeta(schema),
    ...(!isFactory && { '~fallback': fallback, 'default': fallback }),
    '~default': true,
    '~wrapped': emissionTarget(schema),
    '~inner': schema,
    '~standard': {
      version: 1,
      vendor: 'fetcher',
      validate(v: unknown): StandardSchemaV1Result<Infer<S>> {
        if (v === undefined)
          return { value: produce() };
        return ensureSync(innerValidate(v));
      },
    },
  } as unknown as FDefaultWrapper<S>;
}
