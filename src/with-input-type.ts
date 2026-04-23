/**
 * `withInputType` — re-tag a Standard Schema V1 schema's declared **input**
 * type without touching its runtime or output type.
 *
 * Standard Schema V1 has two generics: `Input` (invariant) and `Output`.
 * Fetcher's validators (including the ones produced by `fromJSONSchema`,
 * the bundled builder, and most external libraries) declare their input
 * as `unknown`. That's fine for most consumers — but some integrators want
 * a narrower `Input`:
 *
 * - SvelteKit's `form(schema, handler)` expects
 *   `StandardSchemaV1<RemoteFormInput, Output>` where `RemoteFormInput`
 *   is its own union of FormData-compatible primitives.
 * - Custom integrations that want to tell TypeScript "this schema is only
 *   valid input for a `ReadonlyRecord<string, string>` carrier" or similar.
 *
 * Because Standard Schema's `Input` is invariant, `StandardSchemaV1<unknown, T>`
 * is **not** assignable to `StandardSchemaV1<NarrowerInput, T>` without a
 * cast. `withInputType` is that cast, spelled once in the library so your
 * call sites stay clean.
 *
 * Zero runtime cost — the function returns the same object it was given,
 * only the compile-time type is re-tagged.
 *
 * **Curried** so you specify `Input` explicitly and let `Output` infer
 * from the schema. TypeScript cannot partially-infer a single generic
 * parameter, which is why the curried shape is necessary.
 *
 * @example SvelteKit remote form
 * ```ts
 * import type { RemoteFormInput } from '$app/server';
 * import { withInputType } from '@bajustone/fetcher';
 * import { validators } from 'virtual:fetcher';
 *
 * const loginForm = form(withInputType<RemoteFormInput>()(validators.LoginBody), async (data) => {
 *   // data is the Output type from validators.LoginBody
 * });
 * ```
 *
 * @module
 */

import type { StandardSchemaV1 } from './types.ts';

/**
 * Returns an identity function that re-tags its argument's `Input` generic
 * to `Input` while preserving the `Output` generic via inference.
 *
 * @example
 * ```ts
 * const formAware = withInputType<RemoteFormInput>()(loginSchema);
 * //    ^? StandardSchemaV1<RemoteFormInput, Infer<typeof loginSchema>>
 * ```
 */
/* @__NO_SIDE_EFFECTS__ */
export function withInputType<Input>(): <Output>(
  schema: StandardSchemaV1<unknown, Output>,
) => StandardSchemaV1<Input, Output> {
  return <Output>(schema: StandardSchemaV1<unknown, Output>) =>
    schema as unknown as StandardSchemaV1<Input, Output>;
}
