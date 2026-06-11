/**
 * Standard Schema V1 conformance tests, in the style Zod uses
 * (packages/zod/src/v4/classic/tests/standard-schema.test.ts): there is no
 * official compliance suite — the spec repo ships only types — so libraries
 * verify by (1) assigning their schemas to a locally-declared copy of the
 * published `StandardSchemaV1` interface (compile-time structural check) and
 * (2) behavior-testing `~standard.validate` result shapes directly.
 *
 * The interface below is copied verbatim from the spec
 * (https://github.com/standard-schema/standard-schema — copy-pasting is
 * officially sanctioned) rather than imported from fetcher's own types, so
 * a drift in fetcher's inlined types would surface here as a compile error.
 */

import { describe, expect, it } from 'bun:test';
import {
  array,
  boolean,
  compile,
  date,
  datetime,
  default_,
  discriminatedUnion,
  email,
  enum_,
  integer,
  intersect,
  literal,
  null_,
  nullable,
  number,
  object,
  optional,
  record,
  ref,
  refined,
  string,
  time,
  transform,
  tuple,
  union,
  unknown,
  url,
  uuid,
} from '../src/schema/index.ts';

// ---------------------------------------------------------------------------
// Local copy of the Standard Schema V1 interface (spec-published shape)
// ---------------------------------------------------------------------------

interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardSchemaV1.Props<Input, Output>;
}

// The upstream spec publishes its types as an interface + namespace pair;
// this is a verbatim copy, kept structurally identical on purpose.
// eslint-disable-next-line ts/no-namespace
declare namespace StandardSchemaV1 {
  export interface Props<Input = unknown, Output = Input> {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => Result<Output> | Promise<Result<Output>>;
    readonly types?: Types<Input, Output> | undefined;
  }
  export type Result<Output> = SuccessResult<Output> | FailureResult;
  export interface SuccessResult<Output> {
    readonly value: Output;
    readonly issues?: undefined;
  }
  export interface FailureResult {
    readonly issues: ReadonlyArray<Issue>;
  }
  export interface Issue {
    readonly message: string;
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
  }
  export interface PathSegment {
    readonly key: PropertyKey;
  }
  export interface Types<Input = unknown, Output = Input> {
    readonly input: Input;
    readonly output: Output;
  }
  export type InferInput<S extends StandardSchemaV1> = NonNullable<S['~standard']['types']>['input'];
  export type InferOutput<S extends StandardSchemaV1> = NonNullable<S['~standard']['types']>['output'];
}

/**
 * The spec's reference consumer: how any third-party Standard Schema
 * consumer is told to call a schema (sync-only flavor).
 */
function standardValidate<T>(schema: StandardSchemaV1<unknown, T>, input: unknown): StandardSchemaV1.Result<T> {
  const result = schema['~standard'].validate(input);
  if (result instanceof Promise)
    throw new TypeError('Schema validation must be synchronous');
  return result;
}

// ---------------------------------------------------------------------------
// Compile-time: every factory output assigns to the spec interface
// ---------------------------------------------------------------------------

const assignability: StandardSchemaV1[] = [
  string(),
  number(),
  integer(),
  boolean(),
  null_(),
  literal('x'),
  unknown(),
  enum_(['a', 'b']),
  email(),
  url(),
  uuid(),
  datetime(),
  date(),
  time(),
  object({ a: string(), b: optional(number()) }),
  array(string()),
  record(number()),
  tuple([string(), number()]),
  union([string(), number()]),
  intersect([object({ a: string() }), object({ b: number() })]),
  discriminatedUnion('t', { a: object({ t: literal('a') }) }),
  nullable(string()),
  optional(string()),
  default_(string(), 'd'),
  refined(string(), s => s.length > 0),
  transform(string(), s => s.length),
  ref('X'),
];

const typedAssign: StandardSchemaV1<unknown, string> = string();
void typedAssign;

