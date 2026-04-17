/**
 * Primitive schema factories. Each returns a plain JSON Schema object with a
 * pre-compiled `~standard.validate` closure — no runtime interpreter.
 *
 * @module
 */

import type { StandardSchemaV1Result } from '../types.ts';
import type {
  FBoolean,
  FInteger,
  FLiteral,
  FNull,
  FNumber,
  FString,
  FUnknown,
  NumberOptions,
  StringOptions,
} from './types.ts';

/* @__NO_SIDE_EFFECTS__ */
export function string(opts: StringOptions = {}): FString {
  const { minLength, maxLength, pattern } = opts;
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
          return { issues: [{ message: 'Expected string' }] };
        if (minLength !== undefined && v.length < minLength)
          return { issues: [{ message: 'Too short' }] };
        if (maxLength !== undefined && v.length > maxLength)
          return { issues: [{ message: 'Too long' }] };
        if (regex !== undefined && !regex.test(v))
          return { issues: [{ message: 'Pattern mismatch' }] };
        return { value: v };
      },
    },
  } as FString;
}

/* @__NO_SIDE_EFFECTS__ */
export function number(opts: NumberOptions = {}): FNumber {
  const { minimum, maximum } = opts;
  return {
    'type': 'number',
    ...(minimum !== undefined && { minimum }),
    ...(maximum !== undefined && { maximum }),
    '~standard': {
      version: 1,
      vendor: 'fetcher',
      validate(v): StandardSchemaV1Result<number> {
        if (typeof v !== 'number' || Number.isNaN(v))
          return { issues: [{ message: 'Expected number' }] };
        if (minimum !== undefined && v < minimum)
          return { issues: [{ message: 'Too small' }] };
        if (maximum !== undefined && v > maximum)
          return { issues: [{ message: 'Too large' }] };
        return { value: v };
      },
    },
  } as FNumber;
}

/* @__NO_SIDE_EFFECTS__ */
export function integer(opts: NumberOptions = {}): FInteger {
  const { minimum, maximum } = opts;
  return {
    'type': 'integer',
    ...(minimum !== undefined && { minimum }),
    ...(maximum !== undefined && { maximum }),
    '~standard': {
      version: 1,
      vendor: 'fetcher',
      validate(v): StandardSchemaV1Result<number> {
        if (typeof v !== 'number' || !Number.isInteger(v))
          return { issues: [{ message: 'Expected integer' }] };
        if (minimum !== undefined && v < minimum)
          return { issues: [{ message: 'Too small' }] };
        if (maximum !== undefined && v > maximum)
          return { issues: [{ message: 'Too large' }] };
        return { value: v };
      },
    },
  } as FInteger;
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
          return { issues: [{ message: 'Expected boolean' }] };
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
          return { issues: [{ message: 'Expected null' }] };
        return { value: v };
      },
    },
  } as FNull;
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
          return { issues: [{ message: 'Not in enum' }] };
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
