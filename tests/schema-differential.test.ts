/**
 * Differential / property-based parity harness (issue #12).
 *
 * Generates paired schemas — a fetcher builder schema and an equivalent Zod
 * schema — over a small grammar, then runs the *same* inputs through both and
 * asserts they agree on:
 *
 *   1. accept / reject,
 *   2. the output value on success (deep-equal — this is what catches #8:
 *      transformed/defaulted values nested in array/record/tuple), and
 *   3. the set of failing issue paths (for union-free schemas, where the two
 *      validators report structurally comparable paths).
 *
 * Deterministic by default (fixed seed) so CI is stable. Set `FUZZ_SEED` and
 * `FUZZ_ITERATIONS` to widen the search for a deeper, on-demand fuzz run:
 *
 *   FUZZ_ITERATIONS=20000 FUZZ_SEED=123 bun test schema-differential
 *
 * KNOWN INTENTIONAL DIVERGENCES (deliberately not generated, so real bugs
 * aren't drowned in expected mismatches):
 *   - No coercion / preprocess — both sides are strict.
 *   - fetcher objects pass unknown keys through, so Zod objects are built with
 *     `.passthrough()` to match (Zod strips by default).
 *   - String length semantics: fetcher counts Unicode CODE POINTS (JSON
 *     Schema 2020-12 / RFC 8259), Zod counts UTF-16 code units. They diverge
 *     on astral-plane characters ('💩' is 1 vs 2), so the grammar generates
 *     only BMP/ASCII strings for length-constrained schemas. Do not add
 *     astral strings to the length-comparison inputs — the divergence is by
 *     design (covered by the JSON-Schema-suite tests instead).
 *   - String `format` enforcement differences — not exercised here (covered
 *     by the unit suite instead). `multipleOf` IS exercised, with steps and
 *     values where the two float strategies (fetcher: quotient-vs-epsilon,
 *     Zod: decimal-scaled remainder) provably agree.
 */

import type { FSchema } from '../src/schema/index.ts';
import type { StandardSchemaV1Result } from '../src/types.ts';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import {
  array,
  boolean,
  default_,
  discriminatedUnion,
  enum_,
  integer,
  intersect,
  literal,
  nullable,
  number,
  object,
  optional,
  record,
  string,
  transform,
  tuple,
  union,
} from '../src/schema/index.ts';

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32) — deterministic, no Math.random.
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = Number(process.env.FUZZ_SEED ?? 0xC0FFEE);
const ITERATIONS = Number(process.env.FUZZ_ITERATIONS ?? 400);

function pick<T>(rng: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rng() * xs.length)]!;
}

