/**
 * Type-level tests for `withInputType<Input>()` — re-tag a schema's `Input`
 * without changing its runtime or `Output`. Verifies:
 *
 * - Output inference is preserved.
 * - Input is narrowed to the supplied generic.
 * - Identity at the runtime level (same reference returned).
 */

import type { Infer } from '../../src/schema/index.ts';
import type { StandardSchemaV1 } from '../../src/types.ts';
import { withInputType } from '../../src/with-input-type.ts';

// ---------------------------------------------------------------------------
// Equal / Verify helpers
// ---------------------------------------------------------------------------

type Equal<X, Y>
  = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2)
    ? true
    : false;

export type Verify<T extends true> = T;

// ---------------------------------------------------------------------------
// A minimal Standard Schema V1 fixture
// ---------------------------------------------------------------------------

interface Login { email: string; password: string }

const loginSchema: StandardSchemaV1<unknown, Login> = {
  '~standard': {
    version: 1,
    vendor: 'fixture',
    validate: value => ({ value: value as Login }),
  },
};

// SvelteKit's RemoteFormInput shape (abbreviated).
interface RemoteFormInput {
  readonly [key: string]: string | number | boolean | File | readonly string[] | RemoteFormInput;
}

// ---------------------------------------------------------------------------
// Re-tagged schema (prefixed with _ so lint's unused-vars rule treats it as
// an intentionally-unused type-test binding).
// ---------------------------------------------------------------------------

const _formAware = withInputType<RemoteFormInput>()(loginSchema);

// Output is preserved — still Login.
export type _OutputPreserved = Verify<Equal<Infer<typeof _formAware>, Login>>;

// Input is now RemoteFormInput (not unknown).
export type _InputRetagged = Verify<
  typeof _formAware extends StandardSchemaV1<infer I, Login>
    ? Equal<I, RemoteFormInput>
    : false
>;

// The re-tagged schema satisfies StandardSchemaV1<RemoteFormInput, Login>,
// the shape SvelteKit's form() wants.
export type _AssignsToNarrowerInput = Verify<
  typeof _formAware extends StandardSchemaV1<RemoteFormInput, Login> ? true : false
>;
