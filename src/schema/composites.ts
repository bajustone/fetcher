/**
 * Composite schema factories. Each closes over a pre-compiled list of
 * sub-validators at construction time, so validation runs without walking
 * the schema object or dispatching on `schema.type`.
 *
 * @module
 */

import type {
  StandardSchemaV1Issue,
  StandardSchemaV1PathSegment,
  StandardSchemaV1Result,
} from '../types.ts';
import type {
  ArrayOptions,
  FArray,
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

type SyncValidate<T> = (value: unknown) => StandardSchemaV1Result<T>;

function isOptional(
  entry: FSchema<unknown> | FOptionalWrapper<FSchema<unknown>>,
): entry is FOptionalWrapper<FSchema<unknown>> {
  return (entry as FOptionalWrapper<FSchema<unknown>>)['~optional'] === true;
}

function prependPath(
  segment: StandardSchemaV1PathSegment,
  issue: StandardSchemaV1Issue,
): StandardSchemaV1Issue {
  return {
    message: issue.message,
    path: issue.path ? [segment, ...issue.path] : [segment],
  };
}

/* @__NO_SIDE_EFFECTS__ */
export function object<T extends FProperties>(
  props: T,
  opts: ObjectOptions = {},
): FObject<T> {
  const required: string[] = [];
  const keys: string[] = [];
  const validators: Array<SyncValidate<unknown>> = [];
  const properties: Record<string, FSchema<unknown>> = {};

  for (const key in props) {
    const entry = props[key]!;
    if (isOptional(entry)) {
      const inner = entry['~wrapped'];
      properties[key] = inner;
      keys.push(key);
      validators.push(inner['~standard'].validate as SyncValidate<unknown>);
    }
    else {
      properties[key] = entry;
      required.push(key);
      keys.push(key);
      validators.push(entry['~standard'].validate as SyncValidate<unknown>);
    }
  }

  return {
    'type': 'object',
    properties,
    required,
    ...(opts.$id !== undefined && { $id: opts.$id }),
    '~standard': {
      version: 1,
      vendor: 'fetcher',
      validate(v): StandardSchemaV1Result<FObjectOutput<T>> {
        if (typeof v !== 'object' || v === null || Array.isArray(v))
          return { issues: [{ message: 'Expected object' }] };
        const obj = v as Record<string, unknown>;
        const issues: StandardSchemaV1Issue[] = [];
        for (let i = 0; i < required.length; i++) {
          const k = required[i]!;
          if (!(k in obj))
            issues.push({ message: 'Missing', path: [k] });
        }
        for (let i = 0; i < keys.length; i++) {
          const k = keys[i]!;
          if (k in obj) {
            const r = validators[i]!(obj[k]);
            if (r.issues) {
              for (let j = 0; j < r.issues.length; j++)
                issues.push(prependPath(k, r.issues[j]!));
            }
          }
        }
        return issues.length ? { issues } : { value: v as FObjectOutput<T> };
      },
    },
  } as FObject<T>;
}

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
          return { issues: [{ message: 'Expected array' }] };
        if (minItems !== undefined && v.length < minItems)
          return { issues: [{ message: 'Too short' }] };
        if (maxItems !== undefined && v.length > maxItems)
          return { issues: [{ message: 'Too long' }] };
        const issues: StandardSchemaV1Issue[] = [];
        for (let i = 0; i < v.length; i++) {
          const r = itemValidate(v[i]);
          if (r.issues) {
            for (let j = 0; j < r.issues.length; j++)
              issues.push(prependPath(i, r.issues[j]!));
          }
        }
        return issues.length ? { issues } : { value: v as Infer<T>[] };
      },
    },
  } as FArray<T>;
}

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
        return innerValidate(v) as StandardSchemaV1Result<Infer<T> | undefined>;
      },
    },
  } as FOptionalWrapper<T>;
}

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
        return innerValidate(v) as StandardSchemaV1Result<Infer<T> | null>;
      },
    },
  } as FUnion<[T, FNull]>;
}

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
        for (let i = 0; i < validators.length; i++) {
          const r = validators[i]!(v);
          if (!r.issues)
            return r as StandardSchemaV1Result<Infer<T[number]>>;
        }
        return { issues: [{ message: 'No variant matched' }] };
      },
    },
  } as FUnion<T>;
}

type Intersection<T extends readonly unknown[]>
  = T extends readonly [infer H, ...infer R]
    ? H & Intersection<R>
    : unknown;

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
        for (let i = 0; i < validators.length; i++) {
          const r = validators[i]!(v);
          if (r.issues) {
            for (let j = 0; j < r.issues.length; j++)
              issues.push(r.issues[j]!);
          }
        }
        return issues.length
          ? { issues }
          : { value: v as Intersection<{ [K in keyof T]: Infer<T[K]> }> };
      },
    },
  } as FIntersect<T>;
}

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
          return { issues: [{ message: 'Not in enum' }] };
        return { value: v as T };
      },
    },
  } as FEnum<T>;
}
