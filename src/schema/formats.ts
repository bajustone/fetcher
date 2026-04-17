/**
 * Format helpers — each pairs a `format` keyword (for OpenAPI/spec
 * compliance) with a `pattern` (for runtime enforcement). Produces plain
 * `FString` schemas with pre-compiled regex validation.
 *
 * @module
 */

import type { StandardSchemaV1Result } from '../types.ts';
import type { FString } from './types.ts';

const emailRE = /^[^\s@]+@[^\s@][^\s.@]*\.[^\s@]+$/;
const urlRE = /^[a-z][a-z0-9+\-.]*:\/\/\S+$/i;
const uuidRE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const datetimeRE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const dateRE = /^\d{4}-\d{2}-\d{2}$/;
const timeRE = /^\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/;

function formatString(formatName: string, regex: RegExp): FString {
  return {
    'type': 'string',
    'format': formatName,
    'pattern': regex.source,
    '~standard': {
      version: 1,
      vendor: 'fetcher',
      validate(v): StandardSchemaV1Result<string> {
        if (typeof v !== 'string')
          return { issues: [{ message: 'Expected string' }] };
        if (!regex.test(v))
          return { issues: [{ message: 'Pattern mismatch' }] };
        return { value: v };
      },
    },
  } as FString;
}

/* @__NO_SIDE_EFFECTS__ */
export const email = (): FString => formatString('email', emailRE);

/* @__NO_SIDE_EFFECTS__ */
export const url = (): FString => formatString('uri', urlRE);

/* @__NO_SIDE_EFFECTS__ */
export const uuid = (): FString => formatString('uuid', uuidRE);

/* @__NO_SIDE_EFFECTS__ */
export const datetime = (): FString => formatString('date-time', datetimeRE);

/* @__NO_SIDE_EFFECTS__ */
export const date = (): FString => formatString('date', dateRE);

/* @__NO_SIDE_EFFECTS__ */
export const time = (): FString => formatString('time', timeRE);
