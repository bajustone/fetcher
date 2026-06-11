/**
 * Primitive schema factories. Each returns a plain JSON Schema object with a
 * pre-compiled `~standard.validate` closure — no runtime interpreter.
 *
 * @module
 */

import type { StandardSchemaV1Result } from '../types.ts';
import type {
  FAny,
  FBigInt,
  FBoolean,
  FInteger,
  FLiteral,
  FNever,
  FNull,
  FNumber,
  FString,
  FUndefined,
  FUnknown,
  NumberOptions,
  StringOptions,
} from './types.ts';

/**
 * Number of decimal digits `n` carries, derived from its shortest round-trip
 * string form. Handles exponential notation: `1e-7` has 7 decimals,
 * `1.5e-7` has 8, `1e+21` has 0.
 */
function decimalDigits(n: number): number {
  const s = n.toString();
  const e = s.indexOf('e');
  if (e === -1) {
    const dot = s.indexOf('.');
    return dot === -1 ? 0 : s.length - dot - 1;
  }
  const exp = Number(s.slice(e + 1));
  const mantissa = s.slice(0, e);
  const dot = mantissa.indexOf('.');
  const mantissaDigits = dot === -1 ? 0 : mantissa.length - dot - 1;
  return Math.max(0, mantissaDigits - exp);
}

/**
 * Scales `n` to an integer by shifting it `decimals` places, via its decimal
 * string* form (`toFixed`) so no float multiplication error creeps in.
 * Returns `null` when the result leaves the safe-integer range (the
 * comparison would no longer be exact).
 */
function scaledInteger(n: number, decimals: number): number | null {
  const scaled = Number(n.toFixed(decimals).replace('.', ''));
  return Number.isSafeInteger(scaled) ? scaled : null;
}

/**
 * Float-safe `multipleOf` check. A naive `v % multipleOf !== 0` reports false
 * negatives in IEEE-754 (e.g. `0.3 % 0.1 === 0.0399…`), and an epsilon on the
 * quotient is wrong in both directions: it falsely rejects exact decimal
 * multiples once the quotient grows large (`20000000.01 / 0.01` drifts past
 * any absolute epsilon — a routine money value) and falsely accepts
 * near-multiples inside the tolerance (`5.0000000001` for `multipleOf: 5`).
 *
 * Decimal-aware check instead (the same strategy as Zod's
 * `floatSafeRemainder`): scale both operands to integers by
 * `10^maxDecimals` — through their decimal string forms, so the scaling
 * itself is exact — and integer-compare when both fit the safe-integer
 * range. Otherwise fall back to an exact quotient-integer check with **no**
 * epsilon. A non-finite quotient (overflow, e.g. `1e308 / 0.123456789`) is
 * rejected rather than wrongly accepted or thrown.
 */
function isMultipleOf(value: number, multipleOf: number): boolean {
  if (multipleOf === 0)
    return value === 0;
  const decimals = Math.max(decimalDigits(value), decimalDigits(multipleOf));
  // toFixed supports at most 100 digits; beyond that the scaled form could
  // not be a safe integer anyway.
  if (decimals <= 100) {
    const scaledValue = scaledInteger(value, decimals);
    const scaledStep = scaledInteger(multipleOf, decimals);
    if (scaledValue !== null && scaledStep !== null)
      return scaledValue % scaledStep === 0;
  }
  // Exact fallback: Infinity/NaN quotients fail Number.isInteger → rejected.
  return Number.isInteger(value / multipleOf);
}

/**
 * Counts Unicode code points — JSON Schema 2020-12 / RFC 8259 string-length
 * semantics ("the number of its characters"), which differ from JS
 * `String.prototype.length` (UTF-16 code units) for astral-plane characters:
 * `'😀'` is one code point but two code units. Single pass, no allocation;
 * strings without surrogate pairs cost one arithmetic comparison per unit.
 */
function countCodePoints(s: string): number {
  let count = s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF) {
      const next = s.charCodeAt(i + 1); // NaN at end of string → fails the range check
      if (next >= 0xDC00 && next <= 0xDFFF) {
        count--;
        i++;
      }
    }
  }
  return count;
}

/** Escapes regex metacharacters so a literal string can appear in a pattern. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Derives a JSON Schema `pattern` from `startsWith`/`endsWith`/`includes`
 * when no explicit `pattern` is given and exactly one of the three is set,
 * so the emitted schema matches the runtime check. With multiple set, the
 * combination stays a runtime-only refinement (kept simple deliberately).
 */
