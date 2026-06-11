/**
 * Bridge from raw JSON Schema objects (OpenAPI spec fragments, pre-authored
 * schema JSON, etc.) to the builder's compiled validators. Dispatches each
 * keyword to the matching primitive in `./schema` and rebuilds the tree.
 *
 * Accepts an optional `defs` map (keyed by the last segment of `$ref`
 * strings, e.g. `Pet` for `#/components/schemas/Pet`). If omitted and the
 * input carries `$defs`, those are used automatically.
 *
 * @module
 */

import type {
  FOptionalWrapper,
  FProperties,
  FSchema,
} from './schema/index.ts';
import type { StandardSchemaV1 } from './types.ts';
import {
  array,
  boolean,
  compile,
  discriminatedUnion,
  enum_,
  integer,
  intersect,
  literal,
  null_,
  number,
  object,
  optional,
  ref,
  string,
  union,
  unknown,
} from './schema/index.ts';

type RawSchema = Record<string, unknown>;

/**
 * Root-level marker (an `x-` vendor extension, legal on any JSON Schema
 * node) emitted by the OpenAPI extractor on request-body schemas whose
 * `requestBody.required` is not `true`. {@link fromJSONSchema} strips the
 * marker and wraps the compiled validator so that `undefined` validates
 * successfully — `createFetch` validates the body whenever a route declares
 * a `body` schema, including when the caller omitted it, so optional-body
 * routes must accept absence.
 */
export const FETCHER_OPTIONAL_MARKER = 'x-fetcher-optional' as const;

/**
 * Root-level marker emitted by the OpenAPI extractor on params/query
 * object schemas. Its value is the list of top-level property names whose
 * values should be coerced from numeric strings to numbers before
 * validation (path/query parameters arrive as strings on the wire, while
 * the spec may declare them `integer`/`number`). {@link fromJSONSchema}
 * strips the marker and wraps the compiled validator with the coercion.
 * Never emitted on body schemas — bodies are not coerced.
 */
export const FETCHER_COERCE_MARKER = 'x-fetcher-coerce' as const;

function refName(refPath: string): string {
  const idx = refPath.lastIndexOf('/');
  return idx >= 0 ? refPath.slice(idx + 1) : refPath;
}

function pickStringOpts(n: RawSchema): { minLength?: number; maxLength?: number; pattern?: string } {
  const out: { minLength?: number; maxLength?: number; pattern?: string } = {};
  if (typeof n.minLength === 'number')
    out.minLength = n.minLength;
  if (typeof n.maxLength === 'number')
    out.maxLength = n.maxLength;
  if (typeof n.pattern === 'string')
    out.pattern = n.pattern;
  return out;
}

function pickNumberOpts(n: RawSchema): { minimum?: number; maximum?: number } {
  const out: { minimum?: number; maximum?: number } = {};
  if (typeof n.minimum === 'number')
    out.minimum = n.minimum;
  if (typeof n.maximum === 'number')
    out.maximum = n.maximum;
  return out;
}

function pickArrayOpts(n: RawSchema): { minItems?: number; maxItems?: number } {
  const out: { minItems?: number; maxItems?: number } = {};
  if (typeof n.minItems === 'number')
    out.minItems = n.minItems;
  if (typeof n.maxItems === 'number')
    out.maxItems = n.maxItems;
  return out;
}

/**
 * Keywords adjacent to `$ref` that {@link convert} can dispatch on. Used to
 * decide whether a `$ref` node with siblings needs the 2020-12 conjunction
 * treatment (`intersect`) — annotation-only siblings (`description`,
 * `title`, ...) convert to `unknown()` and are skipped.
 */
const SIGNIFICANT_REF_SIBLINGS = [
  'oneOf',
  'anyOf',
  'allOf',
  'enum',
  'const',
  'type',
  'properties',
  'required',
  'items',
] as const;

