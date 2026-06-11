/**
 * Meta-helper regressions (`describe`/`title`/`brand`): annotations must
 * never change validation behavior — including when they wrap `optional()`
 * wrappers, transforms, and unresolved `ref()`s annotated *before*
 * `compile()` (the spread copy used to orphan the ref's binder, leaving the
 * graph permanently unresolved).
 */

import type { FSchema } from '../src/schema/index.ts';
import type { StandardSchemaV1Result } from '../src/types.ts';
import { describe as bunDescribe, expect, it } from 'bun:test';
import {
  array,
  brand,
  compile,
  default_,
  describe as describeSchema,
  integer,
  object,
  optional,
  ref,
  string,
  title,
  transform,
} from '../src/schema/index.ts';

function run<T>(schema: FSchema<T>, value: unknown): StandardSchemaV1Result<T> {
  return schema['~standard'].validate(value) as StandardSchemaV1Result<T>;
}

bunDescribe('describe/title annotations', () => {
  it('attach metadata without altering validation', () => {
    const d = describeSchema(string({ minLength: 2 }), 'a name');
    expect((d as unknown as { description: string }).description).toBe('a name');
    expect(run(d, 'ab').issues).toBeUndefined();
    expect(run(d, 'a').issues?.[0]!.code).toBe('too_short');

    const t = title(integer(), 'Count');
    expect((t as unknown as { title: string }).title).toBe('Count');
    expect(run(t, 3).issues).toBeUndefined();
    expect(run(t, 'x').issues?.[0]!.code).toBe('expected_integer');
  });

  it('describe over optional() keeps optionality inside object()', () => {
    const S = object({ tag: describeSchema(optional(string()), 'optional tag') });
    expect(S.required).toEqual([]);
    expect(run(S, {}).issues).toBeUndefined();
    expect(run(S, { tag: 'x' }).issues).toBeUndefined();
    expect(run(S, { tag: undefined }).issues).toBeUndefined();
    expect(run(S, { tag: 1 }).issues?.[0]!.code).toBe('expected_string');
  });

  it('describe over transform keeps the transform', () => {
    const S = describeSchema(transform(string(), s => s.toUpperCase()), 'upper');
    const r = run(S, 'ab');
    expect(r.issues).toBeUndefined();
    expect((r as { value: string }).value).toBe('AB');
  });

  it('title over default_ keeps the default treatment inside object()', () => {
    const S = object({ theme: title(default_(string(), 'light'), 'Theme') });
    expect(S.required).toEqual([]);
    const r = run(S, {});
    expect(r.issues).toBeUndefined();
    expect((r as { value: { theme: string } }).value.theme).toBe('light');
  });

  it('describe(ref) before compile() still binds (the historic breakage)', () => {
    const Name = string({ minLength: 2 });
    const S = object({ name: describeSchema(ref<string>('Name'), 'the name') });
    compile(S, { Name });
    expect(run(S, { name: 'ab' }).issues).toBeUndefined();
    expect(run(S, { name: 'a' }).issues?.[0]!.code).toBe('too_short');
    expect(run(S, { name: 'a' }).issues?.[0]!.code).not.toBe('unresolved_ref');
  });

  it('title(ref) before compile() binds too, including in arrays', () => {
    const Item = object({ id: integer() });
    const S = object({ items: array(title(ref('Item'), 'Items')) });
    compile(S, { Item });
    expect(run(S, { items: [{ id: 1 }] }).issues).toBeUndefined();
    expect(run(S, { items: [{ id: 'x' }] }).issues?.[0]!.path).toEqual(['items', 0, 'id']);
  });

  it('annotations stack (describe + title) and keep validating', () => {
    const S = title(describeSchema(string(), 'desc'), 'Title');
    expect((S as unknown as { description: string }).description).toBe('desc');
    expect((S as unknown as { title: string }).title).toBe('Title');
    expect(run(S, 'ok').issues).toBeUndefined();
    expect(run(S, 1).issues?.[0]!.code).toBe('expected_string');
  });

  it('stacked annotations over a ref still bind through both layers', () => {
    const Name = string();
    const S = object({ name: title(describeSchema(ref<string>('Name'), 'd'), 'T') });
    compile(S, { Name });
    expect(run(S, { name: 'x' }).issues).toBeUndefined();
  });
});

bunDescribe('brand', () => {
  it('is a type-level identity — same object, same validation', () => {
    const base = integer({ minimum: 1 });
    const UserId = brand<'UserId'>()(base);
    expect(UserId as unknown).toBe(base as unknown);
    expect(run(UserId, 5).issues).toBeUndefined();
    expect(run(UserId, 0).issues?.[0]!.code).toBe('too_small');
  });

  it('branded refs keep binding (identity preserved)', () => {
    const Name = string();
    const branded = brand<'Name'>()(ref<string>('Name'));
    const S = object({ name: branded });
    compile(S, { Name });
    expect(run(S, { name: 'x' }).issues).toBeUndefined();
  });
});