function derivePattern(
  startsWith: string | undefined,
  endsWith: string | undefined,
  includes: string | undefined,
): string | undefined {
  const set = (startsWith !== undefined ? 1 : 0)
    + (endsWith !== undefined ? 1 : 0)
    + (includes !== undefined ? 1 : 0);
  if (set !== 1)
    return undefined;
  if (startsWith !== undefined)
    return `^${escapeRegExp(startsWith)}`;
  if (endsWith !== undefined)
    return `${escapeRegExp(endsWith)}$`;
  return escapeRegExp(includes!);
}

/**
 * String schema factory.
 *
 * Length constraints (`length`, `minLength`, `maxLength`) count **Unicode
 * code points** per JSON Schema 2020-12 / RFC 8259 — `'😀'` has length 1 —
 * so the runtime agrees with any spec-conforming consumer of the emitted
 * schema. (Note: Zod counts UTF-16 units, so astral-plane strings are a
 * known divergence from Zod.)
 *
 * `length` is emitted as `minLength`/`maxLength`; when exactly one of
 * `startsWith`/`endsWith`/`includes` is set and no `pattern` is given, an
 * equivalent anchored `pattern` is emitted so the declared schema matches
 * the runtime. Combinations of those options remain runtime-only checks.
 *
 * Security note: `pattern` is compiled verbatim with `new RegExp` — a
 * pattern taken from an untrusted OpenAPI document runs unvetted against
 * input, so it inherits that document's ReDoS exposure. Vet third-party
 * patterns before validating attacker-controlled data with them.
 */
/* @__NO_SIDE_EFFECTS__ */
export function string(opts: StringOptions = {}): FString {
  const { minLength, maxLength, length, pattern, startsWith, endsWith, includes } = opts;
  const regex = pattern !== undefined ? new RegExp(pattern) : undefined;
  const hasLengthBound = length !== undefined || minLength !== undefined || maxLength !== undefined;
  const emittedPattern = pattern ?? derivePattern(startsWith, endsWith, includes);
  return {
    'type': 'string',
    ...(length !== undefined && { minLength: length, maxLength: length }),
    ...(minLength !== undefined && { minLength }),
    ...(maxLength !== undefined && { maxLength }),
    ...(emittedPattern !== undefined && { pattern: emittedPattern }),
    '~standard': {
      version: 1,
      vendor: 'fetcher',
      validate(v): StandardSchemaV1Result<string> {
        if (typeof v !== 'string')
          return { issues: [{ code: 'expected_string', message: 'Expected string' }] };
        if (hasLengthBound) {
          const len = countCodePoints(v);
          if (length !== undefined && len !== length)
            return { issues: [{ code: len < length ? 'too_short' : 'too_long', message: len < length ? 'Too short' : 'Too long' }] };
          if (minLength !== undefined && len < minLength)
            return { issues: [{ code: 'too_short', message: 'Too short' }] };
          if (maxLength !== undefined && len > maxLength)
            return { issues: [{ code: 'too_long', message: 'Too long' }] };
        }
        if (regex !== undefined && !regex.test(v))
          return { issues: [{ code: 'pattern_mismatch', message: 'Pattern mismatch' }] };
        if (startsWith !== undefined && !v.startsWith(startsWith))
          return { issues: [{ code: 'pattern_mismatch', message: 'Pattern mismatch' }] };
        if (endsWith !== undefined && !v.endsWith(endsWith))
          return { issues: [{ code: 'pattern_mismatch', message: 'Pattern mismatch' }] };
        if (includes !== undefined && !v.includes(includes))
          return { issues: [{ code: 'pattern_mismatch', message: 'Pattern mismatch' }] };
        return { value: v };
      },
    },
  } as FString;
}

/**
 * Number schema factory. Rejects `NaN` **and** `±Infinity` — JSON cannot
 * represent either (`JSON.stringify(Infinity)` produces `null`), so a
 * `{ type: 'number' }` schema that admitted them would accept values no
 * JSON document could ever carry. Matches Zod v4's finite-by-default
 * behavior; {@link finite} is now a redundant alias kept for compatibility.
 */
