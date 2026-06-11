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

import type { JSONSchemaDefinition } from './json-schema-types.ts';

const DEFS_REF_PREFIX = '#/$defs/';
const ARRAY_INDEX_RE = /^(?:0|[1-9]\d*)$/;

/** Options for {@link inline}. */
export interface InlineOptions {
  /**
   * How to handle a `$ref` that cannot be resolved against the schema's own
   * `$defs` — either a pointer that does not start with `#/$defs/` (e.g.
   * `#/definitions/X` from older drafts, or an external URL), or a
   * `#/$defs/…` pointer whose target is missing. Deep pointers into a
   * definition (`#/$defs/Pet/properties/name`, legal RFC 6901) are resolved
   * by walking the remaining segments, and only count as unresolvable when
   * the walked path does not exist.
   *
   * - `'throw'` (default): throw an {@link InlineUnresolvedRefError} naming
   *   the offending ref and its location, so a schema that is *not* actually
   *   self-contained never escapes silently — downstream consumers
   *   (schemasafe, `z.fromJSONSchema`, …) would otherwise fail later with no
   *   hint of the cause.
   * - `'keep'`: leave the `$ref` node in the output untouched. The result is
   *   then NOT guaranteed ref-free; use only when a downstream consumer can
   *   resolve the remaining refs itself.
   */
  onUnresolved?: 'throw' | 'keep';
}

/**
 * Error thrown by {@link inline} when the schema contains a cyclic `$ref`
 * chain. Recursive JSON Schemas cannot be fully inlined — the result would
 * be infinite.
 */
export class InlineCycleError extends Error {
  /** The `$ref` string at which the cycle was detected, e.g. `'#/$defs/Tree'`. */
  readonly ref: string;

  /** Builds the error from the `$ref` string at which the cycle was detected. */
  constructor(ref: string) {
    const name = ref.slice(DEFS_REF_PREFIX.length);
    super(
      `Cannot inline cyclic schema at '${ref}'. `
      + `Recursive JSON Schemas cannot be fully inlined. `
      + `Use a ref-aware consumer (AJV, TypeBox), or — for fetcher's own `
      + `schemas — the \`validators.${name}\` export.`,
    );
    this.name = 'InlineCycleError';
    this.ref = ref;
  }
}

/**
 * Error thrown by {@link inline} (under the default
 * `onUnresolved: 'throw'`) when a `$ref` cannot be resolved against the
 * schema's own `$defs`. Carries both the offending ref and the JSON Pointer
 * of the node that holds it.
 */
export class InlineUnresolvedRefError extends Error {
  /** The unresolvable `$ref` string, e.g. `'#/definitions/A'`. */
  readonly ref: string;
  /** RFC 6901 JSON Pointer to the node holding the `$ref`, rooted at the input schema. */
  readonly pointer: string;

  /**
   * Builds the error from the offending ref, its location, and the reason.
   *
   * @param ref The unresolvable `$ref` string.
   * @param pointer JSON Pointer to the node holding the `$ref`.
   * @param reason Why the ref could not be resolved.
   */
  constructor(ref: string, pointer: string, reason: string) {
    super(
      `Cannot inline: unresolvable $ref '${ref}' at '${pointer}' — ${reason} `
      + `Pass { onUnresolved: 'keep' } to leave unresolvable refs in place.`,
    );
    this.name = 'InlineUnresolvedRefError';
    this.ref = ref;
    this.pointer = pointer;
  }
}

// Memoized per onUnresolved mode: the two modes can produce different
// outputs for the same input, so they must not share cache entries.
const caches: Record<'throw' | 'keep', WeakMap<JSONSchemaDefinition, JSONSchemaDefinition>> = {
  throw: new WeakMap(),
  keep: new WeakMap(),
};