function convert(raw: unknown): FSchema<unknown> {
  if (raw === null || typeof raw !== 'object')
    return unknown();
  const n = raw as RawSchema;

  if (typeof n.$ref === 'string') {
    const target = ref(refName(n.$ref));
    // JSON Schema 2020-12 (and OpenAPI 3.1) allow keywords adjacent to
    // `$ref`; each applies independently — a conjunction. Mirror `inline()`
    // by validating the ref target AND the sibling constraints.
    if (SIGNIFICANT_REF_SIBLINGS.some(key => n[key] !== undefined)) {
      const { $ref: _refPath, ...siblings } = n;
      return intersect([target, convert(siblings)]);
    }
    return target;
  }

  if (Array.isArray(n.oneOf)) {
    const variants = n.oneOf as RawSchema[];
    const discriminator = n.discriminator as { propertyName?: string } | undefined;
    if (discriminator?.propertyName) {
      const mapping: Record<string, FSchema<unknown>> = {};
      for (const variant of variants) {
        const tagValue = readDiscriminatorConst(variant, discriminator.propertyName);
        if (tagValue !== undefined)
          mapping[tagValue] = convert(variant);
      }
      if (Object.keys(mapping).length === variants.length)
        return discriminatedUnion(discriminator.propertyName, mapping);
    }
    if (variants.length === 0)
      return unknown();
    return union(variants.map(convert) as [FSchema<unknown>, ...FSchema<unknown>[]]);
  }

  if (Array.isArray(n.anyOf)) {
    const variants = n.anyOf as unknown[];
    if (variants.length === 0)
      return unknown();
    return union(variants.map(convert) as [FSchema<unknown>, ...FSchema<unknown>[]]);
  }

  if (Array.isArray(n.allOf)) {
    const variants = n.allOf as unknown[];
    if (variants.length === 0)
      return unknown();
    return intersect(variants.map(convert) as [FSchema<unknown>, ...FSchema<unknown>[]]);
  }

  if (Array.isArray(n.enum))
    return enum_(n.enum as (string | number | boolean)[]);

  if (n.const !== undefined && (typeof n.const === 'string' || typeof n.const === 'number' || typeof n.const === 'boolean'))
    return literal(n.const);

  const typeField = n.type;

  // 3.1 multi-type arrays (`type: ['string', 'integer']`, `['string',
  // 'null']`, ...) — a union over every member, matching the type layer's
  // `TypeNameToTS` distribution so `result.data`/`body` types and runtime
  // validation agree. Each member converts against the full node, so
  // per-member keywords (`minLength`, `minimum`, `items`, `properties`,
  // ...) still apply to the member they belong to.
  if (Array.isArray(typeField)) {
    const members = [...new Set(typeField)];
    if (members.length === 1)
      return convert({ ...n, type: members[0] });
    if (members.length > 1) {
      const variants = members.map(t => convert({ ...n, type: t }));
      return union(variants as [FSchema<unknown>, ...FSchema<unknown>[]]);
    }
    return unknown();
  }

  if (n.nullable === true) {
    const inner = convert({ ...n, nullable: undefined });
    return union([inner, null_()]);
  }

  switch (typeField) {
    case 'string': return string(pickStringOpts(n));
    case 'number': return number(pickNumberOpts(n));
    case 'integer': return integer(pickNumberOpts(n));
    case 'boolean': return boolean();
    case 'null': return null_();
    case 'array':
      return array(n.items ? convert(n.items) : unknown(), pickArrayOpts(n));
    case 'object':
      return convertObject(n);
  }

  if (n.properties || Array.isArray(n.required))
    return convertObject(n);
  if (n.items)
    return array(convert(n.items));

  return unknown();
}

function readDiscriminatorConst(variant: RawSchema, propName: string): string | undefined {
  const props = variant.properties as Record<string, RawSchema> | undefined;
  if (!props)
    return undefined;
  const prop = props[propName];
  if (!prop)
    return undefined;
  if (typeof prop.const === 'string')
    return prop.const;
  if (Array.isArray(prop.enum) && prop.enum.length === 1 && typeof prop.enum[0] === 'string')
    return prop.enum[0];
  return undefined;
}

function convertObject(n: RawSchema): FSchema<unknown> {
  const rawProps = (n.properties ?? {}) as Record<string, unknown>;
  const required = Array.isArray(n.required) ? new Set(n.required as string[]) : new Set<string>();
  // Null-prototype accumulator: a spec-controlled property key literally
  // named '__proto__' must become an ordinary own entry instead of
  // triggering the object-literal prototype setter (which would silently
  // drop the property and corrupt the carrier).
  const props: Record<string, FSchema<unknown> | FOptionalWrapper<FSchema<unknown>>>
    = Object.create(null) as Record<string, FSchema<unknown> | FOptionalWrapper<FSchema<unknown>>>;
  for (const key of Object.keys(rawProps)) {
    const sub = convert(rawProps[key]);
    props[key] = required.has(key) ? sub : optional(sub);
  }
  return object(props as FProperties);
}

/** Strict decimal/scientific numeric-string shape eligible for coercion. */
const NUMERIC_STRING = /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i;