function randInt(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

// ---------------------------------------------------------------------------
// Schema descriptors — a structural tree we can turn into both a fetcher
// schema and a Zod schema, and from which we can generate valid inputs.
// ---------------------------------------------------------------------------

type Desc
  = | { t: 'string' }
    | { t: 'number' }
    | { t: 'integer' }
    | { t: 'boolean' }
    | { t: 'enum'; values: string[] }
    | { t: 'upper' } // string -> toUpperCase()
    | { t: 'inc' } // number -> +1
    | { t: 'stringC'; minLength: number; maxLength: number } // ASCII only — see header
    | { t: 'patternC' } // '^[a-z]+$'
    | { t: 'numberC'; minimum: number; maximum: number }
    | { t: 'exclusiveC'; gt: number; lt: number }
    | { t: 'multipleC'; step: number } // integer step — exact in both float strategies
    | { t: 'default'; value: string; inner: { t: 'string' } }
    | { t: 'nullable'; inner: Desc }
    | { t: 'array'; inner: Desc }
    | { t: 'record'; inner: Desc }
    | { t: 'tuple'; items: Desc[] }
    | { t: 'union'; variants: Desc[] }
    | { t: 'intersect'; aKey: string; aInner: Desc; bKey: string; bInner: Desc }
    | { t: 'dunion'; key: string; variants: Array<{ tag: string; inner: Desc }> }
    | { t: 'object'; props: Array<{ key: string; kind: 'required' | 'optional' | 'default'; inner: Desc }> };

// `default` is intentionally NOT a nestable leaf: wrapping it in
// `optional()`/`nullable()` is a semantically ambiguous combination that
// fetcher and Zod resolve differently (a documented esoteric corner, not a
// filed bug). It's exercised as an object-property kind and via the explicit
// default-in-collection cases below.
const LEAVES: Array<(rng: () => number) => Desc> = [
  () => ({ t: 'string' }),
  () => ({ t: 'number' }),
  () => ({ t: 'integer' }),
  () => ({ t: 'boolean' }),
  () => ({ t: 'enum', values: ['red', 'green', 'blue'] }),
  () => ({ t: 'upper' }),
  () => ({ t: 'inc' }),
  (rng) => {
    const minLength = randInt(rng, 0, 3);
    return { t: 'stringC', minLength, maxLength: minLength + randInt(rng, 0, 3) };
  },
  () => ({ t: 'patternC' }),
  (rng) => {
    const minimum = randInt(rng, -10, 5);
    return { t: 'numberC', minimum, maximum: minimum + randInt(rng, 0, 10) };
  },
  (rng) => {
    const gt = randInt(rng, -5, 2);
    return { t: 'exclusiveC', gt, lt: gt + randInt(rng, 2, 8) };
  },
  rng => ({ t: 'multipleC', step: pick(rng, [1, 2, 3, 5]) }),
];

// Plain (transform- and default-free) leaves for intersect members: Zod's
// intersection parses the SAME input through both sides and deep-merges the
// results, so a transform on one side would produce an "unmergeable" conflict
// that fetcher's thread-through strategy resolves differently.
const PLAIN_LEAVES: Array<(rng: () => number) => Desc>
  = LEAVES.filter((make) => {
    const t = make(mulberry32(1)).t;
    return t !== 'upper' && t !== 'inc';
  });

function genDesc(rng: () => number, depth: number): Desc {
  if (depth <= 0)
    return pick(rng, LEAVES)(rng);

  const kind = pick(rng, ['leaf', 'object', 'array', 'record', 'tuple', 'union', 'nullable', 'intersect', 'dunion']);
  switch (kind) {
    case 'object': {
      const n = randInt(rng, 1, 3);
      const props = Array.from({ length: n }, (_, i) => ({
        key: `k${i}`,
        kind: pick(rng, ['required', 'optional', 'default'] as const),
        inner: genDesc(rng, depth - 1),
      }));
      // `default` only wraps a string leaf (matches the descriptor shape).
      for (const p of props) {
        if (p.kind === 'default')
          p.inner = { t: 'string' };
      }
      return { t: 'object', props };
    }
    case 'array':
      return { t: 'array', inner: genDesc(rng, depth - 1) };
    case 'record':
      return { t: 'record', inner: genDesc(rng, depth - 1) };
    case 'tuple':
      return { t: 'tuple', items: Array.from({ length: randInt(rng, 1, 3) }, () => genDesc(rng, depth - 1)) };
    case 'union':
      // Distinct primitive variants so a value matches exactly one — keeps
      // first-match output unambiguous across both validators.
      return { t: 'union', variants: [{ t: 'string' }, { t: 'number' }, { t: 'boolean' }] };
    case 'intersect':
      // Two single-prop objects with DISTINCT keys — merge-conflict-free, so
      // output parity is well-defined on both sides.
      return {
        t: 'intersect',
        aKey: 'ia',
        aInner: pick(rng, PLAIN_LEAVES)(rng),
        bKey: 'ib',
        bInner: pick(rng, PLAIN_LEAVES)(rng),
      };
    case 'dunion':
      return {
        t: 'dunion',
        key: 'tag',
        variants: [
          { tag: 'a', inner: pick(rng, LEAVES)(rng) },
          { tag: 'b', inner: pick(rng, LEAVES)(rng) },
        ],
      };
    case 'nullable':
      return { t: 'nullable', inner: genDesc(rng, depth - 1) };
    default:
      return pick(rng, LEAVES)(rng);
  }
}

// ---------------------------------------------------------------------------
// Descriptor → fetcher schema
// ---------------------------------------------------------------------------

function buildF(d: Desc): FSchema<unknown> {
  switch (d.t) {
    case 'string': return string();
    case 'number': return number();
    case 'integer': return integer();
    case 'boolean': return boolean();
    case 'enum': return enum_(d.values);
    case 'upper': return transform(string(), s => s.toUpperCase());
    case 'inc': return transform(number(), n => n + 1);
    case 'stringC': return string({ minLength: d.minLength, maxLength: d.maxLength });
    case 'patternC': return string({ pattern: '^[a-z]+$' });
    case 'numberC': return number({ minimum: d.minimum, maximum: d.maximum });
    case 'exclusiveC': return number({ exclusiveMinimum: d.gt, exclusiveMaximum: d.lt });
    case 'multipleC': return number({ multipleOf: d.step });
    case 'default': return default_(string(), d.value) as unknown as FSchema<unknown>;
    case 'nullable': return nullable(buildF(d.inner));
    case 'array': return array(buildF(d.inner));
    case 'record': return record(buildF(d.inner));
    case 'tuple': return tuple(d.items.map(buildF) as [FSchema<unknown>, ...FSchema<unknown>[]]);
    case 'union': return union(d.variants.map(buildF) as [FSchema<unknown>, ...FSchema<unknown>[]]);
    case 'intersect':
      return intersect([
        object({ [d.aKey]: buildF(d.aInner) } as Parameters<typeof object>[0]),
        object({ [d.bKey]: buildF(d.bInner) } as Parameters<typeof object>[0]),
      ]);
    case 'dunion': {
      const mapping: Record<string, FSchema<unknown>> = {};
      for (const v of d.variants)
        mapping[v.tag] = object({ [d.key]: literal(v.tag), v: buildF(v.inner) } as Parameters<typeof object>[0]);
      return discriminatedUnion(d.key, mapping);
    }
    case 'object': {
      const props: Record<string, unknown> = {};
      for (const p of d.props) {
        const inner = buildF(p.inner);
        props[p.key]
          = p.kind === 'required'
            ? inner
            : p.kind === 'optional'
              ? optional(inner)
              : default_(string(), 'DEF');
      }
      return object(props as Parameters<typeof object>[0]);
    }
  }
}

// ---------------------------------------------------------------------------
// Descriptor → Zod schema (the reference). Objects use `.passthrough()` to
// match fetcher's non-stripping behavior.
// ---------------------------------------------------------------------------

function buildZ(d: Desc): z.ZodTypeAny {
  switch (d.t) {
    case 'string': return z.string();
    case 'number': return z.number();
    case 'integer': return z.number().int();
    case 'boolean': return z.boolean();
    case 'enum': return z.enum(d.values as [string, ...string[]]);
    case 'upper': return z.string().transform(s => s.toUpperCase());
    case 'inc': return z.number().transform(n => n + 1);
    case 'stringC': return z.string().min(d.minLength).max(d.maxLength);
    case 'patternC': return z.string().regex(/^[a-z]+$/);
    case 'numberC': return z.number().gte(d.minimum).lte(d.maximum);
    case 'exclusiveC': return z.number().gt(d.gt).lt(d.lt);
    case 'multipleC': return z.number().multipleOf(d.step);
    case 'default': return z.string().default(d.value);
    case 'nullable': return buildZ(d.inner).nullable();
    case 'array': return z.array(buildZ(d.inner));
    case 'record': return z.record(z.string(), buildZ(d.inner));
    case 'tuple': return z.tuple(d.items.map(buildZ) as [z.ZodTypeAny, ...z.ZodTypeAny[]]);
    case 'union': return z.union(d.variants.map(buildZ) as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
    case 'intersect':
      return z.intersection(
        z.object({ [d.aKey]: buildZ(d.aInner) }).passthrough(),
        z.object({ [d.bKey]: buildZ(d.bInner) }).passthrough(),
      );
    case 'dunion':
      return z.discriminatedUnion(d.key, d.variants.map(v =>
        z.object({ [d.key]: z.literal(v.tag), v: buildZ(v.inner) }).passthrough()) as never);
    case 'object': {
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const p of d.props) {
        shape[p.key]
          = p.kind === 'required'
            ? buildZ(p.inner)
            : p.kind === 'optional'
              ? buildZ(p.inner).optional()
              : z.string().default('DEF');
      }
      return z.object(shape).passthrough();
    }
  }
}

// ---------------------------------------------------------------------------
// Descriptor → a valid input value
// ---------------------------------------------------------------------------

function genValid(d: Desc, rng: () => number): unknown {
  switch (d.t) {
    case 'string': return pick(rng, ['', 'a', 'hello', 'Z9']);
    case 'upper': return pick(rng, ['abc', 'XyZ', '']);
    case 'number': return randInt(rng, -50, 50) + (rng() < 0.5 ? 0 : 0.25);
    case 'inc': return randInt(rng, -50, 50);
    case 'integer': return randInt(rng, -50, 50);
    case 'boolean': return rng() < 0.5;
    case 'enum': return pick(rng, d.values);
    // ASCII only — astral length semantics intentionally diverge (header).
    case 'stringC': return 'a'.repeat(randInt(rng, d.minLength, d.maxLength));
    case 'patternC': return pick(rng, ['abc', 'zzz', 'q']);
    case 'numberC': return randInt(rng, d.minimum, d.maximum);
    case 'exclusiveC': return randInt(rng, d.gt + 1, d.lt - 1);
    case 'multipleC': return d.step * randInt(rng, -5, 5);
    // `default` agrees with Zod on `undefined` → exercise the fallback path.
    case 'default': return rng() < 0.5 ? undefined : pick(rng, ['x', 'y']);
    case 'nullable': return rng() < 0.3 ? null : genValid(d.inner, rng);
    case 'array': return Array.from({ length: randInt(rng, 0, 3) }, () => genValid(d.inner, rng));
    case 'record': {
      const out: Record<string, unknown> = {};
      for (let i = 0; i < randInt(rng, 0, 3); i++)
        out[`r${i}`] = genValid(d.inner, rng);
      return out;
    }
    case 'tuple': return d.items.map(item => genValid(item, rng));
    case 'union': return genValid(pick(rng, d.variants), rng);
    case 'intersect':
      return { [d.aKey]: genValid(d.aInner, rng), [d.bKey]: genValid(d.bInner, rng) };
    case 'dunion': {
      const variant = pick(rng, d.variants);
      return { [d.key]: variant.tag, v: genValid(variant.inner, rng) };
    }
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const p of d.props) {
        if (p.kind === 'optional') {
          const roll = rng();
          if (roll < 0.3)
            continue; // omit optional keys sometimes
          if (roll < 0.45) {
            // explicit `undefined` — both sides treat it as missing.
            out[p.key] = undefined;
            continue;
          }
        }
        if (p.kind === 'default') {
          if (rng() < 0.5)
            continue; // omit → default applies
          out[p.key] = pick(rng, ['x', 'y']);
          continue;
        }
        out[p.key] = genValid(p.inner, rng);
      }
      return out;
    }
  }
}

