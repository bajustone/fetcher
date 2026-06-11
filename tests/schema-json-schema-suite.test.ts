/**
 * Vendored subset of the official JSON-Schema-Test-Suite (draft2020-12) for
 * the keywords the native builder supports, run data-driven through the
 * builder's own factories.
 *
 * Source: https://github.com/json-schema-org/JSON-Schema-Test-Suite
 * (tests/draft2020-12/*.json) — cases are inlined here on purpose: no
 * network or git dependency.
 *
 * Adaptation notes (deliberate, documented divergences from the raw suite):
 * - Builder schemas are TYPED, so every vendored schema carries an explicit
 *   `type`. The suite's "keyword is ignored for other instance types" rows
 *   (e.g. `maxLength: 2` accepting `100`) are omitted — the builder
 *   intentionally rejects type mismatches instead of ignoring keywords.
 * - Keywords outside the supported set (`$ref`-graph cases, `unevaluated*`,
 *   `contains`, …) are out of scope by design (see docs/architecture.md).
 *
 * Includes the float traps homegrown engines classically fail:
 * 0.0075 % 0.0001, the 1e308 overflow trap, and the astral-emoji
 * maxLength case (lengths are CODE POINTS per RFC 8259).
 */

import type { FSchema } from '../src/schema/index.ts';
import type { StandardSchemaV1Result } from '../src/types.ts';
import { describe, expect, it } from 'bun:test';
import {
  array,
  boolean,
  enum_,
  integer,
  literal,
  null_,
  number,
  object,
  optional,
  string,
  unknown,
} from '../src/schema/index.ts';

// ---------------------------------------------------------------------------
// Local JSON Schema → builder mapper (supported keyword subset only)
// ---------------------------------------------------------------------------

interface SuiteSchema {
  type?: string;
  properties?: Record<string, SuiteSchema>;
  required?: string[];
  enum?: Array<string | number | boolean>;
  const?: string | number | boolean;
  items?: SuiteSchema;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
}

function build(s: SuiteSchema): FSchema<unknown> {
  if (s.enum !== undefined)
    return enum_(s.enum);
  if (s.const !== undefined)
    return literal(s.const);
  switch (s.type) {
    case 'string':
      return string({
        ...(s.minLength !== undefined && { minLength: s.minLength }),
        ...(s.maxLength !== undefined && { maxLength: s.maxLength }),
        ...(s.pattern !== undefined && { pattern: s.pattern }),
      });
    case 'number':
    case 'integer': {
      const opts = {
        ...(s.minimum !== undefined && { minimum: s.minimum }),
        ...(s.maximum !== undefined && { maximum: s.maximum }),
        ...(s.exclusiveMinimum !== undefined && { exclusiveMinimum: s.exclusiveMinimum }),
        ...(s.exclusiveMaximum !== undefined && { exclusiveMaximum: s.exclusiveMaximum }),
        ...(s.multipleOf !== undefined && { multipleOf: s.multipleOf }),
      };
      return s.type === 'integer' ? integer(opts) : number(opts);
    }
    case 'boolean':
      return boolean();
    case 'null':
      return null_();
    case 'array':
      return array(s.items ? build(s.items) : unknown(), {
        ...(s.minItems !== undefined && { minItems: s.minItems }),
        ...(s.maxItems !== undefined && { maxItems: s.maxItems }),
      });
    case 'object': {
      const props: Record<string, unknown> = {};
      const required = new Set(s.required ?? []);
      for (const [key, sub] of Object.entries(s.properties ?? {})) {
        const built = build(sub);
        props[key] = required.has(key) ? built : optional(built);
      }
      return object(props as Parameters<typeof object>[0]);
    }
    default:
      return unknown();
  }
}

// ---------------------------------------------------------------------------
// Vendored cases — { description, schema, tests: [{ description, data, valid }] }
// ---------------------------------------------------------------------------

interface SuiteTest { description: string; data: unknown; valid: boolean }
interface SuiteGroup { description: string; schema: SuiteSchema; tests: SuiteTest[] }