/**
 * Coerces a numeric string to a number; maps over arrays (repeated query
 * keys). Non-matching values pass through untouched so the schema's own
 * error reporting stays intact.
 *
 * Coercion is **lossless-only**: the parsed number must serialize back to
 * the exact input string (`String(n) === value`), and integral values must
 * additionally be safe integers. Anything else — int64-scale IDs beyond
 * 2^53 (snowflakes), exponent forms (`'1e3'`), leading zeros (`'00742'`),
 * values that collapse to scientific notation — passes through as the
 * original string so the schema rejects it loudly instead of silently
 * sending a corrupted value on the wire.
 */
function coerceNumeric(value: unknown): unknown {
  if (typeof value === 'string' && NUMERIC_STRING.test(value)) {
    const n = Number(value);
    if (String(n) === value && (!Number.isInteger(n) || Number.isSafeInteger(n)))
      return n;
    return value;
  }
  if (Array.isArray(value))
    return value.map(coerceNumeric);
  return value;
}

/**
 * Wraps a validator so the named top-level properties are numeric-string
 * coerced before validation. The input object is never mutated — a
 * null-prototype copy is validated instead when any coercion applies.
 */
function withNumericCoercion<T>(
  inner: StandardSchemaV1<unknown, T>,
  propNames: readonly string[],
): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'fetcher',
      validate: (value) => {
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          let copy: Record<string, unknown> | undefined;
          const obj = value as Record<string, unknown>;
          for (const name of propNames) {
            if (!Object.hasOwn(obj, name))
              continue;
            const coerced = coerceNumeric(obj[name]);
            if (coerced !== obj[name]) {
              copy ??= Object.assign(Object.create(null) as Record<string, unknown>, obj);
              copy[name] = coerced;
            }
          }
          if (copy)
            return inner['~standard'].validate(copy);
        }
        return inner['~standard'].validate(value);
      },
    },
  };
}

/**
 * Wraps a validator so `undefined` validates successfully (to `undefined`).
 * Used for optional request bodies — `createFetch` runs the body validator
 * even when the caller omitted the body.
 */
function withOptionalUndefined<T>(
  inner: StandardSchemaV1<unknown, T>,
): StandardSchemaV1<unknown, T | undefined> {
  return {
    '~standard': {
      version: 1,
      vendor: 'fetcher',
      validate: (value) => {
        if (value === undefined)
          return { value: undefined };
        return inner['~standard'].validate(value);
      },
    },
  };
}

/**
 * Converts a raw JSON Schema object (and optional `$defs`/component map) into
 * a compiled {@link FSchema} ready for validation. Returned object is a
 * plain Standard Schema V1 validator — drop it into any `RouteDefinition`
 * slot or call `~standard.validate(data)` directly.
 *
 * Honors two root-level vendor-extension markers emitted by the OpenAPI
 * extractor (and stripped before conversion):
 *
 * - {@link FETCHER_OPTIONAL_MARKER} (`x-fetcher-optional: true`) — the
 *   compiled validator additionally accepts `undefined` (optional request
 *   bodies).
 * - {@link FETCHER_COERCE_MARKER} (`x-fetcher-coerce: string[]`) — the
 *   named top-level properties are numeric-string coerced before
 *   validation (integer/number path & query parameters).
 */
export function fromJSONSchema<T = unknown>(
  schema: object,
  defs?: Record<string, object>,
): StandardSchemaV1<unknown, T> {
  const node = schema as RawSchema;
  const optionalRoot = node[FETCHER_OPTIONAL_MARKER] === true;
  const coerceList = Array.isArray(node[FETCHER_COERCE_MARKER])
    ? (node[FETCHER_COERCE_MARKER] as unknown[]).filter((n): n is string => typeof n === 'string')
    : null;

  let working = node;
  if (optionalRoot || coerceList) {
    working = { ...node };
    delete working[FETCHER_OPTIONAL_MARKER];
    delete working[FETCHER_COERCE_MARKER];
  }

  const rawDefs = (defs ?? working.$defs) as Record<string, object> | undefined;
  const root = convert(working);

  if (rawDefs && typeof rawDefs === 'object') {
    // Null-prototype map: component names are spec-controlled, and a
    // component literally named '__proto__' must round-trip as an own key.
    const defsMap: Record<string, FSchema<unknown>> = Object.create(null) as Record<string, FSchema<unknown>>;
    for (const name of Object.keys(rawDefs)) defsMap[name] = convert(rawDefs[name]);
    for (const name of Object.keys(defsMap)) compile(defsMap[name]!, defsMap);
    compile(root, defsMap);
  }

  let result: StandardSchemaV1<unknown, T> = root as StandardSchemaV1<unknown, T>;
  if (coerceList && coerceList.length > 0)
    result = withNumericCoercion(result, coerceList);
  if (optionalRoot)
    result = withOptionalUndefined(result) as StandardSchemaV1<unknown, T>;
  return result;
}
