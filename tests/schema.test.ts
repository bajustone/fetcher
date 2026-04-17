import type { FSchema, Infer } from '../src/schema/index.ts';
import type { StandardSchemaV1Result } from '../src/types.ts';
import { describe, expect, it } from 'bun:test';
import { fromJSONSchema } from '../src/from-json-schema.ts';
import {
  array,
  boolean,
  compile,
  date,
  datetime,
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
  ref,
  string,
  time,
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
