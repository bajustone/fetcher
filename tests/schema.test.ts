import type { FSchema, Infer } from '../src/schema/index.ts';
import type { StandardSchemaV1Result } from '../src/types.ts';
import { describe, expect, it } from 'bun:test';
import { fromJSONSchema } from '../src/from-json-schema.ts';
import {
  any_,
  array,
  bigint_,
  boolean,
  brand,
  compile,
  date,
  datetime,
  default_,
  describe as describeSchema,
  discriminatedUnion,
  email,
  enum_,
  extend,
  finite,
  formatIssues,
  integer,
  intersect,
  keyof_,
  literal,
  merge,
  negative,
  never_,
  nonnegative,
  nonpositive,
  null_,
  nullable,
  number,
  object,
  omit,
  optional,
  parse,
  parseOrThrow,
  partial,
  pick,
  positive,
  record,
  ref,
  refined,
  required,
  safe,
  SchemaValidationError,
  string,
  time,
  title,
  transform,
  tuple,
  undefined_,
  union,
  unknown,
  url,
  uuid,
} from '../src/schema/index.ts';

function run<T>(schema: FSchema<T>, value: unknown): StandardSchemaV1Result<T> {
  return schema['~standard'].validate(value) as StandardSchemaV1Result<T>;
}

function ok<T>(r: StandardSchemaV1Result<T>): T {
  if (r.issues)
    throw new Error(`Expected ok but got issues: ${JSON.stringify(r.issues)}`);
  return r.value as T;
}

function issues<T>(r: StandardSchemaV1Result<T>) {
  if (!r.issues)
    throw new Error(`Expected issues but got value: ${JSON.stringify(r.value)}`);
  return r.issues;
}

describe('primitives', () => {
  it('string — type + constraints', () => {
    const s = string({ minLength: 2, maxLength: 5, pattern: '^[a-z]+$' });
    expect(ok(run(s, 'abc'))).toBe('abc');
    expect(issues(run(s, 42))[0]!.message).toBe('Expected string');
    expect(issues(run(s, 'a'))[0]!.message).toBe('Too short');
    expect(issues(run(s, 'abcdef'))[0]!.message).toBe('Too long');
    expect(issues(run(s, 'ABC'))[0]!.message).toBe('Pattern mismatch');
  });

  it('number and integer', () => {
    expect(ok(run(number({ minimum: 0, maximum: 10 }), 5))).toBe(5);
    expect(issues(run(number(), 'x'))[0]!.message).toBe('Expected number');
    expect(issues(run(number({ minimum: 0 }), -1))[0]!.message).toBe('Too small');
    expect(issues(run(number({ maximum: 10 }), 11))[0]!.message).toBe('Too large');

    expect(ok(run(integer(), 3))).toBe(3);
    expect(issues(run(integer(), 3.14))[0]!.message).toBe('Expected integer');
  });

  it('boolean, null_, literal, unknown', () => {
    expect(ok(run(boolean(), true))).toBe(true);
    expect(issues(run(boolean(), 1))[0]!.message).toBe('Expected boolean');
    expect(ok(run(null_(), null))).toBe(null);
    expect(issues(run(null_(), undefined))[0]!.message).toBe('Expected null');
    expect(ok(run(literal('x' as const), 'x'))).toBe('x');
    expect(issues(run(literal(42 as const), 43))[0]!.message).toBe('Not in enum');
    expect(ok(run(unknown(), { whatever: true }))).toEqual({ whatever: true });
  });

  it('emits plain JSON Schema shape', () => {
    const s = string({ minLength: 3 });
    expect(s.type).toBe('string');
    expect(s.minLength).toBe(3);
    const n = number({ minimum: 0 });
    expect(n.type).toBe('number');
    expect(n.minimum).toBe(0);
  });
});

