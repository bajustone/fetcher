/**
 * Discriminated-union factory. Unlike {@link union}, dispatch is O(1) via a
 * keyed map rather than sequential trial-validation.
 *
 * @module
 */

import type { StandardSchemaV1Result } from '../types.ts';
import type { FDiscriminatedUnion, FSchema, Infer } from './types.ts';

type SyncValidate<T> = (value: unknown) => StandardSchemaV1Result<T>;

/* @__NO_SIDE_EFFECTS__ */
export function discriminatedUnion<
  K extends string,
  M extends Record<string, FSchema<unknown>>,
>(
  key: K,
  mapping: M,
): FDiscriminatedUnion<K, M> {
  const map = new Map<string, SyncValidate<unknown>>();
  for (const tag in mapping)
    map.set(tag, mapping[tag]!['~standard'].validate as SyncValidate<unknown>);
  const variants = Object.values(mapping) as FSchema<unknown>[];

  return {
    'oneOf': variants,
    'discriminator': { propertyName: key },
    '~standard': {
      version: 1,
      vendor: 'fetcher',
      validate(v): StandardSchemaV1Result<Infer<M[keyof M]>> {
        if (typeof v !== 'object' || v === null || Array.isArray(v))
          return { issues: [{ message: 'Expected object' }] };
        const tag = (v as Record<string, unknown>)[key];
        if (typeof tag !== 'string' || !map.has(tag))
          return { issues: [{ message: 'Unknown discriminator', path: [key] }] };
        return map.get(tag)!(v) as StandardSchemaV1Result<Infer<M[keyof M]>>;
      },
    },
  } as FDiscriminatedUnion<K, M>;
}
