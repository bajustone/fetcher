/**
 * Composite schema factories. Each closes over a pre-compiled list of
 * sub-validators at construction time, so validation runs without walking
 * the schema object or dispatching on `schema.type`.
 *
 * @module
 */

import type {
  StandardSchemaV1Issue,
  StandardSchemaV1Result,
} from '../types.ts';
import type {
  ArrayOptions,
  FArray,
  FDefaultWrapper,
  FEnum,
  FIntersect,
  FNull,
  FObject,
  FObjectOutput,
  FOptionalWrapper,
  FProperties,
  FSchema,
  FUnion,
  Infer,
  ObjectOptions,
} from './types.ts';
import { collectMember, ensureSync, finalizeContainer, prependPath, safeSet } from './container.ts';

type SyncValidate<T> = (value: unknown) => StandardSchemaV1Result<T>;

function isOptional(
  entry: FSchema<unknown> | FOptionalWrapper<FSchema<unknown>> | FDefaultWrapper<FSchema<unknown>>,
): entry is FOptionalWrapper<FSchema<unknown>> {
  return (entry as FOptionalWrapper<FSchema<unknown>>)['~optional'] === true;
}

function isDefault(
  entry: FSchema<unknown> | FOptionalWrapper<FSchema<unknown>> | FDefaultWrapper<FSchema<unknown>>,
): entry is FDefaultWrapper<FSchema<unknown>> {
  return (entry as FDefaultWrapper<FSchema<unknown>>)['~default'] === true;
}

/**
 * Object schema factory.
 *
 * Key presence is checked with own-property semantics (`Object.hasOwn`) —
 * prototype-chain members like `toString` never satisfy a required key, and
 * keys literally named `'__proto__'` round-trip safely. An **optional key
 * that is present with value `undefined` is treated the same as a missing
 * key** (matching Zod and the standalone `optional()` behavior).
 *
 * Unknown-key policy is set via `opts.unknownKeys`:
 *
 * - `'passthrough'` (default) — unknown keys flow through untouched; when no
 *   member transform/default fires, the output is the *same reference* as
 *   the input (zero-copy). This is JSON Schema's `additionalProperties:
 *   true` default.
 * - `'strip'` — returns a new object containing only declared keys.
 * - `'strict'` — every unknown key yields an issue (code `unknown_key`) and
 *   the emitted JSON Schema carries `additionalProperties: false`.
 */
