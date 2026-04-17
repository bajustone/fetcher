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
        return resolved(v);
      },
    },
  } as FRef<T>;
  binders.set(schema, (target) => {
    resolved = target['~standard'].validate as SyncValidate<T>;
  });
  return schema;
}

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
      if (target)
        binder(target);
    }
  }

  if (n.properties && typeof n.properties === 'object') {
    for (const key in n.properties as Record<string, unknown>)
      walk((n.properties as Record<string, unknown>)[key], defs, visited);
  }
  if (n.items)
    walk(n.items, defs, visited);
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
}