describe('object', () => {
  it('required vs optional keys', () => {
    const Pet = object({
      id: integer(),
      name: string(),
      tag: optional(string()),
    });
    expect(Pet.required).toEqual(['id', 'name']);
    expect(ok(run(Pet, { id: 1, name: 'Rex' }))).toEqual({ id: 1, name: 'Rex' });
    expect(ok(run(Pet, { id: 1, name: 'Rex', tag: 'dog' }))).toEqual({ id: 1, name: 'Rex', tag: 'dog' });
    const r = run(Pet, { id: 1 });
    expect(r.issues?.[0]!.message).toBe('Missing');
    expect(r.issues?.[0]!.path).toEqual(['name']);
  });

  it('propagates nested errors with path', () => {
    const Schema = object({ user: object({ email: string({ pattern: '^.+@.+$' }) }) });
    const r = run(Schema, { user: { email: 'invalid' } });
    expect(r.issues?.[0]!.path).toEqual(['user', 'email']);
  });

  it('rejects non-objects and arrays', () => {
    const S = object({ x: integer() });
    expect(issues(run(S, 'str'))[0]!.message).toBe('Expected object');
    expect(issues(run(S, [1, 2]))[0]!.message).toBe('Expected object');
    expect(issues(run(S, null))[0]!.message).toBe('Expected object');
  });

  it('optional wrapper does not leak into emitted properties', () => {
    const S = object({ tag: optional(string()) });
    expect(S.properties.tag).not.toHaveProperty('~optional');
    expect((S.properties.tag as unknown as { type: string }).type).toBe('string');
    expect(S.required).toEqual([]);
  });
});

describe('array', () => {
  it('validates item type and bounds', () => {
    const S = array(integer(), { minItems: 1, maxItems: 3 });
    expect(ok(run(S, [1, 2]))).toEqual([1, 2]);
    expect(issues(run(S, 'x'))[0]!.message).toBe('Expected array');
    expect(issues(run(S, []))[0]!.message).toBe('Too short');
    expect(issues(run(S, [1, 2, 3, 4]))[0]!.message).toBe('Too long');
    const r = run(S, [1, 'bad']);
    expect(r.issues?.[0]!.path).toEqual([1]);
    expect(r.issues?.[0]!.message).toBe('Expected integer');
  });
});

describe('optional, nullable, union, intersect, enum', () => {
  it('optional accepts undefined at top level', () => {
    const S = optional(string());
    expect(ok(run(S, undefined))).toBe(undefined);
    expect(ok(run(S, 'hi'))).toBe('hi');
  });

  it('nullable accepts null or the inner schema', () => {
    const S = nullable(integer());
    expect(ok(run(S, null))).toBe(null);
    expect(ok(run(S, 42))).toBe(42);
    expect(issues(run(S, 'x'))[0]!.message).toBe('Expected integer');
  });

  it('union matches any variant', () => {
    const S = union([string(), integer()]);
    expect(ok(run(S, 'hi'))).toBe('hi');
    expect(ok(run(S, 3))).toBe(3);
    expect(issues(run(S, true))[0]!.message).toBe('No variant matched');
  });

  it('intersect requires all', () => {
    const A = object({ a: integer() });
    const B = object({ b: string() });
    const S = intersect([A, B]);
    expect(ok(run(S, { a: 1, b: 'x' }))).toEqual({ a: 1, b: 'x' });
    expect(issues(run(S, { a: 1 })).length).toBeGreaterThan(0);
  });

  it('enum_ matches by equality', () => {
    const Color = enum_(['red', 'green', 'blue'] as const);
    expect(ok(run(Color, 'red'))).toBe('red');
    expect(issues(run(Color, 'yellow'))[0]!.message).toBe('Not in enum');
  });
});