/* @__NO_SIDE_EFFECTS__ */
export function object<T extends FProperties>(
  props: T,
  opts: ObjectOptions = {},
): FObject<T> {
  const policy = opts.unknownKeys ?? 'passthrough';
  const required: string[] = [];
  const keys: string[] = [];
  const validators: Array<SyncValidate<unknown>> = [];
  const callIfMissing: boolean[] = [];
  // Null-prototype accumulators: a literal '__proto__' property key must
  // become an ordinary own entry, not a prototype swap.
  const properties: Record<string, FSchema<unknown>> = Object.create(null) as Record<string, FSchema<unknown>>;
  let defaults: Record<string, FDefaultWrapper<FSchema<unknown>>> | undefined;
  let optionals: Record<string, FOptionalWrapper<FSchema<unknown>>> | undefined;

  for (const key of Object.keys(props)) {
    const entry = props[key]!;
    keys.push(key);
    // Always the entry's own (outermost) validate: optional() short-circuits
    // undefined itself, and a transform/refined wrapper over an optional or
    // default keeps its composed behavior instead of being bypassed.
    validators.push(entry['~standard'].validate as SyncValidate<unknown>);
    if (isDefault(entry)) {
      properties[key] = entry['~wrapped'];
      (defaults ??= Object.create(null) as Record<string, FDefaultWrapper<FSchema<unknown>>>)[key] = entry;
      callIfMissing.push(true);
    }
    else if (isOptional(entry)) {
      properties[key] = entry['~wrapped'];
      // A refined/transform wrapper over optional() (it carries the '~inner'
      // link; a plain optional() does not) must survive composition —
      // `properties` only holds the bare inner schema, so record the full
      // wrapper in '~optionals' (the optional analogue of '~defaults').
      if (Object.hasOwn(entry, '~inner'))
        (optionals ??= Object.create(null) as Record<string, FOptionalWrapper<FSchema<unknown>>>)[key] = entry;
      // Run the validator even when the key is missing: plain optional()
      // returns { value: undefined } (a no-op), while a transform/refined
      // wrapper over an optional gets its chance to materialize a value.
      callIfMissing.push(true);
    }
    else {
      properties[key] = entry;
      required.push(key);
      callIfMissing.push(false);
    }
  }

  const known = policy === 'strict' ? new Set(keys) : undefined;

  return {
    'type': 'object',
    properties,
    required,
    ...(opts.$id !== undefined && { $id: opts.$id }),
    ...(policy === 'strict' && { additionalProperties: false }),
    ...(defaults !== undefined && { '~defaults': defaults }),
    ...(optionals !== undefined && { '~optionals': optionals }),
    ...(policy !== 'passthrough' && { '~unknownKeys': policy }),
    '~standard': {
      version: 1,
      vendor: 'fetcher',
      validate(v): StandardSchemaV1Result<FObjectOutput<T>> {
        if (typeof v !== 'object' || v === null || Array.isArray(v))
          return { issues: [{ code: 'expected_object', message: 'Expected object' }] };
        const obj = v as Record<string, unknown>;
        const issues: StandardSchemaV1Issue[] = [];
        for (let i = 0; i < required.length; i++) {
          const k = required[i]!;
          if (!Object.hasOwn(obj, k))
            issues.push({ code: 'missing', message: 'Missing', path: [k] });
        }
        let out: Record<string, unknown> | null = policy === 'strip' ? {} : null;
        for (let i = 0; i < keys.length; i++) {
          const k = keys[i]!;
          const missing = !Object.hasOwn(obj, k);
          if (missing && !callIfMissing[i])
            continue;
          // `missing ? undefined : obj[k]` — never read through the
          // prototype chain (obj['__proto__'] on a key-less object would
          // yield the prototype, not undefined).
          const input = missing ? undefined : obj[k];
          const r = ensureSync(validators[i]!(input));
          if (policy === 'strip') {
            if (r.issues) {
              for (let j = 0; j < r.issues.length; j++)
                issues.push(prependPath(k, r.issues[j]!));
            }
            else if (!missing || r.value !== undefined) {
              safeSet(out!, k, r.value);
            }
            continue;
          }
          out = collectMember(out, obj, k, input, r, issues);
        }
        if (known !== undefined) {
          const ownKeys = Object.keys(obj);
          for (let i = 0; i < ownKeys.length; i++) {
            const k = ownKeys[i]!;
            if (!known.has(k))
              issues.push({ code: 'unknown_key', message: 'Unknown key', path: [k] });
          }
        }
        if (issues.length)
          return { issues };
        return { value: (policy === 'strip' ? out! : (out ?? obj)) as FObjectOutput<T> };
      },
    },
  } as FObject<T>;
}

/**
 * Array schema factory — every element is validated against `items`;
 * `minItems`/`maxItems` bound the length. Transformed/defaulted member
 * values are threaded into a lazily-cloned output (zero-copy when nothing
 * changes).
 */
/* @__NO_SIDE_EFFECTS__ */
export function array<T extends FSchema<unknown>>(
  items: T,
  opts: ArrayOptions = {},
): FArray<T> {
  const { minItems, maxItems } = opts;
  const itemValidate = items['~standard'].validate as SyncValidate<Infer<T>>;
  return {
    'type': 'array',
    items,
    ...(minItems !== undefined && { minItems }),
    ...(maxItems !== undefined && { maxItems }),
    '~standard': {
      version: 1,
      vendor: 'fetcher',
      validate(v): StandardSchemaV1Result<Infer<T>[]> {
        if (!Array.isArray(v))
          return { issues: [{ code: 'expected_array', message: 'Expected array' }] };
        if (minItems !== undefined && v.length < minItems)
          return { issues: [{ code: 'too_short', message: 'Too short' }] };
        if (maxItems !== undefined && v.length > maxItems)
          return { issues: [{ code: 'too_long', message: 'Too long' }] };
        const issues: StandardSchemaV1Issue[] = [];
        let out: unknown[] | null = null;
        for (let i = 0; i < v.length; i++) {
          out = collectMember(out, v, i, v[i], ensureSync(itemValidate(v[i])), issues);
        }
        return finalizeContainer(out, v, issues) as StandardSchemaV1Result<Infer<T>[]>;
      },
    },
  } as FArray<T>;
}

/**
 * Marks a schema optional. Standalone, `undefined` short-circuits to
 * success; inside `object()`, the key may be missing — or present with
 * value `undefined` — without error, and is excluded from `required`.
 */
/* @__NO_SIDE_EFFECTS__ */
export function optional<T extends FSchema<unknown>>(schema: T): FOptionalWrapper<T> {
  const innerValidate = schema['~standard'].validate as SyncValidate<Infer<T>>;
  return {
    '~optional': true,
    '~wrapped': schema,
    '~standard': {
      version: 1,
      vendor: 'fetcher',
      validate(v): StandardSchemaV1Result<Infer<T> | undefined> {
        if (v === undefined)
          return { value: undefined };
        return ensureSync(innerValidate(v)) as StandardSchemaV1Result<Infer<T> | undefined>;
      },
    },
  } as FOptionalWrapper<T>;
}

