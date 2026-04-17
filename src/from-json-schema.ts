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

function convert(raw: unknown): FSchema<unknown> {
  if (raw === null || typeof raw !== 'object')
    return unknown();
  const n = raw as RawSchema;

  if (typeof n.$ref === 'string')
    return ref(refName(n.$ref));

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
  const typeList = Array.isArray(typeField) ? typeField : [typeField];

  if (typeList.includes('null') && typeList.length > 1) {
    const nonNull = typeList.filter(t => t !== 'null');
    if (nonNull.length === 1) {
      const inner = convert({ ...n, type: nonNull[0] });
      return union([inner, null_()]);
    }
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
  const props: Record<string, FSchema<unknown> | FOptionalWrapper<FSchema<unknown>>> = {};
  for (const key in rawProps) {
    const sub = convert(rawProps[key]);
    props[key] = required.has(key) ? sub : optional(sub);
  }
  return object(props as FProperties);
}

/**
 * Converts a raw JSON Schema object (and optional `$defs`/component map) into
 * a compiled {@link FSchema} ready for validation. Returned object is a
 * plain Standard Schema V1 validator — drop it into any `RouteDefinition`
 * slot or call `~standard.validate(data)` directly.
 */
export function fromJSONSchema<T = unknown>(
  schema: object,
  defs?: Record<string, object>,
): StandardSchemaV1<unknown, T> {
  const rawDefs = (defs ?? (schema as RawSchema).$defs) as Record<string, object> | undefined;
  const root = convert(schema);

  if (rawDefs && typeof rawDefs === 'object') {
    const defsMap: Record<string, FSchema<unknown>> = {};
    for (const name in rawDefs) defsMap[name] = convert(rawDefs[name]);
    for (const name in defsMap) compile(defsMap[name]!, defsMap);
    compile(root, defsMap);
  }

  return root as StandardSchemaV1<unknown, T>;
}