describe('formats', () => {
  it('email/url/uuid/datetime/date/time', () => {
    expect(ok(run(email(), 'a@b.com'))).toBe('a@b.com');
    expect(issues(run(email(), 'nope'))[0]!.message).toBe('Pattern mismatch');

    expect(ok(run(url(), 'https://example.com/x'))).toBe('https://example.com/x');
    expect(issues(run(url(), 'not a url'))[0]!.message).toBe('Pattern mismatch');

    expect(ok(run(uuid(), '123e4567-e89b-12d3-a456-426614174000'))).toBe('123e4567-e89b-12d3-a456-426614174000');
    expect(issues(run(uuid(), 'not-a-uuid'))[0]!.message).toBe('Pattern mismatch');

    expect(ok(run(datetime(), '2024-01-02T03:04:05Z'))).toBe('2024-01-02T03:04:05Z');
    expect(issues(run(datetime(), '2024-01-02'))[0]!.message).toBe('Pattern mismatch');

    expect(ok(run(date(), '2024-01-02'))).toBe('2024-01-02');
    expect(issues(run(date(), 'Jan 2'))[0]!.message).toBe('Pattern mismatch');

    expect(ok(run(time(), '03:04:05'))).toBe('03:04:05');
    expect(issues(run(time(), 'noon'))[0]!.message).toBe('Pattern mismatch');
  });

  it('emits both format and pattern', () => {
    const e = email();
    expect(e.type).toBe('string');
    expect(e.format).toBe('email');
    expect(typeof e.pattern).toBe('string');
  });
});

describe('discriminatedUnion', () => {
  it('dispatches by discriminator key', () => {
    const Shape = discriminatedUnion('kind', {
      circle: object({ kind: literal('circle' as const), radius: number() }),
      square: object({ kind: literal('square' as const), side: number() }),
    });
    expect(ok(run(Shape, { kind: 'circle', radius: 1 }))).toEqual({ kind: 'circle', radius: 1 });
    expect(ok(run(Shape, { kind: 'square', side: 2 }))).toEqual({ kind: 'square', side: 2 });
    const r = run(Shape, { kind: 'triangle', side: 3 });
    expect(r.issues?.[0]!.message).toBe('Unknown discriminator');
    expect(r.issues?.[0]!.path).toEqual(['kind']);
  });

  it('rejects non-objects', () => {
    const S = discriminatedUnion('kind', { a: object({ kind: literal('a' as const) }) });
    expect(issues(run(S, 'nope'))[0]!.message).toBe('Expected object');
  });
});

describe('ref + compile', () => {
  it('unresolved ref fails cleanly', () => {
    const S = ref<string>('Pet');
    expect(issues(run(S, {}))[0]!.message).toBe('Unresolved $ref');
  });

  it('binds refs and handles self-recursion', () => {
    interface TreeNode { value: number; children: TreeNode[] }
    const Tree = object({ value: number(), children: array(ref<TreeNode>('Tree')) });
    compile(Tree, { Tree });
    const good = { value: 1, children: [{ value: 2, children: [{ value: 3, children: [] }] }] };
    expect(ok(run(Tree, good))).toEqual(good);
    const bad = { value: 1, children: [{ value: 'nope', children: [] }] };
    const r = run(Tree, bad);
    expect(r.issues?.some(i => i.message === 'Expected number')).toBe(true);
  });

  it('binds refs inside union and discriminated variants', () => {
    const A = object({ kind: literal('a' as const) });
    const B = object({ kind: literal('b' as const), next: ref<unknown>('A') });
    const Shape = discriminatedUnion('kind', { a: A, b: B });
    compile(Shape, { A, B });
    expect(ok(run(Shape, { kind: 'b', next: { kind: 'a' } }))).toEqual({ kind: 'b', next: { kind: 'a' } });
  });
});