/**
 * Accepts `null` or the inner schema. Emitted as
 * `anyOf: [inner, { type: 'null' }]`.
 */
/* @__NO_SIDE_EFFECTS__ */
export function nullable<T extends FSchema<unknown>>(schema: T): FUnion<[T, FNull]> {
  const innerValidate = schema['~standard'].validate as SyncValidate<Infer<T>>;
  return {
    'anyOf': [schema, { type: 'null' }] as unknown as [T, FNull],
    '~standard': {
      version: 1,
      vendor: 'fetcher',
      validate(v): StandardSchemaV1Result<Infer<T> | null> {
        if (v === null)
          return { value: null };
        return ensureSync(innerValidate(v)) as StandardSchemaV1Result<Infer<T> | null>;
      },
    },
  } as FUnion<[T, FNull]>;
}

/**
 * Untagged union — variants are tried in order, first match wins.
 *
 * On failure, the result begins with a summary issue (code
 * `no_variant_matched`, naming how many variants were tried) followed by
 * the issues of the **best-matching** variant — the one that produced the
 * fewest issues — with their original paths intact, so nested failures stay
 * actionable (and routable by `groupIssuesByField`).
 */
/* @__NO_SIDE_EFFECTS__ */
export function union<T extends readonly [FSchema<unknown>, ...FSchema<unknown>[]]>(
  schemas: T,
): FUnion<T> {
  const validators = schemas.map(
    s => s['~standard'].validate as SyncValidate<unknown>,
  );
  return {
    'anyOf': schemas,
    '~standard': {
      version: 1,
      vendor: 'fetcher',
      validate(v): StandardSchemaV1Result<Infer<T[number]>> {
        let best: ReadonlyArray<StandardSchemaV1Issue> | undefined;
        for (let i = 0; i < validators.length; i++) {
          const r = ensureSync(validators[i]!(v));
          if (!r.issues)
            return r as StandardSchemaV1Result<Infer<T[number]>>;
          if (best === undefined || r.issues.length < best.length)
            best = r.issues;
        }
        const n = validators.length;
        return {
          issues: [
            { code: 'no_variant_matched', message: `No variant matched (${n} variant${n === 1 ? '' : 's'} tried)` },
            ...best!,
          ],
        };
      },
    },
  } as FUnion<T>;
}

type Intersection<T extends readonly unknown[]>
  = T extends readonly [infer H, ...infer R]
    ? H & Intersection<R>
    : unknown;

/**
 * Intersection (`allOf`) — the value must satisfy every member. Each
 * member's output is threaded into the next, so transforms/defaults applied
 * by earlier members are visible to later ones and to the final result.
 */
/* @__NO_SIDE_EFFECTS__ */
export function intersect<T extends readonly [FSchema<unknown>, ...FSchema<unknown>[]]>(
  schemas: T,
): FIntersect<T> {
  const validators = schemas.map(
    s => s['~standard'].validate as SyncValidate<unknown>,
  );
  return {
    'allOf': schemas,
    '~standard': {
      version: 1,
      vendor: 'fetcher',
      validate(v): StandardSchemaV1Result<Intersection<{ [K in keyof T]: Infer<T[K]> }>> {
        const issues: StandardSchemaV1Issue[] = [];
        let value: unknown = v;
        for (let i = 0; i < validators.length; i++) {
          const r = ensureSync(validators[i]!(value));
          if (r.issues) {
            for (let j = 0; j < r.issues.length; j++)
              issues.push(r.issues[j]!);
          }
          else {
            // Thread each member's output into the next so transforms/defaults
            // applied by earlier members are visible to later ones and to the
            // final result.
            value = r.value;
          }
        }
        return issues.length
          ? { issues }
          : { value: value as Intersection<{ [K in keyof T]: Infer<T[K]> }> };
      },
    },
  } as FIntersect<T>;
}

/**
 * Enum (closed value set) schema. Membership uses **SameValueZero**
 * equality (`Set.has`) — the same convention as `literal()`.
 */
/* @__NO_SIDE_EFFECTS__ */
export function enum_<T extends string | number | boolean>(
  values: readonly T[],
): FEnum<T> {
  const set = new Set<unknown>(values);
  return {
    'enum': values,
    '~standard': {
      version: 1,
      vendor: 'fetcher',
      validate(v): StandardSchemaV1Result<T> {
        if (!set.has(v))
          return { issues: [{ code: 'not_in_enum', message: 'Not in enum' }] };
        return { value: v as T };
      },
    },
  } as FEnum<T>;
}