/**
 * Fully dereferences a JSON Schema by substituting every `#/$defs/…` ref
 * with its resolved target — whole definitions (`#/$defs/X`) and deep RFC
 * 6901 pointers into one (`#/$defs/X/properties/y`) alike. Returns a frozen,
 * self-contained schema with no remaining refs (and the top-level `$defs`
 * stripped).
 *
 * **Sibling keywords:** when a node carries keywords next to `$ref` (legal
 * in JSON Schema 2020-12 and OpenAPI 3.1, e.g.
 * `{ $ref: '#/$defs/Pet', description: '…', minProperties: 1 }`), the
 * siblings are shallow-merged over the resolved target — sibling values win
 * on key collisions. Note this is an approximation of strict 2020-12
 * semantics, where `$ref` and adjacent keywords each apply independently
 * (conjunction); for the common cases — annotation overlays and *additional*
 * constraints — the merge is equivalent, but a sibling keyword that also
 * exists on the target replaces it rather than combining with it. A boolean
 * target follows conjunction exactly: siblings on a `true` target stand
 * alone (`true` imposes nothing); a `false` target stays `false`.
 *
 * **Unresolvable refs:** any `$ref` that is not a resolvable `#/$defs/X`
 * pointer throws an {@link InlineUnresolvedRefError} by default, so the
 * "no remaining refs" guarantee actually holds. Pass
 * `{ onUnresolved: 'keep' }` to leave such refs in the output instead.
 *
 * Memoized by input identity (per `onUnresolved` mode) via a module-level
 * `WeakMap`. Calling `inline(s)` twice with the same input returns the same
 * frozen output object — critical for argument-identity caches like
 * sveltekit-superforms' `schemasafe` adapter.
 *
 * @param schema The JSON Schema to dereference.
 * @param options See {@link InlineOptions}.
 * @throws {InlineCycleError} when the schema contains a cyclic `$ref`.
 * Recursive JSON Schemas cannot be fully inlined (the result would be
 * infinite); use a ref-aware consumer (AJV, TypeBox) instead, or — for
 * fetcher's own schemas — the `validators.X` export which resolves refs at
 * validation time.
 * @throws {InlineUnresolvedRefError} when a `$ref` cannot be resolved and
 * `onUnresolved` is `'throw'` (the default).
 *
 * @example
 * ```ts
 * import { inline } from '@bajustone/fetcher/openapi';
 *
 * const flat = inline(someExternalSchemaWithRefs);
 * // flat has no $ref anywhere; drop-in for schemasafe / z.fromJSONSchema / etc.
 * ```
 */
export function inline<T extends JSONSchemaDefinition>(schema: T, options?: InlineOptions): T {
  const mode = options?.onUnresolved ?? 'throw';
  const cache = caches[mode];
  const cached = cache.get(schema);
  if (cached)
    return cached as T;

  const defs = schema.$defs ?? {};
  const result = substituteRefs(schema, defs, new Set<string>(), mode, '#') as T;
  const frozen = deepFreeze(result);
  cache.set(schema, frozen as JSONSchemaDefinition);
  return frozen;
}

