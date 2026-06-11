/**
 * Format helpers — each pairs a `format` keyword (for OpenAPI/spec
 * compliance) with a `pattern` (for runtime enforcement). Produces plain
 * `FString` schemas with pre-compiled regex validation.
 *
 * Every regex is flag-free, so the emitted `pattern` (`regex.source`) and
 * the runtime check are guaranteed to agree — JSON Schema patterns cannot
 * express regex flags. All regexes are linear-time (no ambiguous
 * repetition; the email regex is the WHATWG HTML5 form, the canonical
 * ReDoS-safe reference also shipped by Zod v4 as `z.regexes.html5Email`).
 *
 * @module
 */

import type { StandardSchemaV1Result } from '../types.ts';
import type { FString } from './types.ts';

/*
 * regexp/use-ignore-case is disabled for the literals below ON PURPOSE: the
 * emitted JSON Schema `pattern` is `regex.source`, and JSON Schema patterns
 * cannot carry regex flags — an /i flag would make the runtime accept values
 * the serialized schema rejects. Case-insensitivity must be spelled out in
 * the character classes so source === behavior.
 */

// WHATWG HTML5 `input[type=email]` grammar — a documented "willful
// violation" of RFC 5322, battle-tested and linear-time (bounded {0,61}
// label repetitions over disjoint positions). Rejects consecutive dots in
// the domain, leading/trailing domain dots, and bare-hyphen labels.
// eslint-disable-next-line regexp/use-ignore-case
const emailRE = /^[\w.!#$%&'*+/=?^`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
// URL with an explicit authority (`scheme://…`) — stricter than the full
// RFC 3986 URI grammar (`mailto:`/`urn:` forms are rejected by design).
// eslint-disable-next-line regexp/use-ignore-case
const urlRE = /^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\/\S+$/;
// Accepts UUID versions 1–8 (RFC 9562 widened the version space; v7 is now a
// common default for new IDs) plus the all-zero nil UUID and the all-F max
// UUID, neither of which carry the standard version/variant nibbles.
// eslint-disable-next-line regexp/use-ignore-case
const uuidRE = /^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$/;
// RFC 3339 component shapes with field range checks (month 01-12, day
// 01-31, hour 00-23, minute/second 00-59, offset hour 00-23) — still pure
// linear-time regex; calendar validity (per-month day counts, leap years)
// is intentionally not checked.
const DATE_SRC = '\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])';
const TIME_SRC = '(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?';
const OFFSET_SRC = '(?:Z|[+-](?:[01]\\d|2[0-3]):[0-5]\\d)';
const datetimeRE = new RegExp(`^${DATE_SRC}T${TIME_SRC}${OFFSET_SRC}$`);
const dateRE = new RegExp(`^${DATE_SRC}$`);
const timeRE = new RegExp(`^${TIME_SRC}${OFFSET_SRC}?$`);

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
          return { issues: [{ code: 'expected_string', message: 'Expected string' }] };
        if (!regex.test(v))
          return { issues: [{ code: 'pattern_mismatch', message: 'Pattern mismatch' }] };
        return { value: v };
      },
    },
  } as FString;
}

/**
 * Email string schema (`format: 'email'`). Enforces the WHATWG HTML5
 * email grammar — the same set of addresses a browser
 * `input[type=email]` accepts.
 */
/* @__NO_SIDE_EFFECTS__ */
export const email = (): FString => formatString('email', emailRE);

/**
 * URL string schema (`format: 'uri'`). Requires an explicit
 * `scheme://` authority — scheme-only URIs (`mailto:`, `urn:`) are
 * rejected, which is stricter than the full RFC 3986 `uri` grammar.
 */
/* @__NO_SIDE_EFFECTS__ */
export const url = (): FString => formatString('uri', urlRE);

/**
 * UUID string schema (`format: 'uuid'`). RFC 9562: versions 1–8 plus the
 * nil and max UUIDs, any letter case.
 */
/* @__NO_SIDE_EFFECTS__ */
export const uuid = (): FString => formatString('uuid', uuidRE);

/**
 * RFC 3339 date-time string schema (`format: 'date-time'`), e.g.
 * `2026-01-02T03:04:05Z`. Field ranges are enforced (month 01-12, day
 * 01-31, hour 00-23, minute/second 00-59, offset `Z` or `±hh:mm`);
 * calendar validity (e.g. Feb 30) is not.
 */
/* @__NO_SIDE_EFFECTS__ */
export const datetime = (): FString => formatString('date-time', datetimeRE);

/**
 * RFC 3339 full-date string schema (`format: 'date'`), e.g. `2026-01-02`.
 * Month/day ranges enforced; calendar validity is not.
 */
/* @__NO_SIDE_EFFECTS__ */
export const date = (): FString => formatString('date', dateRE);

/**
 * RFC 3339 time string schema (`format: 'time'`), e.g. `03:04:05` or
 * `03:04:05.123Z`. Field ranges enforced; the UTC offset is optional.
 */
/* @__NO_SIDE_EFFECTS__ */
export const time = (): FString => formatString('time', timeRE);
