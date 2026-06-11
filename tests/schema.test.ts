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
  extendSchema,
  finite,
  formatIssues,
  groupIssuesByField,
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
  parseForm,
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
    expect(issues(run(S, true))[0]!.message).toBe('No variant matched (2 variants tried)');
  });

  it('union failure carries the best-matching variant\'s issues with paths', () => {
    const S = union([object({ a: string() }), object({ b: number() })]);
    const r = run(S, { a: 42 });
    const list = issues(r);
    expect(list[0]!.code).toBe('no_variant_matched');
    expect(list.length).toBeGreaterThan(1);
    // The best-matching variant is the first (one issue: a is not a string).
    expect(list[1]!.code).toBe('expected_string');
    expect(list[1]!.path).toEqual(['a']);
  });

  it('union member issue paths are prefixed when nested in an object', () => {
    const S = object({ field: union([object({ a: string() }), object({ b: number() })]) });
    const r = run(S, { field: { a: 42 } });
    const list = issues(r);
    expect(list[0]!.path).toEqual(['field']);
    expect(list[1]!.path).toEqual(['field', 'a']);
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
    // UUIDv7 (time-ordered) and the nil UUID must be accepted (issue #9).
    expect(ok(run(uuid(), '0190d3e2-7b7e-7cab-83e5-9c8b0f6a1d2e'))).toBeTruthy();
    expect(ok(run(uuid(), '00000000-0000-0000-0000-000000000000'))).toBeTruthy();
    // Version 0 is still invalid.
    expect(issues(run(uuid(), '123e4567-e89b-02d3-a456-426614174000'))[0]!.message).toBe('Pattern mismatch');

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
    // Decimal multiples must not trip on IEEE-754 remainder error (issue #9).
    expect(ok(run(number({ multipleOf: 0.1 }), 0.3))).toBe(0.3);
    expect(ok(run(number({ multipleOf: 0.01 }), 1.21))).toBe(1.21);
    expect(issues(run(number({ multipleOf: 0.1 }), 0.35))[0]!.code).toBe('not_a_multiple');
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

  it('preserves default_ wrappers through pick/omit/merge (issue #10)', () => {
    const User = object({
      id: integer(),
      theme: default_(enum_(['light', 'dark'] as const), 'light'),
    });
    // pick keeps the default applied when the field is missing.
    const Picked = pick(User, ['theme'] as const);
    expect(ok(run(Picked, {}))).toEqual({ theme: 'light' });
    // omit of an unrelated key likewise retains the default.
    const Omitted = omit(User, ['id'] as const);
    expect(ok(run(Omitted, {}))).toEqual({ theme: 'light' });
    // merge carries the default through.
    const Merged = merge(object({ id: integer() }), pick(User, ['theme'] as const));
    expect(ok(run(Merged, { id: 1 }))).toEqual({ id: 1, theme: 'light' });
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

describe('nested transform/default propagation (issue #8)', () => {
  const upper = transform(string(), s => s.toUpperCase());

  it('array threads transformed member values', () => {
    expect(ok(run(array(upper), ['x', 'y']))).toEqual(['X', 'Y']);
  });

  it('array threads defaulted member values', () => {
    expect(ok(run(array(default_(string(), 'D')), [undefined]))).toEqual(['D']);
  });

  it('record threads transformed member values', () => {
    expect(ok(run(record(upper), { k: 'x' }))).toEqual({ k: 'X' });
  });

  it('tuple threads transformed member values', () => {
    expect(ok(run(tuple([upper]), ['x']))).toEqual(['X']);
  });

  it('intersect threads transformed output of earlier members', () => {
    const I = intersect([
      object({ a: upper }),
      object({ a: string() }),
    ]);
    expect(ok(run(I, { a: 'x' }))).toEqual({ a: 'X' });
  });

  it('returns the original reference when nothing changed (no needless clone)', () => {
    const input = ['x', 'y'];
    const r = run(array(string()), input);
    expect(ok(r)).toBe(input);
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

describe('extendSchema', () => {
  it('extends a compiled FSchema base with new properties', () => {
    const base = object({ email: string(), password: string() });
    // Erase the base's FObject<Props> typing to simulate a fromJSONSchema
    // validator or a validators.* entry from virtual:fetcher.
    const opaque = base as unknown as FSchema<{ email: string; password: string }>;

    const extended = extendSchema(opaque, {
      id: number(),
      role: optional(string()),
    });

    const r = run(extended, { email: 'a@b.com', password: 'x', id: 1, role: 'admin' });
    const value = ok(r);
    expect(value).toEqual({ email: 'a@b.com', password: 'x', id: 1, role: 'admin' });

    // Compile-time check that the extended type intersects base & extras
    type Out = Infer<typeof extended>;
    const _check: Out = value as Out;
    void _check;
  });

  it('missing required extension field produces an issue', () => {
    const base = object({ email: string() }) as unknown as FSchema<{ email: string }>;
    const extended = extendSchema(base, { id: number() });
    const r = run(extended, { email: 'a@b.com' });
    expect(issues(r).length).toBeGreaterThan(0);
  });
});

describe('groupIssuesByField', () => {
  it('keys on the first path segment and keeps the first issue per field', () => {
    const s = object({
      email: string({ pattern: '^.+@.+$' }),
      password: string({ minLength: 8 }),
    });
    const r = run(s, { email: 'bad', password: 'x' });
    const grouped = groupIssuesByField(r.issues ?? []);
    expect(Object.keys(grouped).sort()).toEqual(['email', 'password']);
    expect(typeof grouped.email).toBe('string');
    expect(typeof grouped.password).toBe('string');
  });

  it('uses _form for path-less issues', () => {
    const grouped = groupIssuesByField([{ message: 'root failure' }]);
    expect(grouped).toEqual({ _form: 'root failure' });
  });

  it('unwraps { key } path segments', () => {
    const grouped = groupIssuesByField([
      { message: 'x', path: [{ key: 'field' }] },
    ]);
    expect(grouped).toEqual({ field: 'x' });
  });

  it('keeps only the first issue per field', () => {
    const grouped = groupIssuesByField([
      { message: 'first', path: ['a'] },
      { message: 'second', path: ['a'] },
    ]);
    expect(grouped).toEqual({ a: 'first' });
  });
});

describe('parseForm', () => {
  it('returns { ok: true, value } on success', () => {
    const s = object({ email: string(), password: string() });
    const r = parseForm(s, { email: 'a@b.com', password: 'secret' });
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.value).toEqual({ email: 'a@b.com', password: 'secret' });
  });

  it('returns { ok: false, errors, issues } on failure', () => {
    const s = object({ email: string(), password: string({ minLength: 8 }) });
    const r = parseForm(s, { email: 'a@b.com', password: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toHaveProperty('password');
      expect(typeof r.errors.password).toBe('string');
      expect(r.issues.length).toBeGreaterThan(0);
    }
  });

  it('throws TypeError on async schemas', () => {
    const asyncSchema: FSchema<string> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: async v => ({ value: v as string }),
      },
    };
    expect(() => parseForm(asyncSchema, 'x')).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// v1.0 hardening regressions
// ---------------------------------------------------------------------------

describe('number/integer reject non-finite values', () => {
  it('number() rejects Infinity, -Infinity, 1e999 and NaN', () => {
    expect(issues(run(number(), Infinity))[0]!.code).toBe('expected_number');
    expect(issues(run(number(), -Infinity))[0]!.code).toBe('expected_number');
    expect(issues(run(number(), Number('1e999')))[0]!.code).toBe('expected_number');
    expect(issues(run(number(), Number.NaN))[0]!.code).toBe('expected_number');
  });

  it('number() with bounds still rejects Infinity (no bound bypass)', () => {
    expect(issues(run(number({ minimum: 0 }), Infinity))[0]!.code).toBe('expected_number');
  });

  it('integer() rejects Infinity and NaN', () => {
    expect(issues(run(integer(), Infinity))[0]!.code).toBe('expected_integer');
    expect(issues(run(integer(), Number.NaN))[0]!.code).toBe('expected_integer');
  });

  it('finite() stays equivalent to number()', () => {
    expect(ok(run(finite(), 1.5))).toBe(1.5);
    expect(issues(run(finite(), Infinity))[0]!.code).toBe('expected_number');
  });
});

describe('multipleOf at large magnitudes', () => {
  it('rejects non-multiples beyond the old relative-tolerance horizon', () => {
    expect(issues(run(number({ multipleOf: 1 }), 600000000.5))[0]!.code).toBe('not_a_multiple');
    expect(issues(run(number({ multipleOf: 1 }), 10000000000.001))[0]!.code).toBe('not_a_multiple');
    expect(issues(run(number({ multipleOf: 0.01 }), 10000000.005))[0]!.code).toBe('not_a_multiple');
  });

  it('still accepts true large multiples and the official float traps', () => {
    expect(ok(run(number({ multipleOf: 1 }), 600000001))).toBe(600000001);
    expect(ok(run(number({ multipleOf: 0.0001 }), 0.0075))).toBe(0.0075);
    // 1e308 / 0.123456789 overflows to Infinity — must be invalid, not thrown.
    expect(issues(run(number({ multipleOf: 0.123456789 }), 1e308))[0]!.code).toBe('not_a_multiple');
  });
});

describe('string length counts Unicode code points', () => {
  it('astral characters count once (JSON Schema 2020-12 semantics)', () => {
    expect(ok(run(string({ maxLength: 1 }), '😀'))).toBe('😀');
    expect(ok(run(string({ maxLength: 2 }), '💩💩'))).toBe('💩💩');
    expect(issues(run(string({ minLength: 2 }), '😀'))[0]!.code).toBe('too_short');
    expect(ok(run(string({ length: 1 }), '😀'))).toBe('😀');
    expect(issues(run(string({ maxLength: 2 }), '💩💩💩'))[0]!.code).toBe('too_long');
  });

  it('BMP strings behave exactly as before', () => {
    expect(ok(run(string({ minLength: 2, maxLength: 3 }), 'abc'))).toBe('abc');
    expect(issues(run(string({ maxLength: 3 }), 'abcd'))[0]!.code).toBe('too_long');
  });
});

describe('string emission of runtime-only options', () => {
  it('length emits minLength + maxLength', () => {
    const s = string({ length: 3 });
    expect(s.minLength).toBe(3);
    expect(s.maxLength).toBe(3);
  });

  it('a single startsWith/endsWith/includes emits an equivalent pattern', () => {
    expect(string({ startsWith: 'a.b' }).pattern).toBe('^a\\.b');
    expect(string({ endsWith: '!' }).pattern).toBe('!$');
    expect(string({ includes: 'x*y' }).pattern).toBe('x\\*y');
  });

  it('explicit pattern wins and combinations stay runtime-only', () => {
    expect(string({ pattern: '^a$', startsWith: 'a' }).pattern).toBe('^a$');
    expect(string({ startsWith: 'a', endsWith: 'b' }).pattern).toBeUndefined();
  });
});

describe('literal/enum_ SameValueZero equality', () => {
  it('literal(NaN) matches NaN; enum_ agrees', () => {
    expect(run(literal(Number.NaN), Number.NaN).issues).toBeUndefined();
    expect(run(enum_([Number.NaN]), Number.NaN).issues).toBeUndefined();
  });

  it('literal(0) matches -0 on both', () => {
    expect(run(literal(0), -0).issues).toBeUndefined();
    expect(run(enum_([0]), -0).issues).toBeUndefined();
  });
});

describe('object() unknown-key policy', () => {
  const shape = { a: string(), d: default_(string(), 'D'), o: optional(string()) };

  it('passthrough (default) keeps unknown keys and aliases the input', () => {
    const S = object({ a: string() });
    const input = { a: 'x', extra: 1 };
    const r = run(S, input);
    expect(ok(r)).toBe(input as never);
    expect((ok(r) as Record<string, unknown>).extra).toBe(1);
  });

  it('strip returns a new object with only declared keys (defaults materialized)', () => {
    const S = object(shape, { unknownKeys: 'strip' });
    const input = { a: 'x', extra: 1, more: true };
    const r = run(S, input);
    const v = ok(r) as Record<string, unknown>;
    expect(v).not.toBe(input);
    expect(v).toEqual({ a: 'x', d: 'D' });
    // missing optional key is not materialized; present one is kept.
    const v2 = ok(run(S, { a: 'x', o: 'here', junk: 0 })) as Record<string, unknown>;
    expect(v2).toEqual({ a: 'x', d: 'D', o: 'here' });
  });

  it('strict reports one unknown_key issue per extra key, with path', () => {
    const S = object({ a: string() }, { unknownKeys: 'strict' });
    const r = run(S, { a: 'x', extra: 1, more: true });
    const list = issues(r);
    expect(list.map(i => i.code)).toEqual(['unknown_key', 'unknown_key']);
    expect(list.map(i => i.path?.[0]).sort()).toEqual(['extra', 'more']);
    expect(ok(run(S, { a: 'x' }))).toEqual({ a: 'x' });
  });

  it('strict emits additionalProperties: false; others do not', () => {
    expect(object({ a: string() }, { unknownKeys: 'strict' }).additionalProperties).toBe(false);
    expect(object({ a: string() }).additionalProperties).toBeUndefined();
    expect(object({ a: string() }, { unknownKeys: 'strip' }).additionalProperties).toBeUndefined();
  });
});

describe('optional keys present with undefined', () => {
  it('object() accepts { a: undefined } for an optional key', () => {
    const S = object({ a: optional(string()) });
    expect(run(S, { a: undefined }).issues).toBeUndefined();
    expect(run(S, {}).issues).toBeUndefined();
    expect(issues(run(S, { a: 1 }))[0]!.code).toBe('expected_string');
  });

  it('partial()-derived objects accept explicit undefined', () => {
    const P = partial(object({ a: string() }));
    expect(run(P, { a: undefined }).issues).toBeUndefined();
  });

  it('required keys with explicit undefined still fail', () => {
    const S = object({ a: string() });
    expect(issues(run(S, { a: undefined }))[0]!.code).toBe('expected_string');
  });
});

describe('async members are rejected loudly in sync combinators', () => {
  const asyncSchema: FSchema<string> = {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: async v => ({ value: v as string }),
    },
  };

  it('object/array/record/tuple throw TypeError instead of corrupting output', () => {
    expect(() => run(object({ name: asyncSchema }), { name: 'alice' })).toThrow('Schema validation must be synchronous');
    expect(() => run(array(asyncSchema), ['x'])).toThrow(TypeError);
    expect(() => run(record(asyncSchema), { k: 'x' })).toThrow(TypeError);
    expect(() => run(tuple([asyncSchema]), ['x'])).toThrow(TypeError);
  });

  it('union/intersect/discriminatedUnion throw TypeError', () => {
    expect(() => run(union([asyncSchema, string()]), 42)).toThrow(TypeError);
    expect(() => run(intersect([asyncSchema]), 'x')).toThrow(TypeError);
    const DU = discriminatedUnion('t', { a: asyncSchema as never });
    expect(() => run(DU, { t: 'a' })).toThrow(TypeError);
  });

  it('optional/nullable/refined/default_/transform throw TypeError', () => {
    expect(() => run(optional(asyncSchema), 'x')).toThrow(TypeError);
    expect(() => run(nullable(asyncSchema), 'x')).toThrow(TypeError);
    expect(() => run(refined(asyncSchema, () => true), 'x')).toThrow(TypeError);
    expect(() => run(default_(asyncSchema, 'd'), 'x')).toThrow(TypeError);
    expect(() => run(transform(asyncSchema, s => s), 'x')).toThrow(TypeError);
  });

  it('optional() still short-circuits undefined without calling the inner validator', () => {
    expect(run(optional(asyncSchema), undefined).issues).toBeUndefined();
  });
});

describe('discriminatedUnion hardening', () => {
  it('distinguishes missing_discriminator from unknown_discriminator', () => {
    const S = discriminatedUnion('kind', { a: object({ x: boolean() }) });
    const missing = run(S, { x: true });
    expect(missing.issues?.[0]!.code).toBe('missing_discriminator');
    expect(missing.issues?.[0]!.path).toEqual(['kind']);
    const unknownTag = run(S, { kind: 'b', x: true });
    expect(unknownTag.issues?.[0]!.code).toBe('unknown_discriminator');
  });

  it('dispatches number and boolean tags via their string form', () => {
    const S = discriminatedUnion('version', {
      1: object({ version: literal(1), legacy: boolean() }),
      2: object({ version: literal(2), modern: boolean() }),
    });
    expect(ok(run(S, { version: 2, modern: true }))).toEqual({ version: 2, modern: true });
    expect(ok(run(S, { version: 1, legacy: false }))).toEqual({ version: 1, legacy: false });
    const B = discriminatedUnion('flag', { true: object({ flag: literal(true) }) });
    expect(run(B, { flag: true }).issues).toBeUndefined();
  });

  it('injects the tag const into emitted variants that omit it', () => {
    const S = discriminatedUnion('kind', {
      cat: object({ meows: boolean() }),
      dog: object({ kind: literal('dog'), barks: boolean() }),
    });
    const cat = S.oneOf[0] as unknown as { properties: Record<string, { const?: string }>; required: string[] };
    expect(cat.properties.kind).toEqual({ const: 'cat' });
    expect(cat.required).toContain('kind');
    // Variants that already constrain the tag are emitted by identity.
    const dogVariant = object({ kind: literal('dog'), barks: boolean() });
    const S2 = discriminatedUnion('kind', { dog: dogVariant });
    expect(S2.oneOf[0]).toBe(dogVariant as never);
  });

  it('serialized oneOf reproduces the dispatch (tag is constrained)', () => {
    const S = discriminatedUnion('kind', {
      cat: object({ meows: boolean() }),
      dog: object({ barks: boolean() }),
    });
    const dog = S.oneOf[1] as unknown as { properties: Record<string, { const?: string }> };
    // {kind:'dog', meows:true} must NOT satisfy the emitted cat variant.
    const cat = S.oneOf[0] as unknown as { properties: Record<string, { const?: string }> };
    expect(cat.properties.kind!.const).toBe('cat');
    expect(dog.properties.kind!.const).toBe('dog');
  });
});

describe('default_ fallback instances are not shared', () => {
  it('object/array fallbacks are cloned per use', () => {
    const S = object({ tags: default_(array(string()), []) });
    const r1 = ok(run(S, {})) as { tags: string[] };
    r1.tags.push('polluted');
    const r2 = ok(run(S, {})) as { tags: string[] };
    expect(r2.tags).toEqual([]);
  });

  it('function fallbacks are invoked per use', () => {
    let calls = 0;
    const S = default_(string(), () => {
      calls++;
      return `v${calls}`;
    });
    expect(ok(run(S, undefined))).toBe('v1');
    expect(ok(run(S, undefined))).toBe('v2');
    expect(ok(run(S, 'real'))).toBe('real');
    expect(calls).toBe(2);
  });

  it('factory fallbacks emit no default annotation; value fallbacks still do', () => {
    expect((default_(string(), () => 'x') as unknown as { default?: string }).default).toBeUndefined();
    expect((default_(string(), 'x') as unknown as { default?: string }).default).toBe('x');
  });
});

describe('composition guards against non-object bases', () => {
  it('extendSchema throws TypeError for a union base', () => {
    const u = union([object({ a: string() }), object({ b: number() })]);
    expect(() => extendSchema(u as unknown as FSchema<unknown>, { id: number() })).toThrow(TypeError);
  });

  it('merge throws TypeError when either side is not an object schema', () => {
    expect(() => merge(string() as never, object({ a: string() }))).toThrow(TypeError);
    expect(() => merge(object({ a: string() }), record(string()) as never)).toThrow(TypeError);
  });

  it('partial/pick/omit/required throw TypeError for non-object bases', () => {
    expect(() => partial(string() as never)).toThrow(TypeError);
    expect(() => pick(string() as never, [] as never)).toThrow(TypeError);
    expect(() => omit(string() as never, [] as never)).toThrow(TypeError);
    expect(() => required(string() as never)).toThrow(TypeError);
  });
});

describe('record() accepts plain objects only', () => {
  it('rejects Map/Set/Date/class instances', () => {
    const S = record(string());
    expect(issues(run(S, new Map([['a', 'b']])))[0]!.code).toBe('expected_object');
    expect(issues(run(S, new Set(['a'])))[0]!.code).toBe('expected_object');
    expect(issues(run(S, new Date()))[0]!.code).toBe('expected_object');
    class Box { a = 'x'; }
    expect(issues(run(S, new Box()))[0]!.code).toBe('expected_object');
  });

  it('accepts null-prototype objects and ignores inherited properties', () => {
    const S = record(boolean());
    const nullProto = Object.create(null) as Record<string, boolean>;
    nullProto.a = true;
    expect(ok(run(S, nullProto))).toEqual({ a: true } as never);
    // An object inheriting enumerable props has a non-plain prototype → rejected.
    expect(issues(run(S, Object.create({ inheritedAdmin: true })))[0]!.code).toBe('expected_object');
  });
});

describe('prototype-named keys are safe end to end', () => {
  it('object() with a literal __proto__ property key keeps a consistent shape', () => {
    const S = object({ ['__proto__']: string() });
    expect(Object.keys(S.properties)).toEqual(['__proto__']);
    expect(S.required).toEqual(['__proto__']);
    const good = JSON.parse('{"__proto__": "x"}') as Record<string, unknown>;
    expect(run(S, good).issues).toBeUndefined();
    expect(issues(run(S, {}))[0]!.code).toBe('missing');
  });

  it('required keys named like Object.prototype members are reported missing', () => {
    const S = object({ constructor: unknown(), toString: string() });
    const r = run(S, {});
    const codes = issues(r).map(i => `${String(i.path?.[0])}:${i.code}`).sort();
    expect(codes).toEqual(['constructor:missing', 'toString:missing']);
  });

  it('default_ fills fallbacks for prototype-named keys', () => {
    const S = object({ toString: default_(string(), 'fallback') });
    expect(ok(run(S, {})) as never).toEqual({ toString: 'fallback' } as never);
  });

  it('transform output for a __proto__ key never pollutes the prototype', () => {
    const S = object({ ['__proto__']: transform(string(), s => s.toUpperCase()) });
    const input = JSON.parse('{"__proto__": "x"}') as Record<string, unknown>;
    const v = ok(run(S, input)) as Record<string, unknown>;
    expect(Object.getPrototypeOf(v)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(v, '__proto__')!.value).toBe('X');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('groupIssuesByField keeps prototype-named fields', () => {
    const grouped = groupIssuesByField([
      { message: 'bad-proto', path: ['__proto__'] },
      { message: 'bad-toString', path: ['toString'] },
      { message: 'bad-ctor', path: ['constructor'] },
      { message: 'bad-real', path: ['real'] },
    ]);
    expect(Object.getOwnPropertyDescriptor(grouped, '__proto__')!.value).toBe('bad-proto');
    expect(grouped['toString' as string]).toBe('bad-toString');
    expect(grouped['constructor' as string]).toBe('bad-ctor');
    expect(grouped.real).toBe('bad-real');
  });
});

describe('compile() reaches nested and wrapped refs', () => {
  it('binds refs inside defs targets (multi-level graphs)', () => {
    const User = object({ name: string() });
    const Post = object({ author: ref('User') });
    const Blog = object({ posts: array(ref('Post')) });
    compile(Blog, { User, Post });
    expect(run(Blog, { posts: [{ author: { name: 'a' } }] }).issues).toBeUndefined();
    expect(issues(run(Blog, { posts: [{ author: { name: 1 } }] }))[0]!.path).toEqual(['posts', 0, 'author', 'name']);
  });

  it('binds refs inside record() values and tuple() members', () => {
    const Item = object({ id: integer() });
    const R = object({ things: record(ref('Item')) });
    compile(R, { Item });
    expect(run(R, { things: { a: { id: 1 } } }).issues).toBeUndefined();

    const T = object({ pair: tuple([ref('Item'), string()]) });
    compile(T, { Item });
    expect(run(T, { pair: [{ id: 1 }, 'x'] }).issues).toBeUndefined();
  });

  it('binds refs wrapped by refined/transform/default_/optional', () => {
    const Name = string({ minLength: 2 });

    const Refined = object({ name: refined(ref<string>('Name'), s => s.length > 1) });
    compile(Refined, { Name });
    expect(run(Refined, { name: 'ab' }).issues).toBeUndefined();
    expect(issues(run(Refined, { name: 'a' }))[0]!.code).toBe('too_short');

    const Transformed = object({ name: transform(ref<string>('Name'), s => s.toUpperCase()) });
    compile(Transformed, { Name });
    expect(ok(run(Transformed, { name: 'ab' }))).toEqual({ name: 'AB' } as never);

    const Defaulted = object({ name: default_(ref<string>('Name'), 'zz') });
    compile(Defaulted, { Name });
    expect(ok(run(Defaulted, {}))).toEqual({ name: 'zz' } as never);
    expect(run(Defaulted, { name: 'ab' }).issues).toBeUndefined();

    const Optional = object({ name: optional(ref<string>('Name')) });
    compile(Optional, { Name });
    expect(run(Optional, { name: 'ab' }).issues).toBeUndefined();
    expect(issues(run(Optional, { name: 'a' }))[0]!.code).toBe('too_short');
  });
});

describe('wrapper over optional keeps both behaviors inside object()', () => {
  it('transform(optional(...)) stays optional AND transforms (including missing keys)', () => {
    const S = object({ name: transform(optional(string()), v => (v ?? 'DEFAULT').toUpperCase()) });
    expect(S.required).toEqual([]);
    expect(ok(run(S, { name: 'bob' }))).toEqual({ name: 'BOB' } as never);
    expect(ok(run(S, {}))).toEqual({ name: 'DEFAULT' } as never);
    expect(ok(run(S, { name: undefined }))).toEqual({ name: 'DEFAULT' } as never);
  });

  it('refined(optional(...)) stays optional AND runs the predicate', () => {
    const S = object({
      nick: refined(optional(string()), v => v === undefined || v.length > 3, 'too short'),
    });
    expect(S.required).toEqual([]);
    expect(run(S, {}).issues).toBeUndefined();
    expect(run(S, { nick: 'long-enough' }).issues).toBeUndefined();
    const r = run(S, { nick: 'ab' });
    expect(issues(r)[0]!.code).toBe('refine_failed');
    expect(issues(r)[0]!.path).toEqual(['nick']);
  });

  it('transform(default_(...)) keeps the default treatment', () => {
    const S = object({ theme: transform(default_(string(), 'light'), s => s.toUpperCase()) });
    expect(S.required).toEqual([]);
    expect(ok(run(S, {}))).toEqual({ theme: 'LIGHT' } as never);
    expect(ok(run(S, { theme: 'dark' }))).toEqual({ theme: 'DARK' } as never);
  });

  it('wrappers no longer leak the optional markers via spread', () => {
    const w = transform(optional(string()), v => v) as unknown as Record<string, unknown>;
    expect(w['~optional']).toBe(true); // deliberate propagation…
    expect(w['~inner']).toBeDefined(); // …via the explicit protocol,
    expect(w.type).toBe('string'); // with the inner JSON meta carried over.
  });
});

describe('transform errors become issues', () => {
  it('a throwing transform yields transform_error instead of throwing', () => {
    const S = transform(string(), () => {
      throw new Error('boom');
    });
    const r = run(S, 'x');
    expect(issues(r)[0]!.code).toBe('transform_error');
    expect(issues(r)[0]!.message).toBe('boom');
  });

  it('non-Error throws are stringified', () => {
    const S = transform(string(), () => {
      throw 'plain'; // eslint-disable-line no-throw-literal
    });
    expect(issues(run(S, 'x'))[0]!.message).toBe('plain');
  });

  it('nested in an object, the issue carries the member path', () => {
    const S = object({ a: transform(string(), () => {
      throw new Error('nested boom');
    }) });
    expect(issues(run(S, { a: 'x' }))[0]!.path).toEqual(['a']);
  });
});

describe('refined() options object', () => {
  it('accepts { message, code, path }', () => {
    const S = refined(
      object({ password: string(), confirm: string() }),
      o => o.password === o.confirm,
      { message: 'Passwords must match', code: 'password_mismatch', path: ['confirm'] },
    );
    const r = run(S, { password: 'a', confirm: 'b' });
    expect(issues(r)[0]).toEqual({
      code: 'password_mismatch',
      message: 'Passwords must match',
      path: ['confirm'],
    });
  });

  it('path routes through groupIssuesByField', () => {
    const S = refined(
      object({ password: string(), confirm: string() }),
      o => o.password === o.confirm,
      { message: 'Passwords must match', path: ['confirm'] },
    );
    const r = run(S, { password: 'a', confirm: 'b' });
    expect(groupIssuesByField(r.issues ?? [])).toEqual({ confirm: 'Passwords must match' });
  });

  it('defaults stay intact when options omit fields', () => {
    const S = refined(string(), () => false, {});
    const r = run(S, 'x');
    expect(issues(r)[0]!.code).toBe('refine_failed');
    expect(issues(r)[0]!.message).toBe('Refinement failed');
  });
});

describe('deep recursion returns an issue instead of throwing', () => {
  it('self-referential schema on hostile deep input yields max_depth_exceeded', () => {
    interface TreeNode { children?: TreeNode[] }
    const Tree = object({ children: optional(array(ref<TreeNode>('Tree'))) });
    compile(Tree, { Tree });
    let node: TreeNode = {};
    for (let i = 0; i < 100000; i++)
      node = { children: [node] };
    const r = run(Tree, node);
    expect(r.issues).toBeDefined();
    expect(r.issues!.some(i => i.code === 'max_depth_exceeded')).toBe(true);
  });
});

describe('tightened format semantics', () => {
  it('datetime/date/time reject out-of-range fields', () => {
    expect(issues(run(datetime(), '9999-99-99T99:99:99Z'))[0]!.code).toBe('pattern_mismatch');
    expect(issues(run(datetime(), '2026-13-01T00:00:00Z'))[0]!.code).toBe('pattern_mismatch');
    expect(issues(run(datetime(), '2026-01-01T24:00:00Z'))[0]!.code).toBe('pattern_mismatch');
    expect(issues(run(datetime(), '2026-01-01T00:00:00+24:00'))[0]!.code).toBe('pattern_mismatch');
    expect(issues(run(date(), '2026-00-10'))[0]!.code).toBe('pattern_mismatch');
    expect(issues(run(date(), '2026-13-01'))[0]!.code).toBe('pattern_mismatch');
    expect(issues(run(time(), '24:00:00'))[0]!.code).toBe('pattern_mismatch');
    expect(issues(run(time(), '12:60:00'))[0]!.code).toBe('pattern_mismatch');
    // Still-valid values keep passing.
    expect(run(datetime(), '2026-12-31T23:59:59.999+05:30').issues).toBeUndefined();
    expect(run(time(), '23:59:59Z').issues).toBeUndefined();
  });

  it('email follows the WHATWG HTML5 grammar', () => {
    expect(run(email(), 'simple@example.com').issues).toBeUndefined();
    expect(run(email(), 'o\'brien+tag@sub.example.co').issues).toBeUndefined();
    // HTML5's local part is a plain character class — dots are unrestricted
    // there (a documented willful violation of RFC 5322; Zod's default email
    // is stricter on the local part).
    expect(run(email(), 'a..b@c.com').issues).toBeUndefined();
    expect(run(email(), '.a@b.com').issues).toBeUndefined();
    // Domain labels ARE constrained: no leading/trailing hyphens, no empty
    // labels, ASCII only, max 63 chars.
    expect(issues(run(email(), 'a@-b.com')).length).toBe(1);
    expect(issues(run(email(), 'a@b-.com')).length).toBe(1);
    expect(issues(run(email(), 'a@b..com')).length).toBe(1);
    expect(issues(run(email(), 'a@b.com.')).length).toBe(1);
    expect(issues(run(email(), 'a@日本.com')).length).toBe(1);
    expect(issues(run(email(), `a@${'b'.repeat(64)}.com`)).length).toBe(1);
    expect(issues(run(email(), 'no-at-sign')).length).toBe(1);
    expect(issues(run(email(), 'two@@signs.com')).length).toBe(1);
  });

  it('uuid/url runtime and emitted pattern agree without flags', () => {
    for (const f of [uuid(), url(), email()]) {
      const re = new RegExp(f.pattern!);
      const samples = f.format === 'uuid'
        ? ['123E4567-E89B-12D3-A456-426614174000', 'not-a-uuid']
        : f.format === 'uri'
          ? ['HTTPS://EXAMPLE.COM/X', 'mailto:a@b.com']
          : ['a@b.com', 'a..b@c.com'];
      for (const s of samples) {
        const runtimeOk = !run(f, s).issues;
        expect(re.test(s)).toBe(runtimeOk);
      }
    }
  });

  it('uppercase and max UUIDs still accepted', () => {
    expect(run(uuid(), '123E4567-E89B-12D3-A456-426614174000').issues).toBeUndefined();
    expect(run(uuid(), 'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF').issues).toBeUndefined();
    expect(run(uuid(), 'ffffffff-ffff-ffff-ffff-ffffffffffff').issues).toBeUndefined();
  });
});

describe('composition preserves the unknownKeys policy', () => {
  const Strict = object({ a: string(), tag: optional(string()) }, { unknownKeys: 'strict' });
  const Strip = object({ a: string() }, { unknownKeys: 'strip' });

  it('partial keeps strict rejection and the emitted marker', () => {
    const P = partial(Strict);
    expect(P.additionalProperties).toBe(false);
    expect(issues(run(P, { a: 'x', zz: 1 }))[0]!.code).toBe('unknown_key');
    expect(run(P, { a: 'x' }).issues).toBeUndefined();
  });

  it('required/pick/omit/extend keep strict rejection', () => {
    expect(issues(run(required(Strict), { a: 'x', tag: 't', zz: 1 }))[0]!.code).toBe('unknown_key');
    expect(issues(run(pick(Strict, ['a'] as const), { a: 'x', zz: 1 }))[0]!.code).toBe('unknown_key');
    expect(issues(run(omit(Strict, ['tag'] as const), { a: 'x', zz: 1 }))[0]!.code).toBe('unknown_key');
    expect(issues(run(extend(Strict, { b: number() }), { a: 'x', b: 1, zz: 1 }))[0]!.code).toBe('unknown_key');
  });

  it('extendSchema keeps strict rejection', () => {
    const E = extendSchema(Strict as FSchema<unknown>, { id: number() });
    expect(issues(run(E, { a: 'x', id: 1, zz: 1 }))[0]!.code).toBe('unknown_key');
  });

  it('strip keeps stripping through composition', () => {
    const v = ok(run(omit(Strip, [] as never[]), { a: 'x', junk: 1 })) as Record<string, unknown>;
    expect(v).toEqual({ a: 'x' });
    const p = ok(run(partial(Strip), { junk: 1 })) as Record<string, unknown>;
    expect(p).toEqual({});
  });

  it('merge: the second schema\'s policy wins outright (documented)', () => {
    const Plain = object({ b: number() });
    // strict second → strict result.
    const M1 = merge(Plain, Strict);
    expect(M1.additionalProperties).toBe(false);
    expect(issues(run(M1, { a: 'x', b: 1, zz: 1 }))[0]!.code).toBe('unknown_key');
    // passthrough second → passthrough result, even over a strict first.
    const M2 = merge(Strict, Plain);
    expect(M2.additionalProperties).toBeUndefined();
    expect(run(M2, { a: 'x', b: 1, zz: 1 }).issues).toBeUndefined();
  });
});

describe('composition rejects refined/transform/default_-wrapped object bases', () => {
  it('partial/extendSchema throw TypeError for a refined object base', () => {
    const Signup = refined(
      object({ password: string(), confirm: string() }),
      o => o.password === o.confirm,
    );
    expect(() => partial(Signup as never)).toThrow(TypeError);
    expect(() => extendSchema(Signup, { id: number() })).toThrow(TypeError);
  });

  it('extend/merge throw TypeError for a transform-wrapped object base', () => {
    const T = transform(object({ a: string() }), o => o.a.length);
    expect(() => extend(T as never, { b: string() })).toThrow(TypeError);
    expect(() => merge(object({ x: number() }), T as never)).toThrow(TypeError);
    expect(() => merge(T as never, object({ x: number() }))).toThrow(TypeError);
  });

  it('pick/omit/required throw TypeError for a default_-wrapped object base', () => {
    const D = default_(object({ a: string() }), { a: 'x' });
    expect(() => pick(D as never, ['a'] as never)).toThrow(TypeError);
    expect(() => omit(D as never, [] as never)).toThrow(TypeError);
    expect(() => required(D as never)).toThrow(TypeError);
  });

  it('an annotation over a wrapper still throws (wrapper detected through the chain)', () => {
    const W = describeSchema(refined(object({ a: string() }), () => true), 'docs');
    expect(() => partial(W as never)).toThrow(TypeError);
  });

  it('describe/title annotations over plain objects still compose, defaults intact', () => {
    const Annotated = describeSchema(
      object({ id: integer(), theme: default_(string(), 'L') }),
      'docs',
    );
    expect(ok(run(pick(Annotated, ['theme'] as const), {}))).toEqual({ theme: 'L' } as never);
    const Titled = title(object({ n: default_(integer(), 7) }), 'T');
    expect(ok(run(extend(Titled, { z: boolean() }), { z: true }))).toEqual({ n: 7, z: true } as never);
  });
});

describe('composition preserves wrappers over optional() keys', () => {
  const NickBase = object({
    nick: refined(optional(string()), v => v === undefined || v.length >= 3, 'too short'),
    other: integer(),
  });

  it('refined(optional()) survives pick/omit/partial/extend/merge', () => {
    const composed: Array<[string, FSchema<unknown>]> = [
      ['pick', pick(NickBase, ['nick'] as const)],
      ['omit', omit(NickBase, ['other'] as const)],
      ['partial', partial(NickBase)],
      ['extend', extend(NickBase, { z: boolean() })],
      ['merge-second', merge(object({ q: integer() }), NickBase)],
      ['merge-first', merge(NickBase, object({ q: integer() }))],
    ];
    for (const [name, C] of composed) {
      const r = run(C, { nick: 'ab', other: 1, q: 1, z: true });
      expect(issues(r).map(i => i.code), name).toContain('refine_failed');
      expect(run(C, { nick: 'long-enough', other: 1, q: 1, z: true }).issues, name).toBeUndefined();
      // the key stays optional through composition.
      expect(run(C, { other: 1, q: 1, z: true }).issues, name).toBeUndefined();
    }
  });

  it('transform(optional()) keeps materializing values through composition', () => {
    const TagBase = object({ tag: transform(optional(string()), v => v ?? 'none'), n: integer() });
    expect(ok(run(pick(TagBase, ['tag'] as const), {}))).toEqual({ tag: 'none' } as never);
    expect(ok(run(omit(TagBase, ['n'] as const), { tag: 'x' }))).toEqual({ tag: 'x' } as never);
  });

  it('wrappers survive repeated composition (round-trip)', () => {
    const PP = partial(pick(NickBase, ['nick'] as const));
    expect(issues(run(PP, { nick: 'ab' }))[0]!.code).toBe('refine_failed');
    expect(run(PP, {}).issues).toBeUndefined();
  });

  it('required() refuses to silently unwrap a wrapper over optional', () => {
    expect(() => required(NickBase)).toThrow(TypeError);
  });
});

describe('multipleOf decimal steps stay exact at large magnitudes', () => {
  it('accepts exact decimal multiples beyond the epsilon drift horizon (money scale)', () => {
    expect(ok(run(number({ multipleOf: 0.01 }), 20000000.01))).toBe(20000000.01);
    expect(ok(run(number({ multipleOf: 0.01 }), 1000000.19))).toBe(1000000.19);
    expect(ok(run(number({ multipleOf: 0.1 }), 123456789.1))).toBe(123456789.1);
    expect(ok(run(number({ multipleOf: 0.01 }), -20000000.01))).toBe(-20000000.01);
  });

  it('rejects near-multiples that an epsilon would falsely accept', () => {
    expect(issues(run(number({ multipleOf: 5 }), 5.0000000001))[0]!.code).toBe('not_a_multiple');
    expect(issues(run(number({ multipleOf: 1 }), 1e-10))[0]!.code).toBe('not_a_multiple');
  });

  it('small decimal agreements still hold', () => {
    expect(ok(run(number({ multipleOf: 0.1 }), 0.3))).toBe(0.3);
    expect(ok(run(number({ multipleOf: 0.0001 }), 0.0075))).toBe(0.0075);
    expect(issues(run(number({ multipleOf: 0.1 }), 0.35))[0]!.code).toBe('not_a_multiple');
  });
});

describe('default_ fallback cloneability is checked at construction', () => {
  it('throws TypeError at construction for non-cloneable plain fallbacks', () => {
    expect(() => default_(unknown(), { cb: () => {} })).toThrow(TypeError);
    expect(() => default_(unknown(), [Symbol('x')])).toThrow(TypeError);
    expect(() => default_(unknown(), { nested: { deep: () => 1 } })).toThrow(TypeError);
  });

  it('class instances pass through by reference (no prototype stripping, no throw)', () => {
    class Money {
      constructor(public cents: number) {}
    }
    const m = new Money(500);
    const S = default_(unknown(), m);
    const v = ok(run(S, undefined));
    expect(v).toBe(m);
    expect(v instanceof Money).toBe(true);
  });

  it('plain object/array fallbacks are still cloned per use', () => {
    const S = default_(unknown(), { tags: ['a'] });
    const v1 = ok(run(S, undefined)) as { tags: string[] };
    v1.tags.push('polluted');
    const v2 = ok(run(S, undefined)) as { tags: string[] };
    expect(v2.tags).toEqual(['a']);
  });

  it('a factory returning a non-cloneable value never throws (called per use, no clone)', () => {
    const S = default_(unknown(), () => ({ cb: () => 42 }));
    const v = ok(run(S, undefined)) as { cb: () => number };
    expect(v.cb()).toBe(42);
  });
});
