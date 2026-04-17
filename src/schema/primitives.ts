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

/* @__NO_SIDE_EFFECTS__ */
export function string(opts: StringOptions = {}): FString {
  const { minLength, maxLength, length, pattern, startsWith, endsWith, includes } = opts;
  const regex = pattern !== undefined ? new RegExp(pattern) : undefined;
  return {
    'type': 'string',
    ...(minLength !== undefined && { minLength }),
    ...(maxLength !== undefined && { maxLength }),
    ...(pattern !== undefined && { pattern }),
    '~standard': {
      version: 1,
      vendor: 'fetcher',
      validate(v): StandardSchemaV1Result<string> {
        if (typeof v !== 'string')
          return { issues: [{ code: 'expected_string', message: 'Expected string' }] };
        if (length !== undefined && v.length !== length)
          return { issues: [{ code: v.length < length ? 'too_short' : 'too_long', message: v.length < length ? 'Too short' : 'Too long' }] };
        if (minLength !== undefined && v.length < minLength)
          return { issues: [{ code: 'too_short', message: 'Too short' }] };
        if (maxLength !== undefined && v.length > maxLength)
          return { issues: [{ code: 'too_long', message: 'Too long' }] };
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
        if (typeof v !== 'number' || Number.isNaN(v))
          return { issues: [{ code: 'expected_number', message: 'Expected number' }] };
        if (minimum !== undefined && v < minimum)
          return { issues: [{ code: 'too_small', message: 'Too small' }] };
        if (maximum !== undefined && v > maximum)
          return { issues: [{ code: 'too_large', message: 'Too large' }] };
        if (exclusiveMinimum !== undefined && v <= exclusiveMinimum)
          return { issues: [{ code: 'too_small', message: 'Too small' }] };
        if (exclusiveMaximum !== undefined && v >= exclusiveMaximum)
          return { issues: [{ code: 'too_large', message: 'Too large' }] };
        if (multipleOf !== undefined && v % multipleOf !== 0)
          return { issues: [{ code: 'not_a_multiple', message: 'Not a multiple' }] };
        return { value: v };
      },
    },
  } as FNumber;
}

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
        if (multipleOf !== undefined && v % multipleOf !== 0)
          return { issues: [{ code: 'not_a_multiple', message: 'Not a multiple' }] };
        return { value: v };
      },
    },
  } as FInteger;
}

/* @__NO_SIDE_EFFECTS__ */
export function positive(): FNumber {
  return number({ exclusiveMinimum: 0 });
}

/* @__NO_SIDE_EFFECTS__ */
export function nonnegative(): FNumber {
  return number({ minimum: 0 });
}

/* @__NO_SIDE_EFFECTS__ */
export function negative(): FNumber {
  return number({ exclusiveMaximum: 0 });
}

/* @__NO_SIDE_EFFECTS__ */
export function nonpositive(): FNumber {
  return number({ maximum: 0 });
}

/* @__NO_SIDE_EFFECTS__ */
export function finite(): FNumber {
  return {
    'type': 'number',
    '~standard': {
      version: 1,
      vendor: 'fetcher',
      validate(v): StandardSchemaV1Result<number> {
        if (typeof v !== 'number' || !Number.isFinite(v))
          return { issues: [{ code: 'expected_number', message: 'Expected number' }] };
        return { value: v };
      },
    },
  } as FNumber;
}

/* @__NO_SIDE_EFFECTS__ */
export function safe(): FInteger {
  return integer({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER });
}

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

/* @__NO_SIDE_EFFECTS__ */
export function literal<T extends string | number | boolean>(value: T): FLiteral<T> {
  return {
    'const': value,
    '~standard': {
      version: 1,
      vendor: 'fetcher',
      validate(v): StandardSchemaV1Result<T> {
        if (v !== value)
          return { issues: [{ code: 'not_in_enum', message: 'Not in enum' }] };
        return { value: v as T };
      },
    },
  } as FLiteral<T>;
}

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