describe('Standard Schema V1 conformance', () => {
  it('every factory result has the required ~standard props', () => {
    for (const schema of assignability) {
      const std = schema['~standard'];
      expect(std.version).toBe(1);
      expect(std.vendor).toBe('fetcher');
      expect(typeof std.validate).toBe('function');
    }
  });

  it('all bundled validators are synchronous (never return a Promise)', () => {
    for (const schema of assignability) {
      const r = schema['~standard'].validate('probe');
      expect(r instanceof Promise).toBe(false);
    }
  });

  it('success result is { value } with falsy issues', () => {
    const r = standardValidate(string(), 'hello');
    expect(r.issues).toBeUndefined();
    if (!r.issues)
      expect(r.value).toBe('hello');
  });

  it('failure result is { issues: [{ message, path? }] } with string messages', () => {
    const r = standardValidate(string(), 42);
    expect(r.issues).toBeDefined();
    if (r.issues) {
      expect(r.issues.length).toBeGreaterThan(0);
      for (const issue of r.issues) {
        expect(typeof issue.message).toBe('string');
        if (issue.path !== undefined)
          expect(Array.isArray(issue.path)).toBe(true);
      }
    }
  });

  it('nested failures carry PropertyKey path segments in document order', () => {
    const S = object({
      user: object({ pets: array(object({ name: string() })) }),
    });
    const r = standardValidate(S, { user: { pets: [{ name: 'ok' }, { name: 42 }] } });
    expect(r.issues).toBeDefined();
    if (r.issues) {
      const path = r.issues[0]!.path!;
      expect(path).toEqual(['user', 'pets', 1, 'name']);
      for (const seg of path) {
        const t = typeof seg;
        expect(t === 'string' || t === 'number' || t === 'symbol' || (t === 'object' && seg !== null && 'key' in (seg as object))).toBe(true);
      }
    }
  });

  it('getDotPath-style consumers can join the emitted segments', () => {
    // Mirrors @standard-schema/utils getDotPath: object segments expose .key.
    const dotPath = (issue: StandardSchemaV1.Issue): string | null => {
      if (!issue.path?.length)
        return null;
      let out = '';
      for (const seg of issue.path) {
        const key = typeof seg === 'object' ? seg.key : seg;
        if (typeof key === 'symbol')
          return null;
        out += out ? `.${String(key)}` : String(key);
      }
      return out;
    };
    const S = object({ a: object({ b: integer() }) });
    const r = standardValidate(S, { a: { b: 'no' } });
    expect(r.issues).toBeDefined();
    if (r.issues)
      expect(dotPath(r.issues[0]!)).toBe('a.b');
  });

  it('extra issue fields (code) are additive and spec-safe', () => {
    // The spec permits extra fields; consumers must only rely on message/path.
    const r = standardValidate(integer(), 'x');
    if (r.issues) {
      const issue = r.issues[0] as { message: string; code?: string };
      expect(typeof issue.message).toBe('string');
      expect(issue.code).toBe('expected_integer');
    }
  });

  it('root-level failures have no path (or an empty one)', () => {
    const r = standardValidate(number(), 'NaN');
    if (r.issues)
      expect(r.issues[0]!.path === undefined || r.issues[0]!.path.length === 0).toBe(true);
  });

  it('validate is pure on the result envelope: same shape across repeated calls', () => {
    const S = compile(object({ next: optional(ref('S')) }), {});
    void S;
    const T = object({ a: string() });
    const r1 = standardValidate(T, { a: 'x' });
    const r2 = standardValidate(T, { a: 'x' });
    expect(r1.issues).toBeUndefined();
    expect(r2.issues).toBeUndefined();
  });

  it('transforms surface through the standard result value', () => {
    const S = transform(string(), s => s.length);
    const r = standardValidate(S, 'four');
    if (!r.issues)
      expect(r.value).toBe(4);
  });

  it('a third-party consumer loop works end to end', () => {
    // A consumer that knows nothing about fetcher — only the spec.
    const schemas: Array<[StandardSchemaV1, unknown, boolean]> = [
      [string(), 'ok', true],
      [string(), 1, false],
      [object({ id: integer() }), { id: 1 }, true],
      [object({ id: integer() }), { id: 'x' }, false],
      [union([string(), number()]), true, false],
    ];
    for (const [schema, input, valid] of schemas) {
      const r = standardValidate(schema, input);
      expect(!r.issues).toBe(valid);
    }
  });
});