describe('fromJSONSchema', () => {
  it('round-trips primitives', () => {
    const s = fromJSONSchema<string>({ type: 'string', minLength: 2 });
    expect(ok(s['~standard'].validate('ab') as StandardSchemaV1Result<string>)).toBe('ab');
    expect(issues(s['~standard'].validate('a') as StandardSchemaV1Result<string>)[0]!.message).toBe('Too short');
  });

  it('round-trips object with optional keys', () => {
    const s = fromJSONSchema<{ id: number; tag?: string }>({
      type: 'object',
      properties: { id: { type: 'integer' }, tag: { type: 'string' } },
      required: ['id'],
    });
    expect(ok(s['~standard'].validate({ id: 1 }) as StandardSchemaV1Result<{ id: number }>)).toEqual({ id: 1 });
    expect(ok(s['~standard'].validate({ id: 1, tag: 'x' }) as StandardSchemaV1Result<{ id: number; tag?: string }>)).toEqual({ id: 1, tag: 'x' });
  });

  it('resolves $ref via defs argument', () => {
    const s = fromJSONSchema(
      {
        type: 'object',
        properties: { pet: { $ref: '#/components/schemas/Pet' } },
        required: ['pet'],
      },
      { Pet: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
    );
    expect(ok(s['~standard'].validate({ pet: { id: 1 } }) as StandardSchemaV1Result<unknown>)).toEqual({ pet: { id: 1 } });
    expect(issues(s['~standard'].validate({ pet: { id: 'nope' } }) as StandardSchemaV1Result<unknown>)[0]!.path).toEqual(['pet', 'id']);
  });

  it('resolves $ref via schema.$defs when defs arg omitted', () => {
    const s = fromJSONSchema({
      type: 'object',
      properties: { pet: { $ref: '#/$defs/Pet' } },
      required: ['pet'],
      $defs: {
        Pet: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
      },
    });
    expect(ok(s['~standard'].validate({ pet: { id: 1 } }) as StandardSchemaV1Result<unknown>)).toEqual({ pet: { id: 1 } });
  });

  it('handles oneOf with string discriminator', () => {
    const s = fromJSONSchema({
      oneOf: [
        { type: 'object', properties: { kind: { const: 'a' }, x: { type: 'integer' } }, required: ['kind', 'x'] },
        { type: 'object', properties: { kind: { const: 'b' }, y: { type: 'string' } }, required: ['kind', 'y'] },
      ],
      discriminator: { propertyName: 'kind' },
    });
    expect(ok(s['~standard'].validate({ kind: 'a', x: 1 }) as StandardSchemaV1Result<unknown>)).toEqual({ kind: 'a', x: 1 });
    expect(ok(s['~standard'].validate({ kind: 'b', y: 'hi' }) as StandardSchemaV1Result<unknown>)).toEqual({ kind: 'b', y: 'hi' });
  });

  it('handles OpenAPI 3.0 nullable', () => {
    const s = fromJSONSchema({ type: 'string', nullable: true });
    expect(ok(s['~standard'].validate(null) as StandardSchemaV1Result<unknown>)).toBe(null);
    expect(ok(s['~standard'].validate('x') as StandardSchemaV1Result<unknown>)).toBe('x');
  });
});

describe('Infer — type-level sanity (compile-time only)', () => {
  it('object with optional keys', () => {
    const _Pet = object({ id: integer(), tag: optional(string()) });
    type PetType = Infer<typeof _Pet>;
    const v: PetType = { id: 1 };
    const w: PetType = { id: 2, tag: 'x' };
    expect(v.id).toBe(1);
    expect(w.tag).toBe('x');
  });
});

describe('extended primitives', () => {
  it('undefined_ accepts only undefined', () => {
    expect(ok(run(undefined_(), undefined))).toBe(undefined);
    expect(issues(run(undefined_(), null))[0]!.code).toBe('expected_undefined');
  });

  it('any_ accepts anything', () => {
    expect(ok(run(any_(), 'x'))).toBe('x');
    expect(ok(run(any_(), 42))).toBe(42);
    expect(ok(run(any_(), null))).toBe(null);
  });

  it('never_ rejects everything', () => {
    expect(issues(run(never_(), 'x'))[0]!.code).toBe('never');
    expect(issues(run(never_(), undefined))[0]!.code).toBe('never');
  });

  it('bigint_ accepts only bigint', () => {
    expect(ok(run(bigint_(), 42n))).toBe(42n);
    expect(issues(run(bigint_(), 42))[0]!.code).toBe('expected_bigint');
  });

  it('positive / nonnegative / negative / nonpositive bounds', () => {
    expect(ok(run(positive(), 1))).toBe(1);
    expect(issues(run(positive(), 0))[0]!.code).toBe('too_small');
    expect(ok(run(nonnegative(), 0))).toBe(0);
    expect(issues(run(nonnegative(), -1))[0]!.code).toBe('too_small');
    expect(ok(run(negative(), -1))).toBe(-1);
    expect(issues(run(negative(), 0))[0]!.code).toBe('too_large');
    expect(ok(run(nonpositive(), 0))).toBe(0);
    expect(issues(run(nonpositive(), 1))[0]!.code).toBe('too_large');
  });

  it('finite rejects Infinity / NaN', () => {
    expect(ok(run(finite(), 1))).toBe(1);
    expect(issues(run(finite(), Infinity))[0]!.code).toBe('expected_number');
    expect(issues(run(finite(), Number.NaN))[0]!.code).toBe('expected_number');
  });

  it('safe bounds integers to MAX/MIN_SAFE_INTEGER', () => {
    expect(ok(run(safe(), 42))).toBe(42);
    expect(issues(run(safe(), Number.MAX_SAFE_INTEGER + 1))[0]!.code).toBe('too_large');
  });
});

describe('extended string constraints', () => {
  it('length (exact)', () => {
    const s = string({ length: 3 });
    expect(ok(run(s, 'abc'))).toBe('abc');
    expect(issues(run(s, 'ab'))[0]!.code).toBe('too_short');
    expect(issues(run(s, 'abcd'))[0]!.code).toBe('too_long');
  });

  it('startsWith / endsWith / includes', () => {
    expect(ok(run(string({ startsWith: 'hi' }), 'hi there'))).toBe('hi there');
    expect(issues(run(string({ startsWith: 'hi' }), 'bye'))[0]!.code).toBe('pattern_mismatch');
    expect(ok(run(string({ endsWith: '!' }), 'wow!'))).toBe('wow!');
    expect(issues(run(string({ endsWith: '!' }), 'wow'))[0]!.code).toBe('pattern_mismatch');
    expect(ok(run(string({ includes: 'xyz' }), 'abcxyzdef'))).toBe('abcxyzdef');
    expect(issues(run(string({ includes: 'xyz' }), 'abc'))[0]!.code).toBe('pattern_mismatch');
  });
});

describe('extended number constraints', () => {
  it('exclusiveMinimum / exclusiveMaximum', () => {
    expect(ok(run(number({ exclusiveMinimum: 0 }), 1))).toBe(1);
    expect(issues(run(number({ exclusiveMinimum: 0 }), 0))[0]!.code).toBe('too_small');
    expect(ok(run(number({ exclusiveMaximum: 10 }), 9))).toBe(9);
    expect(issues(run(number({ exclusiveMaximum: 10 }), 10))[0]!.code).toBe('too_large');
  });

  it('multipleOf', () => {
    expect(ok(run(integer({ multipleOf: 5 }), 10))).toBe(10);
    expect(issues(run(integer({ multipleOf: 5 }), 7))[0]!.code).toBe('not_a_multiple');
  });
});

describe('object composition', () => {
  const Pet = object({
    id: integer(),
    name: string(),
    tag: optional(string()),
  });

  it('partial makes all keys optional', () => {
    const P = partial(Pet);
    expect(P.required).toEqual([]);
    expect(ok(run(P, {}))).toEqual({});
    expect(ok(run(P, { id: 1 }))).toEqual({ id: 1 });
  });

  it('required makes all keys required', () => {
    const R = required(Pet);
    expect(R.required.slice().sort()).toEqual(['id', 'name', 'tag']);
    expect(issues(run(R, { id: 1, name: 'x' }))[0]!.code).toBe('missing');
  });

  it('pick selects only named keys', () => {
    const P = pick(Pet, ['id', 'name'] as const);
    expect(Object.keys(P.properties).sort()).toEqual(['id', 'name']);
    expect(P.required.slice().sort()).toEqual(['id', 'name']);
  });

  it('omit drops named keys', () => {
    const P = omit(Pet, ['tag'] as const);
    expect(Object.keys(P.properties).sort()).toEqual(['id', 'name']);
    expect(P.required.slice().sort()).toEqual(['id', 'name']);
  });

  it('extend adds new keys and overrides existing', () => {
    const E = extend(Pet, { age: integer(), name: string({ minLength: 2 }) });
    expect(Object.keys(E.properties).sort()).toEqual(['age', 'id', 'name', 'tag']);
    expect(E.required.slice().sort()).toEqual(['age', 'id', 'name']);
  });

  it('merge combines two object schemas', () => {
    const A = object({ a: integer() });
    const B = object({ b: string() });
    const M = merge(A, B);
    expect(Object.keys(M.properties).sort()).toEqual(['a', 'b']);
    expect(M.required.slice().sort()).toEqual(['a', 'b']);
  });

  it('keyof_ produces an enum of keys', () => {
    const K = keyof_(Pet);
    expect(K.enum.slice().sort()).toEqual(['id', 'name', 'tag']);
    expect(ok(run(K, 'id'))).toBe('id');
    expect(issues(run(K, 'bogus'))[0]!.code).toBe('not_in_enum');
  });
});

describe('record + tuple', () => {
  it('record validates string-keyed dictionary', () => {
    const Prices = record(number());
    expect(ok(run(Prices, { a: 1, b: 2 }))).toEqual({ a: 1, b: 2 });
    expect(issues(run(Prices, { a: 'nope' }))[0]!.path).toEqual(['a']);
    expect(issues(run(Prices, 42))[0]!.code).toBe('expected_object');
  });

  it('tuple validates fixed-length positional arrays', () => {
    const Pair = tuple([string(), number()]);
    expect(ok(run(Pair, ['a', 1]))).toEqual(['a', 1]);
    expect(issues(run(Pair, ['a']))[0]!.code).toBe('too_short');
    expect(issues(run(Pair, ['a', 1, 2]))[0]!.code).toBe('too_long');
    expect(issues(run(Pair, [1, 1]))[0]!.path).toEqual([0]);
  });
});

describe('brand + describe + title', () => {
  it('brand passes through at runtime', () => {
    const UserId = brand<'UserId'>()(integer());
    const v = ok(run(UserId, 42));
    expect(v as number).toBe(42);
  });

  it('describe attaches description', () => {
    const s = describeSchema(string(), 'User email');
    expect((s as unknown as { description: string }).description).toBe('User email');
    expect(ok(run(s, 'x'))).toBe('x');
  });

  it('title attaches title', () => {
    const s = title(string(), 'Email');
    expect((s as unknown as { title: string }).title).toBe('Email');
  });
});

describe('issue.code', () => {
  it('every builder error emits a code alongside message', () => {
    expect(issues(run(string(), 42))[0]!.code).toBe('expected_string');
    expect(issues(run(integer(), 3.14))[0]!.code).toBe('expected_integer');
    expect(issues(run(boolean(), 'yes'))[0]!.code).toBe('expected_boolean');
    expect(issues(run(null_(), 'x'))[0]!.code).toBe('expected_null');
    expect(issues(run(enum_(['a', 'b'] as const), 'c'))[0]!.code).toBe('not_in_enum');
    expect(issues(run(union([string(), number()]), true))[0]!.code).toBe('no_variant_matched');
    expect(issues(run(ref<unknown>('Missing'), 'x'))[0]!.code).toBe('unresolved_ref');
    const obj = object({ a: integer() });
    expect(issues(run(obj, {}))[0]!.code).toBe('missing');
    expect(issues(run(obj, 'x'))[0]!.code).toBe('expected_object');
    expect(issues(run(array(integer(), { minItems: 2 }), [1]))[0]!.code).toBe('too_short');
  });
});

describe('refined', () => {
  it('runs predicate after base validation', () => {
    const Https = refined(string(), s => s.startsWith('https://'), 'must be https');
    expect(ok(run(Https, 'https://example.com'))).toBe('https://example.com');
    const r = run(Https, 'http://example.com');
    expect(r.issues?.[0]!.code).toBe('refine_failed');
    expect(r.issues?.[0]!.message).toBe('must be https');
  });

  it('base schema failure short-circuits predicate', () => {
    let called = 0;
    const Gt3 = refined(integer(), (n) => {
      called++;
      return n > 3;
    });
    expect(issues(run(Gt3, 'nope'))[0]!.code).toBe('expected_integer');
    expect(called).toBe(0);
  });

  it('composes with existing constraints', () => {
    const Password = refined(
      string({ minLength: 8 }),
      s => /[A-Z]/.test(s) && /\d/.test(s),
      'must contain uppercase and digit',
    );
    expect(ok(run(Password, 'Secure1!'))).toBe('Secure1!');
    expect(issues(run(Password, 'short'))[0]!.code).toBe('too_short');
    expect(issues(run(Password, 'alllowercase1'))[0]!.code).toBe('refine_failed');
  });

  it('uses default message when none provided', () => {
    const Positive = refined(integer(), n => n > 0);
    expect(issues(run(Positive, -1))[0]!.message).toBe('Refinement failed');
  });
});

describe('default_', () => {
  it('substitutes fallback on undefined input', () => {
    const D = default_(string(), 'fallback');
    expect(ok(run(D, undefined))).toBe('fallback');
    expect(ok(run(D, 'actual'))).toBe('actual');
  });

  it('validates non-undefined inputs through inner schema', () => {
    const D = default_(integer({ minimum: 0 }), 0);
    expect(ok(run(D, 5))).toBe(5);
    expect(issues(run(D, 'nope'))[0]!.code).toBe('expected_integer');
    expect(issues(run(D, -1))[0]!.code).toBe('too_small');
  });

  it('inside object, missing key fills fallback and key becomes required-typed', () => {
    const User = object({
      name: string(),
      theme: default_(enum_(['light', 'dark'] as const), 'light'),
    });
    expect(User.required.slice().sort()).toEqual(['name']);
    expect(ok(run(User, { name: 'x' }))).toEqual({ name: 'x', theme: 'light' });
    expect(ok(run(User, { name: 'x', theme: 'dark' }))).toEqual({ name: 'x', theme: 'dark' });
    expect(issues(run(User, { name: 'x', theme: 'neon' }))[0]!.code).toBe('not_in_enum');
  });

  it('does not clone the input when no default fires', () => {
    const User = object({ name: string() });
    const input = { name: 'x' };
    const r = run(User, input);
    expect((r as { value: unknown }).value).toBe(input);
  });

  it('exposes default in JSON Schema output', () => {
    const D = default_(string(), 'x');
    expect((D as unknown as { default: string }).default).toBe('x');
  });
});

describe('transform', () => {
  it('runs a single transform after successful validation', () => {
    const Length = transform(string(), s => s.length);
    expect(ok(run(Length, 'hello'))).toBe(5);
  });

  it('chains multiple transforms left-to-right', () => {
    const YearFromISO = transform(
      string({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
      s => new Date(s),
      d => d.getFullYear(),
    );
    expect(ok(run(YearFromISO, '2026-04-18'))).toBe(2026);
  });

  it('short-circuits on base schema failure — transforms do not run', () => {
    let called = 0;
    const S = transform(integer(), (n) => {
      called++;
      return n * 2;
    });
    expect(issues(run(S, 'nope'))[0]!.code).toBe('expected_integer');
    expect(called).toBe(0);
  });

  it('composes with refined (validate → transform → refine)', () => {
    const Slug = refined(
      transform(string(), s => s.toLowerCase()),
      s => /^[a-z0-9-]+$/.test(s),
      'must be kebab-case',
    );
    expect(ok(run(Slug, 'Hello-World'))).toBe('hello-world');
    expect(issues(run(Slug, 'Hello World'))[0]!.code).toBe('refine_failed');
  });

  it('composes with default_ (fallback → transform)', () => {
    const Upper = transform(default_(string(), 'fallback'), s => s.toUpperCase());
    expect(ok(run(Upper, undefined))).toBe('FALLBACK');
    expect(ok(run(Upper, 'lower'))).toBe('LOWER');
  });

  it('reshapes objects (rename + derive fields)', () => {
    const User = transform(
      object({ user_id: integer(), display_name: string() }),
      o => ({ id: o.user_id, name: o.display_name }),
    );
    expect(ok(run(User, { user_id: 1, display_name: 'Alice' }))).toEqual({ id: 1, name: 'Alice' });
    expect(issues(run(User, { user_id: 1 }))[0]!.code).toBe('missing');
  });

  it('preserves JSON Schema shape of the base schema', () => {
    const S = transform(string(), s => s.length);
    expect((S as unknown as { type: string }).type).toBe('string');
  });
});

describe('parse', () => {
  it('returns { value } on success', () => {
    const r = parse(string(), 'hello');
    expect((r as { value: string }).value).toBe('hello');
  });

  it('returns { issues } on failure', () => {
    const r = parse(string(), 42);
    expect((r as { issues: unknown[] }).issues).toBeDefined();
  });

  it('is a thin wrapper — same result shape as ~standard.validate', () => {
    const s = object({ id: integer() });
    const viaParse = parse(s, { id: 1 });
    const viaDirect = s['~standard'].validate({ id: 1 });
    expect(viaParse).toEqual(viaDirect);
  });
});

describe('parseOrThrow', () => {
  it('returns the value on success', () => {
    const v = parseOrThrow(string(), 'hello');
    expect(v).toBe('hello');
  });

  it('throws SchemaValidationError on failure', () => {
    expect(() => parseOrThrow(string(), 42)).toThrow(SchemaValidationError);
  });

  it('SchemaValidationError carries the raw issues array', () => {
    try {
      parseOrThrow(object({ name: string() }), {});
      throw new Error('should have thrown');
    }
    catch (err) {
      expect(err).toBeInstanceOf(SchemaValidationError);
      const e = err as SchemaValidationError;
      expect(e.issues.length).toBeGreaterThan(0);
      expect(e.issues[0]!.code).toBe('missing');
    }
  });

  it('SchemaValidationError.message is the formatted issue string', () => {
    try {
      parseOrThrow(object({ email: string({ pattern: '^.+@.+$' }) }), { email: 'bad' });
      throw new Error('should have thrown');
    }
    catch (err) {
      expect(err).toBeInstanceOf(SchemaValidationError);
      expect((err as SchemaValidationError).message).toBe('email: Pattern mismatch');
    }
  });

  it('throws TypeError if schema returns a Promise', () => {
    const asyncSchema = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: () => Promise.resolve({ value: 'x' }),
      },
    };
    expect(() => parseOrThrow(asyncSchema, 'x')).toThrow(TypeError);
  });
});

describe('formatIssues', () => {
  it('joins path and message per line', () => {
    const User = object({ name: string(), email: string({ pattern: '^.+@.+$' }) });
    const r = run(User, { name: 'x', email: 'bad' });
    const text = formatIssues(r.issues ?? []);
    expect(text).toBe('email: Pattern mismatch');
  });

  it('handles nested paths', () => {
    const S = object({ user: object({ email: string({ pattern: '^.+@.+$' }) }) });
    const r = run(S, { user: { email: 'bad' } });
    expect(formatIssues(r.issues ?? [])).toBe('user.email: Pattern mismatch');
  });

  it('uses custom separator and joiner', () => {
    const Form = object({
      a: integer(),
      b: integer(),
    });
    const r = run(Form, { a: 'x', b: 'y' });
    const text = formatIssues(r.issues ?? [], { separator: '; ', pathJoiner: '/' });
    expect(text).toBe('a: Expected integer; b: Expected integer');
  });

  it('root-level issue has no path prefix', () => {
    const r = run(string(), 42);
    expect(formatIssues(r.issues ?? [])).toBe('Expected string');
  });
});