/** RFC 6901 escape: `~` → `~0`, `/` → `~1`. */
function escapePointer(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** RFC 6901 unescape: `~1` → `/`, then `~0` → `~` (in that order). */
function unescapePointer(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

/**
 * Resolves the post-`#/$defs/` part of a deep ref (e.g.
 * `Pet/properties/name`) by walking its RFC 6901 segments, starting at the
 * defs map. Returns `undefined` when any segment is missing. The walk is
 * purely structural — it does not resolve through `$ref` nodes it passes —
 * matching RFC 6901 evaluation semantics.
 */
function resolveDeepPointer(
  defs: Record<string, JSONSchemaDefinition>,
  path: string,
): unknown {
  let node: unknown = defs;
  for (const segment of path.split('/').map(unescapePointer)) {
    if (node === null || typeof node !== 'object')
      return undefined;
    if (Array.isArray(node)) {
      if (!ARRAY_INDEX_RE.test(segment))
        return undefined;
      node = node[Number(segment)];
    }
    else {
      // Own keys only — `node['__proto__']` on a node without that own key
      // would walk into the prototype object instead of failing.
      if (!Object.hasOwn(node, segment))
        return undefined;
      node = (node as Record<string, unknown>)[segment];
    }
  }
  return node;
}

function substituteRefs(
  node: unknown,
  defs: Record<string, JSONSchemaDefinition>,
  visiting: Set<string>,
  mode: 'throw' | 'keep',
  pointer: string,
): unknown {
  if (node === null || typeof node !== 'object')
    return node;
  if (Array.isArray(node))
    return node.map((item, i) => substituteRefs(item, defs, visiting, mode, `${pointer}/${i}`));

  const n = node as Record<string, unknown>;

  // $ref → resolve, then merge any sibling keywords over the target.
  if (typeof n.$ref === 'string') {
    const ref = n.$ref;
    const resolvable = ref.startsWith(DEFS_REF_PREFIX);
    const name = resolvable ? ref.slice(DEFS_REF_PREFIX.length) : '';
    // A whole-def ref (`#/$defs/X`) looks the key up directly; anything else
    // is treated as a deep RFC 6901 pointer into a definition
    // (`#/$defs/X/properties/y`) and resolved by walking its segments.
    // Without the deep walk, 'keep' mode would preserve such a ref while
    // copyNode strips the `$defs` it points into — corrupting an input that
    // was fully resolvable. (`Object.hasOwn`, so an inherited key like
    // 'constructor' can never masquerade as a definition.)
    const isWholeDef = resolvable && Object.hasOwn(defs, name);
    const target = !resolvable
      ? undefined
      : isWholeDef ? defs[name] : resolveDeepPointer(defs, name);

    // `=== undefined` (not falsiness): `false` is a valid boolean schema
    // (2020-12) and must resolve, not throw.
    if (!resolvable || target === undefined) {
      if (mode === 'keep') {
        // Preserve the node as-is (still walking its other values, so
        // resolvable refs nested in siblings are substituted).
        return copyNode(n, defs, visiting, mode, pointer, /* keepRef */ true);
      }
      const reason = resolvable
        ? `'${name}' not found in $defs.`
        : `only local '${DEFS_REF_PREFIX}*' refs are supported.`;
      throw new InlineUnresolvedRefError(ref, pointer, reason);
    }

    if (visiting.has(name))
      throw new InlineCycleError(ref);

    visiting.add(name);
    let resolved: unknown;
    try {
      // Rebase the pointer to the definition's own location, so an
      // unresolvable ref nested inside it is reported at a pointer that
      // actually exists in the input document (`#/$defs/X/…`), not at a
      // synthetic ref-site path. A deep pointer's path (`name`) is already
      // RFC 6901-escaped as written in the ref; a whole-def key is a raw
      // token and needs escaping.
      const base = DEFS_REF_PREFIX + (isWholeDef ? escapePointer(name) : name);
      resolved = substituteRefs(target, defs, visiting, mode, base);
    }
    finally {
      visiting.delete(name);
    }

    // 2020-12 allows keywords adjacent to $ref; merge them over the target
    // (siblings win — see the contract note on `inline`).
    const siblings = copyNode(n, defs, visiting, mode, pointer, /* keepRef */ false);
    if (Object.keys(siblings).length === 0)
      return resolved;
    if (resolved !== null && typeof resolved === 'object' && !Array.isArray(resolved))
      return { ...(resolved as Record<string, unknown>), ...siblings };
    // Boolean-schema target — 2020-12 conjunction: `true` imposes nothing,
    // so the siblings alone are the result; `false` rejects everything
    // regardless of siblings, so dropping them loses nothing.
    return resolved === true ? siblings : resolved;
  }

  return copyNode(n, defs, visiting, mode, pointer, /* keepRef */ true);
}

/**
 * Copies a node's entries with refs substituted, stripping `$defs` — every
 * resolvable ref (whole-def or deep pointer) has been substituted by the
 * walk, so the definitions are no longer needed; a ref kept in `'keep'` mode
 * points at a path that does not exist in `$defs` anyway. When `keepRef` is
 * false, `$ref` is stripped too (used to collect the sibling keywords of a
 * `$ref` node).
 */
function copyNode(
  n: Record<string, unknown>,
  defs: Record<string, JSONSchemaDefinition>,
  visiting: Set<string>,
  mode: 'throw' | 'keep',
  pointer: string,
  keepRef: boolean,
): Record<string, unknown> {
  // Null prototype: with a plain `{}`, assigning a key literally named
  // '__proto__' would trigger Object.prototype's setter and silently clobber
  // the prototype instead of defining an own property — a schema property
  // named __proto__ would vanish from the output (validation bypass).
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(n)) {
    if (key === '$defs')
      continue;
    if (key === '$ref') {
      if (keepRef)
        out[key] = value;
      continue;
    }
    out[key] = substituteRefs(value, defs, visiting, mode, `${pointer}/${escapePointer(key)}`);
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