/* @__NO_SIDE_EFFECTS__ */
export function number(opts: NumberOptions = {}): FNumber {
  const { minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf } = opts;
  return {
    'type': 'number',
    ...(minimum !== undefined && { minimum }),
    ...(maximum !== undefined && { maximum }),
    ...(exclusiveMinimum !== undefined && { exclusiveMinimum }),
    ...(exclusiveMaximum !== undefined && { exclusiveMaximum }),
    ...(multipleOf !== undefined && { multipleOf }),
    '~standard': {
      version: 1,
      vendor: 'fetcher',
      validate(v): StandardSchemaV1Result<number> {
        if (typeof v !== 'number' || !Number.isFinite(v))
          return { issues: [{ code: 'expected_number', message: 'Expected number' }] };
        if (minimum !== undefined && v < minimum)
          return { issues: [{ code: 'too_small', message: 'Too small' }] };
        if (maximum !== undefined && v > maximum)
          return { issues: [{ code: 'too_large', message: 'Too large' }] };
        if (exclusiveMinimum !== undefined && v <= exclusiveMinimum)
          return { issues: [{ code: 'too_small', message: 'Too small' }] };
        if (exclusiveMaximum !== undefined && v >= exclusiveMaximum)
          return { issues: [{ code: 'too_large', message: 'Too large' }] };
        if (multipleOf !== undefined && !isMultipleOf(v, multipleOf))
          return { issues: [{ code: 'not_a_multiple', message: 'Not a multiple' }] };
        return { value: v };
      },
    },
  } as FNumber;
}

/**
 * Integer schema factory. `Number.isInteger` already excludes `NaN` and
 * `±Infinity`, so integer() is non-finite-free by construction (the same
 * wire-data principle as {@link number}). Accepts `1.0` — JSON Schema's
 * `integer` matches "any number with a zero fractional part".
 */
/* @__NO_SIDE_EFFECTS__ */
export function integer(opts: NumberOptions = {}): FInteger {
  const { minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf } = opts;
  return {
    'type': 'integer',
    ...(minimum !== undefined && { minimum }),
    ...(maximum !== undefined && { maximum }),
    ...(exclusiveMinimum !== undefined && { exclusiveMinimum }),
    ...(exclusiveMaximum !== undefined && { exclusiveMaximum }),
    ...(multipleOf !== undefined && { multipleOf }),
    '~standard': {
      version: 1,
      vendor: 'fetcher',
      validate(v): StandardSchemaV1Result<number> {
        if (typeof v !== 'number' || !Number.isInteger(v))
          return { issues: [{ code: 'expected_integer', message: 'Expected integer' }] };
        if (minimum !== undefined && v < minimum)
          return { issues: [{ code: 'too_small', message: 'Too small' }] };
        if (maximum !== undefined && v > maximum)
          return { issues: [{ code: 'too_large', message: 'Too large' }] };
        if (exclusiveMinimum !== undefined && v <= exclusiveMinimum)
          return { issues: [{ code: 'too_small', message: 'Too small' }] };
        if (exclusiveMaximum !== undefined && v >= exclusiveMaximum)
          return { issues: [{ code: 'too_large', message: 'Too large' }] };
        if (multipleOf !== undefined && !isMultipleOf(v, multipleOf))
          return { issues: [{ code: 'not_a_multiple', message: 'Not a multiple' }] };
        return { value: v };
      },
    },
  } as FInteger;
}

/** Number schema accepting values strictly greater than zero. */
/* @__NO_SIDE_EFFECTS__ */
export function positive(): FNumber {
  return number({ exclusiveMinimum: 0 });
}

/** Number schema accepting zero and above. */
/* @__NO_SIDE_EFFECTS__ */
export function nonnegative(): FNumber {
  return number({ minimum: 0 });
}

/** Number schema accepting values strictly less than zero. */
/* @__NO_SIDE_EFFECTS__ */
export function negative(): FNumber {
  return number({ exclusiveMaximum: 0 });
}

/** Number schema accepting zero and below. */
/* @__NO_SIDE_EFFECTS__ */
export function nonpositive(): FNumber {
  return number({ maximum: 0 });
}

/**
 * Finite-number schema. Redundant since {@link number} rejects `NaN` and
 * `±Infinity` by default — kept as an alias for API compatibility and for
 * call sites that want the finiteness requirement spelled out.
 */
/* @__NO_SIDE_EFFECTS__ */
export function finite(): FNumber {
  return number();
}

/** Integer schema bounded to JavaScript's safe-integer range (`Number.MIN_SAFE_INTEGER` … `MAX_SAFE_INTEGER`). */
/* @__NO_SIDE_EFFECTS__ */
export function safe(): FInteger {
  return integer({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER });
}