function descHasUnion(d: Desc): boolean {
  switch (d.t) {
    case 'union': return true;
    case 'nullable':
    case 'array':
    case 'record': return descHasUnion(d.inner);
    case 'tuple': return d.items.some(descHasUnion);
    case 'intersect': return descHasUnion(d.aInner) || descHasUnion(d.bInner);
    // dunion is path-comparable: both report the discriminator failure at
    // [key] and delegate body failures to the matched variant.
    case 'dunion': return d.variants.some(v => descHasUnion(v.inner));
    case 'object': return d.props.some(p => descHasUnion(p.inner));
    default: return false;
  }
}

// ---------------------------------------------------------------------------
// Arbitrary JSON value generator (for accept/reject fuzzing).
// ---------------------------------------------------------------------------

function randValue(rng: () => number, depth: number): unknown {
  const r = rng();
  if (depth <= 0 || r < 0.6) {
    return pick(rng, [
      '',
      'abc',
      'red',
      0,
      1,
      -3,
      2.5,
      true,
      false,
      null,
    ]);
  }
  if (r < 0.8)
    return Array.from({ length: randInt(rng, 0, 3) }, () => randValue(rng, depth - 1));
  const out: Record<string, unknown> = {};
  for (let i = 0; i < randInt(rng, 0, 3); i++)
    out[`k${i}`] = randValue(rng, depth - 1);
  return out;
}