const GROUPS: SuiteGroup[] = [
  {
    description: 'integer type matches integers',
    schema: { type: 'integer' },
    tests: [
      { description: 'an integer is an integer', data: 1, valid: true },
      { description: 'a float with zero fractional part is an integer', data: 1.0, valid: true },
      { description: 'a float is not an integer', data: 1.1, valid: false },
      { description: 'a string is not an integer', data: '1', valid: false },
      { description: 'a string is still not an integer, even if it looks like one', data: 'foo', valid: false },
      { description: 'an object is not an integer', data: {}, valid: false },
      { description: 'a boolean is not an integer', data: true, valid: false },
      { description: 'null is not an integer', data: null, valid: false },
    ],
  },
  {
    description: 'number type matches numbers',
    schema: { type: 'number' },
    tests: [
      { description: 'an integer is a number', data: 1, valid: true },
      { description: 'a float is a number', data: 1.1, valid: true },
      { description: 'a string is not a number', data: '1', valid: false },
      { description: 'null is not a number', data: null, valid: false },
    ],
  },
  {
    description: 'string type matches strings',
    schema: { type: 'string' },
    tests: [
      { description: 'a string is a string', data: 'foo', valid: true },
      { description: 'an empty string is still a string', data: '', valid: true },
      { description: 'a number is not a string', data: 1, valid: false },
    ],
  },
  {
    description: 'maxLength validation',
    schema: { type: 'string', maxLength: 2 },
    tests: [
      { description: 'shorter is valid', data: 'f', valid: true },
      { description: 'exact length is valid', data: 'fo', valid: true },
      { description: 'too long is invalid', data: 'foo', valid: false },
      // The official suite's astral case: 'two graphemes is long enough'.
      { description: 'two supplementary Unicode code points is long enough', data: '\u{1F4A9}\u{1F4A9}', valid: true },
    ],
  },
  {
    description: 'minLength validation',
    schema: { type: 'string', minLength: 2 },
    tests: [
      { description: 'longer is valid', data: 'foo', valid: true },
      { description: 'exact length is valid', data: 'fo', valid: true },
      { description: 'too short is invalid', data: 'f', valid: false },
      { description: 'one supplementary Unicode code point is not long enough', data: '\u{1F4A9}', valid: false },
    ],
  },
  {
    description: 'pattern validation',
    schema: { type: 'string', pattern: '^a*$' },
    tests: [
      { description: 'a matching pattern is valid', data: 'aaa', valid: true },
      { description: 'a non-matching pattern is invalid', data: 'abc', valid: false },
    ],
  },
  {
    description: 'patterns are not anchored by default and are case sensitive',
    schema: { type: 'string', pattern: 'a+' },
    tests: [
      { description: 'matches a substring', data: 'xxaayy', valid: true },
      { description: 'no match is invalid', data: 'xxyy', valid: false },
    ],
  },
  {
    description: 'minimum validation',
    schema: { type: 'number', minimum: 1.1 },
    tests: [
      { description: 'above the minimum is valid', data: 2.6, valid: true },
      { description: 'boundary point is valid', data: 1.1, valid: true },
      { description: 'below the minimum is invalid', data: 0.6, valid: false },
    ],
  },
  {
    description: 'maximum validation',
    schema: { type: 'number', maximum: 3.0 },
    tests: [
      { description: 'below the maximum is valid', data: 2.6, valid: true },
      { description: 'boundary point is valid', data: 3.0, valid: true },
      { description: 'above the maximum is invalid', data: 3.5, valid: false },
    ],
  },
  {
    description: 'exclusiveMinimum validation',
    schema: { type: 'number', exclusiveMinimum: 1.1 },
    tests: [
      { description: 'above the exclusiveMinimum is valid', data: 1.2, valid: true },
      { description: 'boundary point is invalid', data: 1.1, valid: false },
      { description: 'below the exclusiveMinimum is invalid', data: 0.6, valid: false },
    ],
  },
  {
    description: 'exclusiveMaximum validation',
    schema: { type: 'number', exclusiveMaximum: 3.0 },
    tests: [
      { description: 'below the exclusiveMaximum is valid', data: 2.2, valid: true },
      { description: 'boundary point is invalid', data: 3.0, valid: false },
      { description: 'above the exclusiveMaximum is invalid', data: 3.5, valid: false },
    ],
  },
  {
    description: 'by int (multipleOf)',
    schema: { type: 'number', multipleOf: 2 },
    tests: [
      { description: 'an int by int is valid', data: 10, valid: true },
      { description: 'an int by int fail is invalid', data: 7, valid: false },
    ],
  },
  {
    description: 'by number (multipleOf)',
    schema: { type: 'number', multipleOf: 1.5 },
    tests: [
      { description: 'zero is a multiple of anything', data: 0, valid: true },
      { description: '4.5 is a multiple of 1.5', data: 4.5, valid: true },
      { description: '35 is not a multiple of 1.5', data: 35, valid: false },
    ],
  },
  {
    description: 'by small number (multipleOf) — float trap',
    schema: { type: 'number', multipleOf: 0.0001 },
    tests: [
      { description: '0.0075 is a multiple of 0.0001', data: 0.0075, valid: true },
      { description: '0.00751 is not a multiple of 0.0001', data: 0.00751, valid: false },
    ],
  },
  {
    description: 'float division = inf (multipleOf overflow trap)',
    schema: { type: 'integer', multipleOf: 0.123456789 },
    tests: [
      { description: 'always invalid, but naive implementations may raise an overflow error', data: 1e308, valid: false },
    ],
  },
  {
    description: 'small multiple of large integer',
    schema: { type: 'integer', multipleOf: 1e-8 },
    tests: [
      { description: 'any integer is a multiple of 1e-8', data: 12391239123, valid: true },
    ],
  },
  {
    description: 'required validation',
    schema: {
      type: 'object',
      properties: { foo: { type: 'string' }, bar: { type: 'number' } },
      required: ['foo'],
    },
    tests: [
      { description: 'present required property is valid', data: { foo: 'a' }, valid: true },
      { description: 'non-present required property is invalid', data: { bar: 1 }, valid: false },
    ],
  },
  {
    description: 'object properties validation',
    schema: {
      type: 'object',
      properties: { foo: { type: 'integer' }, bar: { type: 'string' } },
      required: ['foo', 'bar'],
    },
    tests: [
      { description: 'both properties present and valid is valid', data: { foo: 1, bar: 'baz' }, valid: true },
      { description: 'one property invalid is invalid', data: { foo: 1, bar: {} }, valid: false },
      { description: 'both properties invalid is invalid', data: { foo: [], bar: {} }, valid: false },
    ],
  },
  {
    description: 'enum validation',
    schema: { type: 'number', enum: [1, 2, 3] },
    tests: [
      { description: 'one of the enum is valid', data: 1, valid: true },
      { description: 'something else is invalid', data: 4, valid: false },
    ],
  },
  {
    description: 'enums in properties',
    schema: {
      type: 'object',
      properties: { foo: { type: 'string', enum: ['foo'] }, bar: { type: 'string', enum: ['bar'] } },
      required: ['bar'],
    },
    tests: [
      { description: 'both properties are valid', data: { foo: 'foo', bar: 'bar' }, valid: true },
      { description: 'wrong foo value', data: { foo: 'foot', bar: 'bar' }, valid: false },
      { description: 'missing optional property is valid', data: { bar: 'bar' }, valid: true },
      { description: 'missing required property is invalid', data: { foo: 'foo' }, valid: false },
    ],
  },
  {
    description: 'const validation',
    schema: { type: 'number', const: 2 },
    tests: [
      { description: 'same value is valid', data: 2, valid: true },
      { description: 'another value is invalid', data: 5, valid: false },
    ],
  },
  {
    description: 'items validation (every element)',
    schema: { type: 'array', items: { type: 'integer' } },
    tests: [
      { description: 'valid items', data: [1, 2, 3], valid: true },
      { description: 'wrong type of items', data: [1, 'x'], valid: false },
      { description: 'empty array is valid', data: [], valid: true },
    ],
  },
  {
    description: 'minItems validation',
    schema: { type: 'array', minItems: 1 },
    tests: [
      { description: 'longer is valid', data: [1, 2], valid: true },
      { description: 'exact length is valid', data: [1], valid: true },
      { description: 'too short is invalid', data: [], valid: false },
    ],
  },
  {
    description: 'maxItems validation',
    schema: { type: 'array', maxItems: 2 },
    tests: [
      { description: 'shorter is valid', data: [1], valid: true },
      { description: 'exact length is valid', data: [1, 2], valid: true },
      { description: 'too long is invalid', data: [1, 2, 3], valid: false },
    ],
  },
  {
    description: 'nested items',
    schema: { type: 'array', items: { type: 'array', items: { type: 'number' } } },
    tests: [
      { description: 'valid nested array', data: [[1, 2], [3]], valid: true },
      { description: 'wrongly nested', data: [[1, 'x']], valid: false },
    ],
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

describe('JSON-Schema-Test-Suite (draft2020-12 vendored subset, via the builder)', () => {
  for (const group of GROUPS) {
    describe(group.description, () => {
      const schema = build(group.schema);
      const validate = schema['~standard'].validate as (v: unknown) => StandardSchemaV1Result<unknown>;
      for (const t of group.tests) {
        it(t.description, () => {
          const r = validate(t.data);
          expect(!r.issues, `data=${JSON.stringify(t.data)} → ${JSON.stringify(r)}`).toBe(t.valid);
        });
      }
    });
  }
});
