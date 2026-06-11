/**
 * Shared validation invariants for container composites (`object`, `array`,
 * `record`, `tuple`). Each composite still compiles its own closure over
 * pre-built member validators (the perf model is unchanged), but the two
 * mechanical steps every container must get right — prepending the failing
 * key/index to member issue paths, and threading transformed/defaulted member
 * values into the output — live here in exactly one place.
 *
 * Issue #8 was the signature of the alternative: the same invariant
 * hand-coded four times, three of them forgetting to thread output. Routing
 * through {@link collectMember}/{@link finalizeContainer} makes that class of
 * bug structurally impossible for new composites.
 *
 * @module
 */

import type {
  StandardSchemaV1Issue,
  StandardSchemaV1PathSegment,
  StandardSchemaV1Result,
} from '../types.ts';

/** Prepends `segment` to an issue's path. The single implementation. */
export function prependPath(
  segment: StandardSchemaV1PathSegment,
  issue: StandardSchemaV1Issue,
): StandardSchemaV1Issue {
  return {
    ...(issue.code !== undefined && { code: issue.code }),
    message: issue.message,
    path: issue.path ? [segment, ...issue.path] : [segment],
  };
}

/**
 * Guards a member validation result against async (Promise-returning)
 * Standard Schema validators. Every builder combinator is synchronous; a
 * nested async member (e.g. a Zod schema with an async refinement) would
 * otherwise be read as `{ value: undefined }` and silently corrupt output.
 *
 * Mirrors the Standard Schema spec's recommended sync-consumer pattern.
 *
 * @throws TypeError when the result is a Promise.
 */
export function ensureSync<T>(
  r: StandardSchemaV1Result<T> | Promise<StandardSchemaV1Result<T>>,
): StandardSchemaV1Result<T> {
  if (r instanceof Promise)
    throw new TypeError('Schema validation must be synchronous');
  return r;
}

/**
 * Writes `value` to `target[key]` without ever invoking the
 * `Object.prototype.__proto__` setter — a key literally named `'__proto__'`
 * (legal in JSON, where it is a plain own property) is installed via
 * `Object.defineProperty` so container output building can never pollute
 * prototypes.
 */
export function safeSet(
  target: Record<string | number, unknown>,
  key: string | number,
  value: unknown,
): void {
  if (key === '__proto__') {
    Object.defineProperty(target, '__proto__', {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  else {
    target[key] = value;
  }
}

/**
 * Threads one member's validation result into a container accumulator:
 *
 * - on issues → prepend `segment` to each and push onto `issues`;
 * - on a changed value (`r.value !== input`) → lazily clone `base` (array or
 *   plain object) into `out` the first time a value actually changes, then
 *   write the transformed value.
 *
 * Returns the (possibly newly-allocated) `out` — pass it back on the next
 * call. Allocation only happens when a transform/default produces a new
 * value, so the common "nothing changed" path stays zero-copy.
 */
export function collectMember<C extends unknown[] | Record<string, unknown>>(
  out: C | null,
  base: C,
  segment: string | number,
  input: unknown,
  r: StandardSchemaV1Result<unknown>,
  issues: StandardSchemaV1Issue[],
): C | null {
  if (r.issues) {
    for (let j = 0; j < r.issues.length; j++)
      issues.push(prependPath(segment, r.issues[j]!));
    return out;
  }
  if (r.value !== input) {
    if (out === null)
      out = (Array.isArray(base) ? [...base] : { ...base }) as C;
    safeSet(out as Record<string | number, unknown>, segment, r.value);
  }
  return out;
}

/**
 * Closes out a container validation: the issue list wins if non-empty,
 * otherwise the (cloned-if-changed, original-if-not) value is returned.
 */
export function finalizeContainer<C>(
  out: C | null,
  base: C,
  issues: StandardSchemaV1Issue[],
): StandardSchemaV1Result<C> {
  return issues.length ? { issues } : { value: (out ?? base) };
}