// ---------------------------------------------------------------------------
// Comparison helpers
// ---------------------------------------------------------------------------

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b)
    return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object')
    return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
      return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length)
    return false;
  return ak.every(k => k in bo && deepEqual(ao[k], bo[k]));
}

function fPathSet(r: StandardSchemaV1Result<unknown>): Set<string> {
  const set = new Set<string>();
  if (r.issues) {
    for (const iss of r.issues)
      set.add((iss.path ?? []).map(String).join('.'));
  }
  return set;
}

function zPathSet(err: z.ZodError): Set<string> {
  const set = new Set<string>();
  for (const iss of err.issues)
    set.add(iss.path.map(String).join('.'));
  return set;
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

describe('schema builder parity vs Zod (differential)', () => {
  it(`agrees on accept/reject + output + paths over ${ITERATIONS} generated cases (seed ${SEED})`, () => {
    const rng = mulberry32(SEED);
    let checked = 0;

    for (let iter = 0; iter < ITERATIONS; iter++) {
      const desc = genDesc(rng, randInt(rng, 0, 3));
      const f = buildF(desc);
      const zSchema = buildZ(desc);
      const fValidate = f['~standard'].validate as (v: unknown) => StandardSchemaV1Result<unknown>;
      const hasUnion = descHasUnion(desc);

      // One guaranteed-valid input + a few arbitrary ones.
      const inputs: unknown[] = [genValid(desc, rng)];
      for (let k = 0; k < 3; k++)
        inputs.push(randValue(rng, 3));

      for (const input of inputs) {
        const fr = fValidate(structuredClone(input));
        const zr = zSchema.safeParse(structuredClone(input));

        const fOk = !fr.issues;
        const diag = () => `\ndesc=${JSON.stringify(desc)}\ninput=${JSON.stringify(input)}\nfetcher=${JSON.stringify(fr)}\nzod=${JSON.stringify(zr)}`;

        // 1. accept / reject agreement
        expect(fOk, `accept/reject mismatch${diag()}`).toBe(zr.success);

        if (fOk && zr.success) {
          // 2. output-value agreement (this is the #8 catch)
          expect(deepEqual(fr.value, zr.data), `output mismatch${diag()}`).toBe(true);
        }
        else if (!fOk && !zr.success && !hasUnion) {
          // 3. failing-path agreement (union-free only). Subset, not equality:
          // fetcher short-circuits container length/type checks (one root
          // issue) where Zod keeps validating members, so Zod legitimately
          // reports a superset. What matters is that every path fetcher flags
          // is a path Zod also flags — fetcher must never invent a wrong path.
          const fp = fPathSet(fr);
          const zp = zPathSet(zr.error);
          for (const p of fp)
            expect(zp.has(p), `path ${JSON.stringify(p)} reported by fetcher but not Zod${diag()}`).toBe(true);
        }
        checked++;
      }
    }

    expect(checked).toBeGreaterThan(0);
  });

  it('catches the #8 regression: transform nested in array (output parity)', () => {
    const desc: Desc = { t: 'array', inner: { t: 'upper' } };
    const f = buildF(desc)['~standard'].validate as (v: unknown) => StandardSchemaV1Result<unknown>;
    const zSchema = buildZ(desc);
    const input = ['a', 'bc', ''];
    const fr = f(input);
    const zr = zSchema.safeParse(input);
    expect(zr.success).toBe(true);
    expect(fr.issues).toBeUndefined();
    if (!fr.issues && zr.success)
      expect(deepEqual(fr.value, zr.data)).toBe(true); // ['A','BC',''] on both
  });

  it('default_ nested in array/record/tuple matches Zod (issue #8)', () => {
    const cases: Array<{ f: FSchema<unknown>; z: z.ZodTypeAny; input: unknown }> = [
      { f: array(default_(string(), 'D')), z: z.array(z.string().default('D')), input: [undefined, 'x'] },
      { f: record(default_(string(), 'D')), z: z.record(z.string(), z.string().default('D')), input: { a: undefined, b: 'x' } },
      { f: tuple([default_(string(), 'D')]), z: z.tuple([z.string().default('D')]), input: [undefined] },
    ];
    for (const c of cases) {
      const fr = (c.f['~standard'].validate as (v: unknown) => StandardSchemaV1Result<unknown>)(structuredClone(c.input));
      const zr = c.z.safeParse(structuredClone(c.input));
      expect(zr.success).toBe(true);
      expect(fr.issues).toBeUndefined();
      if (!fr.issues && zr.success)
        expect(deepEqual(fr.value, zr.data)).toBe(true);
    }
  });

  it('constraint boundaries: at-limit and one-off-limit inputs agree with Zod', () => {
    const cases: Array<{ name: string; f: FSchema<unknown>; z: z.ZodTypeAny; inputs: unknown[] }> = [
      {
        name: 'string min/max length (ASCII — astral excluded by design, see header)',
        f: string({ minLength: 2, maxLength: 4 }),
        z: z.string().min(2).max(4),
        inputs: ['a', 'ab', 'abcd', 'abcde', ''],
      },
      {
        name: 'pattern',
        f: string({ pattern: '^[a-z]+$' }),
        z: z.string().regex(/^[a-z]+$/),
        inputs: ['abc', 'ABC', '', 'a1'],
      },
      {
        name: 'inclusive bounds',
        f: number({ minimum: -3, maximum: 7 }),
        z: z.number().gte(-3).lte(7),
        inputs: [-4, -3, 0, 7, 8, 7.0000001],
      },
      {
        name: 'exclusive bounds',
        f: number({ exclusiveMinimum: 0, exclusiveMaximum: 10 }),
        z: z.number().gt(0).lt(10),
        inputs: [0, 0.0001, 9.9999, 10, -1],
      },
      {
        name: 'multipleOf integer step',
        f: number({ multipleOf: 3 }),
        z: z.number().multipleOf(3),
        inputs: [0, 3, -9, 7, 3.5],
      },
      {
        // DOCUMENTED DIVERGENCE: `0.1 + 0.2` (= 0.30000000000000004) is
        // excluded from the parity inputs — Zod v4 accepts it as a multiple
        // of 0.1, but the JSON number 0.30000000000000004 divided by 0.1 is
        // 3.0000000000000004, not an integer, so fetcher's decimal-exact
        // check rejects it (JSON Schema 2020-12: "division ... results in
        // an integer"). Fetcher's verdict is pinned separately below.
        name: 'multipleOf decimal step (agreement zone of both float strategies)',
        f: number({ multipleOf: 0.1 }),
        z: z.number().multipleOf(0.1),
        inputs: [0.3, 0.35, 1.21],
      },
      {
        name: 'multipleOf large magnitude (old relative-tolerance false-accept)',
        f: number({ multipleOf: 1 }),
        z: z.number().multipleOf(1),
        inputs: [10000000000.001, 600000000.5, 600000001],
      },
      {
        name: 'non-finite numbers (both finite-by-default)',
        f: number(),
        z: z.number(),
        inputs: [Infinity, -Infinity, Number.NaN, 1e308, Number('1e999')],
      },
      {
        name: 'integer non-finite / float',
        f: integer(),
        z: z.number().int(),
        inputs: [Infinity, Number.NaN, 1.5, 2, 1.0],
      },
    ];
    for (const c of cases) {
      const fValidate = c.f['~standard'].validate as (v: unknown) => StandardSchemaV1Result<unknown>;
      for (const input of c.inputs) {
        const fOk = !fValidate(input).issues;
        const zOk = c.z.safeParse(input).success;
        expect(fOk, `${c.name}: input ${String(input)} fetcher=${fOk} zod=${zOk}`).toBe(zOk);
      }
    }
  });

  it('multipleOf divergence pin: 0.1 + 0.2 is NOT a multiple of 0.1 (decimal-exact; Zod is lenient here)', () => {
    const f = number({ multipleOf: 0.1 });
    const r = (f['~standard'].validate as (v: unknown) => StandardSchemaV1Result<unknown>)(0.1 + 0.2);
    expect(r.issues).toBeDefined();
  });

  it('optional object key present with explicit undefined agrees with Zod', () => {
    const f = object({ a: optional(string()) });
    const zS = z.object({ a: z.string().optional() }).passthrough();
    const input = { a: undefined };
    const fr = (f['~standard'].validate as (v: unknown) => StandardSchemaV1Result<unknown>)(structuredClone(input));
    const zr = zS.safeParse(structuredClone(input));
    expect(zr.success).toBe(true);
    expect(fr.issues).toBeUndefined();
    if (!fr.issues && zr.success)
      expect(deepEqual(fr.value, zr.data)).toBe(true);
  });

  it('discriminatedUnion failure paths agree with Zod', () => {
    const f = discriminatedUnion('tag', {
      a: object({ tag: literal('a'), v: string() } as unknown as Parameters<typeof object>[0]),
      b: object({ tag: literal('b'), v: number() } as unknown as Parameters<typeof object>[0]),
    });
    const zS = z.discriminatedUnion('tag', [
      z.object({ tag: z.literal('a'), v: z.string() }).passthrough(),
      z.object({ tag: z.literal('b'), v: z.number() }).passthrough(),
    ]);
    const fValidate = f['~standard'].validate as (v: unknown) => StandardSchemaV1Result<unknown>;
    for (const input of [{ tag: 'a', v: 1 }, { tag: 'c', v: 1 }, {}, { tag: 'b', v: 2 }]) {
      const fr = fValidate(structuredClone(input));
      const zr = zS.safeParse(structuredClone(input));
      expect(!fr.issues).toBe(zr.success);
      if (fr.issues && !zr.success) {
        const fp = fPathSet(fr);
        const zp = zPathSet(zr.error);
        for (const p of fp)
          expect(zp.has(p), `path ${p} reported by fetcher but not Zod`).toBe(true);
      }
    }
  });
});
