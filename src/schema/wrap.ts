/**
 * Internal wrapper protocol shared by `refined`, `transform`, and `default_`.
 *
 * Wrappers used to be built with a bare `...schema` spread. That leaked the
 * `~optional`/`~wrapped` markers of an inner `optional()` wrapper onto the
 * outer wrapper, which made `object()` dispatch on the markers and compile
 * its property validator from the *inner* schema — silently discarding the
 * outer refinement/transform. It also produced copies of `ref()` schemas
 * that `compile()` could no longer bind (the binder registry is keyed by
 * object identity).
 *
 * The explicit protocol implemented here:
 *
 * - {@link schemaMeta} — the marker-free JSON Schema view of the inner
 *   schema (resolving through `optional()` wrappers, which carry no JSON
 *   metadata of their own), used so the wrapper still *emits* the wire shape.
 * - {@link wrapperBase} — `schemaMeta` plus deliberate marker propagation:
 *   an inner `~optional`/`~default` marker is re-asserted on the wrapper so
 *   `object()` keeps BOTH behaviors (key optionality / default substitution
 *   AND the wrapper's composed validator), and `~inner` keeps the original
 *   schema reachable for `compile()`'s ref walker.
 *
 * Everything in this module is internal — none of it is exported from the
 * subpath index.
 *
 * @module
 */

import type { FSchema } from './types.ts';

type AnyRecord = Record<string, unknown>;

/**
 * Returns the schema whose JSON Schema metadata should be emitted for
 * `schema`: `optional()` and `default_()` wrappers expose their wrapped
 * schema via `~wrapped`; everything else is its own emission target.
 */
export function emissionTarget(schema: FSchema<unknown>): FSchema<unknown> {
  const wrapped = (schema as unknown as AnyRecord)['~wrapped'];
  return (wrapped as FSchema<unknown> | undefined) ?? schema;
}

/**
 * Marker-free JSON Schema metadata view of `schema`. Resolves through
 * `optional()` wrappers (which carry no metadata themselves) and drops every
 * internal `~`-prefixed key, including `~standard`.
 */
export function schemaMeta(schema: FSchema<unknown>): AnyRecord {
  let source = schema as unknown as AnyRecord;
  while (source['~optional'] === true && source['~wrapped'] !== undefined)
    source = source['~wrapped'] as AnyRecord;
  const out: AnyRecord = {};
  for (const key of Object.keys(source)) {
    // Schema metadata keys are spec keywords ('type', 'properties', …);
    // '~'-prefixed keys are internal and '__proto__' cannot be a keyword.
    if (key.charCodeAt(0) !== 126 /* '~' */ && key !== '__proto__')
      out[key] = source[key];
  }
  return out;
}

/**
 * Spreadable base for a `refined`/`transform` wrapper over `schema`:
 * emission metadata, propagated optionality/default markers (so `object()`
 * keeps both the wrapper's validator and the key's optional/default
 * treatment), and the `~inner` link that lets `compile()`'s walker reach
 * refs wrapped by the new object.
 */
export function wrapperBase(schema: FSchema<unknown>): AnyRecord {
  const s = schema as unknown as AnyRecord;
  const out = schemaMeta(schema);
  if (s['~optional'] === true)
    out['~optional'] = true;
  if (s['~default'] === true) {
    out['~default'] = true;
    if (Object.hasOwn(s, '~fallback'))
      out['~fallback'] = s['~fallback'];
  }
  if (s['~optional'] === true || s['~default'] === true)
    out['~wrapped'] = emissionTarget(schema);
  out['~inner'] = schema;
  return out;
}
