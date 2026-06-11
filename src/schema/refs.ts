/**
 * `$ref` support for the native schema builder.
 *
 * `ref(name)` returns a stable placeholder whose validator delegates to a
 * re-bindable target. `compile(schema, defs)` walks the schema tree and
 * binds each ref's target to the corresponding entry in `defs`, producing
 * a fully-resolved validator without copying the schema — existing
 * composites that captured the ref's `~standard.validate` at construction
 * keep the same function reference and observe the binding transparently.
 *
 * Cycle-safe: binding only stores the target's `validate`; resolution
 * happens per call, so self-referential schemas (e.g. `Tree →
 * array(ref('Tree'))`) terminate on input depth.
 *
 * @module
 */

import type { StandardSchemaV1Result } from '../types.ts';
import type { FRef, FSchema } from './types.ts';

type SyncValidate<T> = (value: unknown) => StandardSchemaV1Result<T>;

const binders = new WeakMap<object, (target: FSchema<unknown>) => void>();

/**
 * Creates a lazy `$ref` placeholder named `name`. Unresolved until bound by
 * {@link compile}; validating an unbound ref yields an `unresolved_ref`
 * issue. A `RangeError` raised by pathologically deep self-referential
 * input is caught at this boundary and converted into a
 * `max_depth_exceeded` issue, so `validate` returns instead of throwing on
 * hostile deeply-nested JSON.
 */
/* @__NO_SIDE_EFFECTS__ */
export function ref<T = unknown>(name: string): FRef<T> {
  let resolved: SyncValidate<T> | undefined;
  const schema: FRef<T> = {
    '$ref': `#/$defs/${name}`,
    '~standard': {
      version: 1,
      vendor: 'fetcher',
      validate(v): StandardSchemaV1Result<T> {
        if (!resolved)
          return { issues: [{ code: 'unresolved_ref', message: 'Unresolved $ref' }] };
        try {
          const r = resolved(v);
          if (r instanceof Promise)
            throw new TypeError('Schema validation must be synchronous');
          return r;
        }
        catch (err) {
          if (err instanceof RangeError)
            return { issues: [{ code: 'max_depth_exceeded', message: 'Maximum validation depth exceeded' }] };
          throw err;
        }
      },
    },
  } as FRef<T>;
  binders.set(schema, (target) => {
    resolved = target['~standard'].validate as SyncValidate<T>;
  });
  return schema;
}

/**
 * Walks `schema` and binds every {@link ref} placeholder to the matching
 * entry in `defs`, including refs nested inside def targets (multi-level
 * ref graphs), `record` values, `tuple` members, `intersect`/`union`
 * members, and refs wrapped by `refined`/`transform`/`default_`/`optional`/
 * `describe`/`title`. Cycle-safe via a visited set.
 *
 * Binding is **in place**: refs resolve through a closure, so compiling the
 * same schema graph (or any graph sharing ref instances) against a second
 * `defs` map re-binds those refs for every schema that shares them. A
 * `$ref` whose name is absent from `defs` is left unbound and surfaces as a
 * runtime `unresolved_ref` issue.
 */
export function compile<T extends FSchema<unknown>>(
  schema: T,
  defs: Record<string, FSchema<unknown>>,
): T {
  walk(schema as unknown as Record<string, unknown>, defs, new Set());
  return schema;
}

function walk(
  node: unknown,
  defs: Record<string, FSchema<unknown>>,
  visited: Set<object>,
): void {
  if (node === null || typeof node !== 'object')
    return;
  if (visited.has(node))
    return;
  visited.add(node);

  const n = node as Record<string, unknown>;

  if (typeof n.$ref === 'string') {
    const binder = binders.get(n);
    if (binder) {
      const name = n.$ref.startsWith('#/$defs/')
        ? n.$ref.slice('#/$defs/'.length)
        : n.$ref;
      const target = defs[name];
      if (target) {
        binder(target);
        // Recurse into the bound target so refs that are only reachable
        // through another ref (multi-level graphs) get bound too. The
        // visited set keeps this cycle-safe.
        walk(target, defs, visited);
      }
    }
  }

  if (n.properties && typeof n.properties === 'object') {
    const props = n.properties as Record<string, unknown>;
    for (const key of Object.keys(props))
      walk(props[key], defs, visited);
  }
  if (n.items)
    walk(n.items, defs, visited);
  // record() stores its value schema under additionalProperties.
  if (n.additionalProperties && typeof n.additionalProperties === 'object')
    walk(n.additionalProperties, defs, visited);
  // tuple() stores its members under prefixItems.
  if (Array.isArray(n.prefixItems)) {
    for (const child of n.prefixItems) walk(child, defs, visited);
  }
  if (Array.isArray(n.anyOf)) {
    for (const child of n.anyOf) walk(child, defs, visited);
  }
  if (Array.isArray(n.allOf)) {
    for (const child of n.allOf) walk(child, defs, visited);
  }
  if (Array.isArray(n.oneOf)) {
    for (const child of n.oneOf) walk(child, defs, visited);
  }
  if (n['~wrapped'])
    walk(n['~wrapped'], defs, visited);
  // refined/transform/default_/describe/title keep the schema they wrap
  // reachable here — a ref wrapped by one of them binds via the original
  // object (the binder registry is keyed by identity).
  if (n['~inner'])
    walk(n['~inner'], defs, visited);
}
