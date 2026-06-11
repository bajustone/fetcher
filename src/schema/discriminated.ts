/**
 * Discriminated-union factory. Unlike {@link union}, dispatch is O(1) via a
 * keyed map rather than sequential trial-validation.
 *
 * @module
 */

import type { StandardSchemaV1Result } from '../types.ts';
import type { FDiscriminatedUnion, FSchema, Infer } from './types.ts';
import { ensureSync } from './container.ts';

type SyncValidate<T> = (value: unknown) => StandardSchemaV1Result<T>;

/**
 * Builds the emitted `oneOf` member for a variant: when the variant's
 * `properties` do not mention the discriminator key (common, since the tag
 * is the mapping key), a copy with `{ const: tag }` injected (and the key
 * added to `required`) is emitted so the serialized JSON Schema can
 * reproduce the dispatch. Variants that already constrain the tag — and
 * non-object variants like refs — are emitted as-is, preserving object
 * identity for `compile()`'s ref binding.
 */
function emittedVariant(variant: FSchema<unknown>, key: string, tag: string): FSchema<unknown> {
  const v = variant as unknown as Record<string, unknown>;
  const props = v.properties;
  if (!props || typeof props !== 'object' || Object.hasOwn(props, key))
    return variant;
  const required = Array.isArray(v.required) ? (v.required as string[]) : [];
  return {
    ...v,
    properties: { ...(props as Record<string, unknown>), [key]: { const: tag } },
    required: [...required, key],
  } as unknown as FSchema<unknown>;
}

/**
 * Tagged union with O(1) dispatch on the value of `key`.
 *
 * Mapping keys are the expected tag values. Input tags of type `string`,
 * `number`, or `boolean` are matched by their string form (`{ version: 2 }`
 * dispatches to mapping key `'2'`); note that a numeric/boolean-tagged
 * variant should declare the tag property itself (e.g. `literal(2)`) since
 * the auto-injected emitted `const` is the string mapping key.
 *
 * A value without the discriminator key fails with `missing_discriminator`;
 * a present-but-unmapped tag fails with `unknown_discriminator` — both with
 * `path: [key]`.
 *
 * The emitted shape is `oneOf` (each variant constrained on the tag, see
 * {@link emittedVariant}) plus an OpenAPI-style
 * `discriminator: { propertyName }` hint.
 */
/* @__NO_SIDE_EFFECTS__ */
export function discriminatedUnion<
  K extends string,
  M extends Record<string, FSchema<unknown>>,
>(
  key: K,
  mapping: M,
): FDiscriminatedUnion<K, M> {
  const map = new Map<string, SyncValidate<unknown>>();
  const variants: FSchema<unknown>[] = [];
  for (const tag of Object.keys(mapping)) {
    const variant = mapping[tag]!;
    map.set(tag, variant['~standard'].validate as SyncValidate<unknown>);
    variants.push(emittedVariant(variant, key, tag));
  }

  return {
    'oneOf': variants,
    'discriminator': { propertyName: key },
    '~standard': {
      version: 1,
      vendor: 'fetcher',
      validate(v): StandardSchemaV1Result<Infer<M[keyof M]>> {
        if (typeof v !== 'object' || v === null || Array.isArray(v))
          return { issues: [{ code: 'expected_object', message: 'Expected object' }] };
        if (!Object.hasOwn(v, key))
          return { issues: [{ code: 'missing_discriminator', message: 'Missing discriminator', path: [key] }] };
        const tag = (v as Record<string, unknown>)[key];
        const validate
          = (typeof tag === 'string' || typeof tag === 'number' || typeof tag === 'boolean')
            ? map.get(String(tag))
            : undefined;
        if (validate === undefined)
          return { issues: [{ code: 'unknown_discriminator', message: 'Unknown discriminator', path: [key] }] };
        return ensureSync(validate(v)) as StandardSchemaV1Result<Infer<M[keyof M]>>;
      },
    },
  } as FDiscriminatedUnion<K, M>;
}
