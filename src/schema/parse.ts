/**
 * `parse` and `parseOrThrow` — ergonomic wrappers over
 * `schema['~standard'].validate(data)`. Works with any Standard Schema V1
 * validator (the bundled builder, Zod, Valibot, ArkType).
 *
 * Mirrors fetcher's `.result()` / `.unwrap()` dual API:
 * - `parse` never throws — returns the native result union.
 * - `parseOrThrow` throws {@link SchemaValidationError} on issues.
 *
 * @module
 */

import type {
  StandardSchemaV1,
  StandardSchemaV1Issue,
  StandardSchemaV1Result,
} from '../types.ts';
import { formatIssues } from './format-issues.ts';

/**
 * Thrown by {@link parseOrThrow} when validation fails. Carries the raw
 * `issues` array; `.message` is the formatted output from
 * {@link formatIssues}.
 */
export class SchemaValidationError extends Error {
  readonly issues: ReadonlyArray<StandardSchemaV1Issue>;
  constructor(issues: ReadonlyArray<StandardSchemaV1Issue>) {
    super(formatIssues(issues));
    this.name = 'SchemaValidationError';
    this.issues = issues;
  }
}

/**
 * Validates `data` against `schema` and returns the native Standard Schema
 * V1 result — `{ value }` on success, `{ issues }` on failure. Never throws.
 *
 * For schemas whose `validate` returns a Promise (async validators), the
 * return type widens to include `Promise<Result<T>>`. Builder-produced
 * schemas are always synchronous.
 *
 * @example
 * ```ts
 * const r = parse(Pet, data);
 * if (r.issues) console.error(formatIssues(r.issues));
 * else use(r.value);
 * ```
 */
export function parse<T>(
  schema: StandardSchemaV1<unknown, T>,
  data: unknown,
): StandardSchemaV1Result<T> | Promise<StandardSchemaV1Result<T>> {
  return schema['~standard'].validate(data);
}

/**
 * Validates `data` against `schema`. Returns the validated value on success
 * or throws {@link SchemaValidationError} on failure. Sync only — for async
 * validators, await `schema['~standard'].validate(data)` directly.
 *
 * @example
 * ```ts
 * try {
 *   const pet = parseOrThrow(Pet, data);
 *   use(pet);
 * } catch (err) {
 *   if (err instanceof SchemaValidationError) console.error(err.issues);
 * }
 * ```
 */
export function parseOrThrow<T>(
  schema: StandardSchemaV1<unknown, T>,
  data: unknown,
): T {
  const r = schema['~standard'].validate(data);
  if (r instanceof Promise)
    throw new TypeError('parseOrThrow requires a synchronous schema; use await schema[\'~standard\'].validate(data) for async validators');
  if (r.issues)
    throw new SchemaValidationError(r.issues);
  return r.value as T;
}