/** Boolean schema — accepts exactly `true` or `false`. */
/* @__NO_SIDE_EFFECTS__ */
export function boolean(): FBoolean {
  return {
    'type': 'boolean',
    '~standard': {
      version: 1,
      vendor: 'fetcher',
      validate(v): StandardSchemaV1Result<boolean> {
        if (typeof v !== 'boolean')
          return { issues: [{ code: 'expected_boolean', message: 'Expected boolean' }] };
        return { value: v };
      },
    },
  } as FBoolean;
}

/**
 * Null schema — accepts exactly `null`. Trailing underscore because `null`
 * is a JS reserved word (the builder's naming convention for such factories).
 */
/* @__NO_SIDE_EFFECTS__ */
export function null_(): FNull {
  return {
    'type': 'null',
    '~standard': {
      version: 1,
      vendor: 'fetcher',
      validate(v): StandardSchemaV1Result<null> {
        if (v !== null)
          return { issues: [{ code: 'expected_null', message: 'Expected null' }] };
        return { value: v };
      },
    },
  } as FNull;
}

/**
 * Undefined schema — accepts exactly `undefined`. Useful for modeling
 * explicitly-absent optional bodies. No JSON Schema keywords are emitted
 * (`undefined` has no wire representation).
 */
/* @__NO_SIDE_EFFECTS__ */
export function undefined_(): FUndefined {
  return {
    '~standard': {
      version: 1,
      vendor: 'fetcher',
      validate(v): StandardSchemaV1Result<undefined> {
        if (v !== undefined)
          return { issues: [{ code: 'expected_undefined', message: 'Expected undefined' }] };
        return { value: v };
      },
    },
  } as FUndefined;
}

/**
 * Any schema — accepts every value, typed `any`. Prefer {@link unknown}
 * unless you specifically want to opt out of type checking downstream.
 */
/* @__NO_SIDE_EFFECTS__ */
export function any_(): FAny {
  return {
    '~standard': {
      version: 1,
      vendor: 'fetcher',
      validate(v): StandardSchemaV1Result<any> {
        return { value: v };
      },
    },
  } as FAny;
}

/** Never schema — rejects every value (emitted as `not: {}`). */
/* @__NO_SIDE_EFFECTS__ */
export function never_(): FNever {
  return {
    'not': {},
    '~standard': {
      version: 1,
      vendor: 'fetcher',
      validate(_v): StandardSchemaV1Result<never> {
        return { issues: [{ code: 'never', message: 'Never' }] };
      },
    },
  } as FNever;
}

/**
 * Bigint schema — accepts only `bigint` values. Note that JSON cannot
 * represent bigints, so this is for in-process validation, not wire data.
 */
/* @__NO_SIDE_EFFECTS__ */
export function bigint_(): FBigInt {
  return {
    '~standard': {
      version: 1,
      vendor: 'fetcher',
      validate(v): StandardSchemaV1Result<bigint> {
        if (typeof v !== 'bigint')
          return { issues: [{ code: 'expected_bigint', message: 'Expected bigint' }] };
        return { value: v };
      },
    },
  } as FBigInt;
}

/**
 * Single-value (`const`) schema. Matches by **SameValueZero** equality —
 * the same convention as `enum_` (which uses `Set.has`): `literal(0)`
 * matches `-0`, and `literal(Number.NaN)` matches `NaN`. The distinction is
 * moot for wire data (JSON cannot express `NaN`/`-0`), but the two
 * factories agree by design.
 */
/* @__NO_SIDE_EFFECTS__ */
export function literal<T extends string | number | boolean>(value: T): FLiteral<T> {
  return {
    'const': value,
    '~standard': {
      version: 1,
      vendor: 'fetcher',
      validate(v): StandardSchemaV1Result<T> {
        // SameValueZero: strict equality plus NaN === NaN.
        if (v !== value && !(typeof v === 'number' && typeof value === 'number' && Number.isNaN(v) && Number.isNaN(value)))
          return { issues: [{ code: 'not_in_enum', message: 'Not in enum' }] };
        return { value: v as T };
      },
    },
  } as FLiteral<T>;
}

/** Unknown schema — accepts every value, typed `unknown` (the safe top type). */
/* @__NO_SIDE_EFFECTS__ */
export function unknown(): FUnknown {
  return {
    '~standard': {
      version: 1,
      vendor: 'fetcher',
      validate(v): StandardSchemaV1Result<unknown> {
        return { value: v };
      },
    },
  } as FUnknown;
}
