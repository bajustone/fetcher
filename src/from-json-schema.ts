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

/** String assertion keywords (apply only to string instances per 2020-12). */
const STRING_ASSERTIONS = ['minLength', 'maxLength', 'pattern'] as const;
/**
 * Numeric assertion keywords (apply only to number instances per 2020-12).
 * Deliberately matches {@link pickNumberOpts}' enforced subset —
 * `exclusiveMinimum`/`exclusiveMaximum`/`multipleOf` are unenforced
 * throughout this bridge (documented drift, flagged by `lintSpec`), so
 * sibling positions must not enforce more than inline positions do.
 */
const NUMBER_ASSERTIONS = ['minimum', 'maximum'] as const;
/** Array assertion keywords (apply only to array instances per 2020-12). */
const ARRAY_ASSERTIONS = ['minItems', 'maxItems'] as const;

/** A non-null, non-array object — the 2020-12 "object" instance type. */
function isObjectInstance(v: unknown): boolean {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Picks the subset of `keys` present on `n`, or null when none are. */
function pickPresent(n: RawSchema, keys: readonly string[]): RawSchema | null {
  const out: RawSchema = {};
  let any = false;
  for (const key of keys) {
    if (n[key] !== undefined) {
      out[key] = n[key];
      any = true;
    }
  }
  return any ? out : null;
}

/**
 * Wraps `inner` so it only runs when `applies(value)` — the 2020-12 rule
 * that assertion keywords constrain only instances of their own type
 * (`minLength` on a number passes vacuously). `meta` carries the raw
 * keywords so the gated schema still serializes faithfully.
 */
function gated(
  applies: (value: unknown) => boolean,
  inner: FSchema<unknown>,
  meta: RawSchema,
): FSchema<unknown> {
  return {
    ...meta,
    '~standard': {
      version: 1,
      vendor: 'fetcher',
      validate: (value: unknown) =>
        applies(value) ? inner['~standard'].validate(value) : { value },
    },
  } as FSchema<unknown>;
}

/**
 * Builds a validator for a typeless node that carries only assertion
 * keywords (the shape produced by `$ref` siblings like
 * `{ $ref: ..., minLength: 3 }`). Each keyword group is enforced through
 * the builder's own primitive — so code-point string lengths and the rest
 * of the builder semantics apply — but gated on the instance type per
 * 2020-12. Returns null when the node has no enforceable assertions.
 */
/**
 * Converts the keywords adjacent to a `$ref` into the sibling half of the
 * 2020-12 conjunction. Differs from the general {@link convert} path in one
 * deliberate way: with no explicit `type`, the object/array applicators
 * (`properties`/`required`, `items`+bounds) are TYPE-GATED — they constrain
 * only instances of their own type and pass vacuously otherwise. In sibling
 * position the instance type comes from the ref target (which may be a
 * union), so strict intent-typing here would make e.g.
 * `{ $ref: <string>, items: ... }` an unsatisfiable conjunction that
 * validates nothing. Standalone typeless schemas keep the strict OpenAPI
 * "properties/items imply type" idiom via {@link convert}.
 */
function convertSiblingConstraints(n: RawSchema): FSchema<unknown> {
  // An explicit `type`, enum/const, or composition keyword is either
  // explicitly typed or type-independent — the general converter is
  // already correct for those.
  if (
    n.type !== undefined
    || Array.isArray(n.oneOf)
    || Array.isArray(n.anyOf)
    || Array.isArray(n.allOf)
    || n.enum !== undefined
    || n.const !== undefined
  ) {
    return convert(n);
  }

  const gates: FSchema<unknown>[] = [];
  const rest: RawSchema = { ...n };

  if (n.properties) {
    const meta = pickPresent(n, ['properties', 'required', 'additionalProperties']) ?? {};
    gates.push(gated(isObjectInstance, convertObject(n), meta));
    delete rest.properties;
    delete rest.required;
    delete rest.additionalProperties;
  }
  if (n.items) {
    const meta = pickPresent(n, ['items', 'minItems', 'maxItems']) ?? {};
    gates.push(gated(Array.isArray, array(convert(n.items), pickArrayOpts(n)), meta));
    delete rest.items;
    delete rest.minItems;
    delete rest.maxItems;
  }

  // Scalar assertions, bare required, and bare array bounds not consumed
  // by the applicator gates above.
  const assertions = typelessAssertions(rest);
  if (assertions)
    gates.push(assertions);

  if (gates.length === 0)
    return unknown();
  if (gates.length === 1)
    return gates[0]!;
  return intersect(gates as [FSchema<unknown>, FSchema<unknown>, ...FSchema<unknown>[]]);
}

function typelessAssertions(n: RawSchema): FSchema<unknown> | null {
  const gates: FSchema<unknown>[] = [];
  const stringKeys = pickPresent(n, STRING_ASSERTIONS);
  if (stringKeys)
    gates.push(gated(v => typeof v === 'string', string(pickStringOpts(stringKeys)), stringKeys));
  const numberKeys = pickPresent(n, NUMBER_ASSERTIONS);
  if (numberKeys)
    gates.push(gated(v => typeof v === 'number', number(pickNumberOpts(numberKeys)), numberKeys));
  const arrayKeys = pickPresent(n, ARRAY_ASSERTIONS);
  if (arrayKeys)
    gates.push(gated(v => Array.isArray(v), array(unknown(), pickArrayOpts(arrayKeys)), arrayKeys));
  // `required` without `properties` (the `$ref`-sibling shape) is an
  // object-gated presence assertion: object instances must carry the keys,
  // every other instance type passes vacuously per 2020-12. The inner
  // validator is a presence-only object schema, so missing keys report the
  // builder's standard `missing` issues with correct paths.
  if (Array.isArray(n.required) && n.required.length > 0 && !n.properties) {
    const requiredOnly: RawSchema = { required: n.required };
    gates.push(gated(isObjectInstance, convertObject(requiredOnly), requiredOnly));
  }
  // `additionalProperties: false` without `properties` closes the object
  // COMPLETELY: per 2020-12 scoping, `additionalProperties` consults only
  // this schema object's own `properties`/`patternProperties` — never the
  // ref target's — so with none declared, every key is "additional" and
  // forbidden. (Authors wanting "the referenced object, closed" need
  // `unevaluatedProperties`, which stays unsupported and lint-flagged.)
  // Object-gated: non-object instances pass vacuously. The sub-schema and
  // `true` forms remain unenforced/no-op as elsewhere.
  if (n.additionalProperties === false && !n.properties) {
    const meta: RawSchema = { additionalProperties: false };
    gates.push(gated(isObjectInstance, object({} as FProperties, { unknownKeys: 'strict' }), meta));
  }
  if (gates.length === 0)
    return null;
  if (gates.length === 1)
    return gates[0]!;
  return intersect(gates as [FSchema<unknown>, FSchema<unknown>, ...FSchema<unknown>[]]);
}

/**
 * Keywords adjacent to `$ref` that {@link convert} can dispatch on. Used to
 * decide whether a `$ref` node with siblings needs the 2020-12 conjunction
 * treatment (`intersect`) — annotation-only siblings (`description`,
 * `title`, ...) convert to `unknown()` and are skipped. Bare assertion
 * keywords (`minLength`, `minimum`, `maxItems`, ...) ARE significant: they
 * convert to type-gated validators via {@link typelessAssertions}, so
 * `{ $ref: '#/$defs/Name', minLength: 3 }` actually enforces the length.
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
  'additionalProperties',
  ...STRING_ASSERTIONS,
  ...NUMBER_ASSERTIONS,
  ...ARRAY_ASSERTIONS,
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
      return intersect([target, convertSiblingConstraints(siblings)]);
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

  // `properties` implies object intent (the common OpenAPI "type omitted"
  // idiom) — treated as a real object schema, including any `required`.
  // Bare `required` WITHOUT `properties` falls through to the type-gated
  // assertion path below instead, so it passes vacuously on non-objects.
  if (n.properties)
    return convertObject(n);
  // Likewise `items` implies array intent — a real array schema, carrying
  // any adjacent minItems/maxItems bounds. Bare bounds WITHOUT `items`
  // fall through to the type-gated assertion path.
  if (n.items)
    return array(convert(n.items), pickArrayOpts(n));

  // Typeless node carrying only assertion keywords — the shape `$ref`
  // siblings take. Enforced with per-type gating per 2020-12.
  const assertions = typelessAssertions(n);
  if (assertions)
    return assertions;

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
  // 2020-12: `required` applies independently of `properties`. A required
  // key with no property schema (common as a `$ref` sibling —
  // `{ $ref: ..., required: ['name'] }`) is a presence-only constraint:
  // the key must exist, its value is unconstrained.
  for (const key of required) {
    if (!Object.hasOwn(props, key))
      props[key] = unknown();
  }
  // `additionalProperties: false` is a closed object — enforced via the
  // builder's strict policy (which also re-emits the keyword). The
  // sub-schema form remains unenforced (and is flagged by lintSpec);
  // `true`/absent is the default passthrough.
  return object(props as FProperties, n.additionalProperties === false ? { unknownKeys: 'strict' } : undefined);
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
