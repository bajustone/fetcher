/**
 * Runtime helper to fully dereference a JSON Schema by substituting every
 * local `$ref` (against the schema's own `$defs`) with its resolved target.
 *
 * For fetcher's own component schemas, prefer
 * `import { schemas } from 'virtual:fetcher/inlined'` — those are pre-inlined
 * at build time, which avoids the runtime walk and guarantees stable object
 * identity. This helper exists for inlining *external* JSON Schemas (from
 * other sources) or as a fallback when the build-time path is not available.
 *
 * @module
 */

import type { JSONSchemaDefinition } from './json-schema-validator.ts';

const DEFS_REF_PREFIX = '#/$defs/';

const cache = new WeakMap<JSONSchemaDefinition, JSONSchemaDefinition>();

/**
 * Fully dereferences a JSON Schema by substituting every `#/$defs/X` ref with
 * its resolved target. Returns a frozen, self-contained schema with no
 * remaining refs (and the top-level `$defs` stripped).
 *
 * Memoized by input identity via a module-level `WeakMap`. Calling
 * `inline(s)` twice with the same input returns the same frozen output
 * object — critical for argument-identity caches like sveltekit-superforms'
 * `schemasafe` adapter.
 *
 * @throws when the schema contains a cyclic `$ref`. Recursive JSON Schemas
 * cannot be fully inlined (the result would be infinite); use a ref-aware
 * consumer (AJV, TypeBox) instead, or — for fetcher's own schemas — the
 * `validators.X` export which resolves refs at validation time.
 *
 * @example
 * ```ts
 * import { inline } from '@bajustone/fetcher';
 *
 * const flat = inline(someExternalSchemaWithRefs);
 * // flat has no $ref anywhere; drop-in for schemasafe / z.fromJSONSchema / etc.
 * ```
 */
export function inline<T extends JSONSchemaDefinition>(schema: T): T {
  const cached = cache.get(schema);
  if (cached)
    return cached as T;

  const defs = schema.$defs ?? {};
  const result = substituteRefs(schema, defs, new Set<string>()) as T;
  const frozen = deepFreeze(result);
  cache.set(schema, frozen as JSONSchemaDefinition);
  return frozen;
}

function substituteRefs(
  node: unknown,
  defs: Record<string, JSONSchemaDefinition>,
  visiting: Set<string>,
): unknown {
  if (node === null || typeof node !== 'object')
    return node;
  if (Array.isArray(node))
    return node.map(item => substituteRefs(item, defs, visiting));

  const n = node as Record<string, unknown>;

  // $ref → resolve
  if (typeof n.$ref === 'string' && n.$ref.startsWith(DEFS_REF_PREFIX)) {
    const name = n.$ref.slice(DEFS_REF_PREFIX.length);
    if (visiting.has(name)) {
      throw new Error(
        `Cannot inline cyclic schema at '${n.$ref}'. `
        + `Recursive JSON Schemas cannot be fully inlined. `
        + `Use a ref-aware consumer (AJV, TypeBox), or — for fetcher's own `
        + `schemas — the \`validators.${name}\` export.`,
      );
    }
    const target = defs[name];
    if (!target) {
      throw new Error(
        `Cannot resolve '${n.$ref}': '${name}' not found in $defs.`,
      );
    }
    visiting.add(name);
    try {
      return substituteRefs(target, defs, visiting);
    }
    finally {
      visiting.delete(name);
    }
  }

  // Recurse, stripping $defs (fully inlined, no longer needed)
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(n)) {
    if (key === '$defs')
      continue;
    out[key] = substituteRefs(value, defs, visiting);
  }
  return out;
}

function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object')
    return obj;
  for (const value of Object.values(obj)) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value))
      deepFreeze(value);
  }
  return Object.freeze(obj);
}
