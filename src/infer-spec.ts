/**
 * Type-level OpenAPI spec → TypeScript inference.
 *
 * Walks the literal type of an OpenAPI 3.x spec and produces narrowed
 * `Routes` shapes with body, response, and error-response types inferred
 * from the spec's JSON Schemas. Works when the spec is sufficiently
 * narrowly typed — typically via an inline `const spec = {...} as const`.
 *
 * Codegen (openapi-typescript → `paths.d.ts`) remains the recommended path
 * for large specs; it's mature, handles every edge case, and keeps
 * TypeScript's conditional-type performance budget in check. This module
 * is the zero-codegen alternative for smaller specs or for prototypes
 * where copy-pasting a `as const` spec into a `.ts` file is acceptable.
 *
 * All types are compile-time only; this file ships no runtime code.
 *
 * @module
 */

import type { Schema } from './types.ts';

// ---------------------------------------------------------------------------
// JSONSchemaToType — converts a JSON Schema literal into a TypeScript type
// ---------------------------------------------------------------------------

type UnionToIntersection<U>
  = (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void ? I : never;

type Expand<T> = T extends infer O ? { [K in keyof O]: O[K] } : never;

type ObjectFromProps<P, ReqKeyUnion, Defs> = Expand<
  & { [K in keyof P as K extends ReqKeyUnion ? K : never]: JSONSchemaToType<P[K], Defs> }
  & { [K in keyof P as K extends ReqKeyUnion ? never : K]?: JSONSchemaToType<P[K], Defs> }
>;

type ResolveRef<R, Defs>
  = R extends `#/components/schemas/${infer Name}`
    ? Name extends keyof Defs
      ? JSONSchemaToType<Defs[Name], Defs>
      : unknown
    : R extends `#/$defs/${infer Name}`
      ? Name extends keyof Defs
        ? JSONSchemaToType<Defs[Name], Defs>
        : unknown
      : unknown;

/**
 * Maps `required` (when present and a literal tuple) onto the property bag.
 * Falls back to all-optional when `required` is absent or not narrowly typed.
 */
type ObjectWithRequired<S, P, Defs>
  = S extends { required: infer R }
    ? R extends readonly unknown[]
      ? ObjectFromProps<P, R[number], Defs>
      : ObjectFromProps<P, never, Defs>
    : ObjectFromProps<P, never, Defs>;

/**
 * Index-signature contribution from `additionalProperties`. A sub-schema
 * maps to `Record<string, T>`; `true`/absent contribute nothing here
 * (`unknown` is the identity under intersection); `false` also contributes
 * nothing — the declared properties already describe the closed shape.
 */
type AdditionalPropsPart<S, Defs>
  = S extends { additionalProperties: infer AP }
    ? AP extends object
      ? Record<string, JSONSchemaToType<AP, Defs>>
      : unknown
    : unknown;

/**
 * Maps a single JSON Schema `type` name (one member of a 3.1 type array)
 * to its TypeScript type, reading `items`/`properties`/`required` off the
 * full surrounding schema node `S` for the composite names.
 */
type TypeNameToTS<Name extends string, S, Defs>
  = Name extends 'string'
    ? string
    : Name extends 'number' | 'integer'
      ? number
      : Name extends 'boolean'
        ? boolean
        : Name extends 'null'
          ? null
          : Name extends 'array'
            ? S extends { items: infer I } ? JSONSchemaToType<I, Defs>[] : unknown[]
            : Name extends 'object'
              ? JSONSchemaToType<Omit<S, 'type'> & { type: 'object' }, Defs>
              : unknown;

/**
 * Walks a JSON Schema shape and produces the TypeScript type of values that
 * satisfy it. Handles the subset enforced by `@bajustone/fetcher/schema`'s
 * runtime validator:
 *
 * - Primitives: `string`, `number`, `integer`, `boolean`, `null`
 * - `array` (`items`) and `object` (`properties` + `required` +
 *   `additionalProperties` sub-schemas → index signature)
 * - `enum`, `const`
 * - `anyOf` / `oneOf` → union, `allOf` → intersection
 * - OpenAPI 3.0 `nullable: true` → `T | null` (preserving every other
 *   keyword on the node, matching the runtime converter)
 * - OpenAPI 3.1 type arrays (`type: ['string', 'null']`) → union of the
 *   mapped member types
 * - `$ref` against a `Defs` map (typically `spec.components.schemas`)
 *
 * Returns `unknown` for shapes outside the subset so users aren't forced
 * into a lie.
 */
export type JSONSchemaToType<S, Defs = object>
  = S extends { $ref: infer R }
    ? R extends string ? ResolveRef<R, Defs> : unknown
    : S extends { anyOf: infer Arr }
      ? Arr extends readonly unknown[] ? JSONSchemaToType<Arr[number], Defs> : unknown
      : S extends { oneOf: infer Arr }
        ? Arr extends readonly unknown[] ? JSONSchemaToType<Arr[number], Defs> : unknown
        : S extends { allOf: infer Arr }
          ? Arr extends readonly unknown[] ? UnionToIntersection<JSONSchemaToType<Arr[number], Defs>> : unknown
          : S extends { enum: infer E }
            ? E extends readonly unknown[] ? E[number] : unknown
            : S extends { const: infer C }
              ? C
              : S extends { nullable: true }
                ? JSONSchemaToType<Omit<S, 'nullable'>, Defs> | null
                : S extends { type: readonly (infer TS extends string)[] }
                  ? TypeNameToTS<TS, S, Defs>
                  : S extends { type: 'array'; items: infer I }
                    ? JSONSchemaToType<I, Defs>[]
                    : S extends { type: 'object'; properties: infer P }
                      ? ObjectWithRequired<S, P, Defs> & AdditionalPropsPart<S, Defs>
                      : S extends { type: 'object'; additionalProperties: infer AP }
                        ? AP extends object
                          ? Record<string, JSONSchemaToType<AP, Defs>>
                          : Record<string, unknown>
                        : S extends { type: 'object' }
                          ? Record<string, unknown>
                          : S extends { type: 'string' }
                            ? string
                            : S extends { type: 'number' | 'integer' }
                              ? number
                              : S extends { type: 'boolean' }
                                ? boolean
                                : S extends { type: 'null' }
                                  ? null
                                  : unknown;

// ---------------------------------------------------------------------------
// Body / response / error extraction from an OpenAPI operation node
// ---------------------------------------------------------------------------

/**
 * Media-type keys treated as JSON. Mirrors the runtime matcher in
 * `openapi.ts` (`isJsonMediaType`): exact `application/json`, parameterized
 * forms (`application/json; charset=utf-8`), structured-suffix types
 * (`application/problem+json`, `application/vnd.api+json`), and the
 * `*\/*` wildcard.
 */
type JsonMediaKey
  = | 'application/json'
    | `application/json;${string}`
    | `application/${string}+json`
    | `application/${string}+json;${string}`
    | '*/*';

/**
 * Extracts the JSON Schema node from a `content` map, accepting any
 * JSON-like media type (see {@link JsonMediaKey}). Resolves to `never`
 * when no JSON-like entry with a `schema` exists.
 */
type JsonMediaSchema<Content>
  = Content extends object
    ? {
        [K in keyof Content]: K extends JsonMediaKey
          ? Content[K] extends { schema: infer S } ? S : never
          : never
      }[keyof Content]
    : never;

/**
 * Union of JSON Schema nodes across every 2xx response (numeric or `'2XX'`
 * wildcard keys — anything whose key stringifies to `2…`, mirroring the
 * runtime's `code.startsWith('2')`). Individual responses expressed as
 * `{ $ref: '#/components/responses/N' }` are dereferenced against
 * `Components` first. `'default'` is intentionally NOT a success — it's
 * the error catch-all (see {@link ErrorJsonSchemaOf}). `never` when no
 * 2xx response carries a JSON schema.
 */
type SuccessJsonSchemaOf<Resp, Components>
  = Resp extends object
    ? {
        [K in keyof Resp]: `${K & (string | number)}` extends `2${string}`
          ? ResolveResponseRef<Resp[K], Components> extends { content: infer C } ? JsonMediaSchema<C> : never
          : never
      }[keyof Resp]
    : never;

type Explicit4xx5xxJsonSchemaOf<Resp, Components>
  = Resp extends object
    ? {
        [K in keyof Resp]: `${K & (string | number)}` extends `4${string}` | `5${string}`
          ? ResolveResponseRef<Resp[K], Components> extends { content: infer C } ? JsonMediaSchema<C> : never
          : never
      }[keyof Resp]
    : never;

/**
 * Union of JSON Schema nodes across explicit 4xx/5xx responses; falls back
 * to the `'default'` response when no explicit error response carries a
 * JSON schema. Matches the runtime (`extractErrorSchema`) and the
 * `OpenAPIErrorStatus` convention in `types.ts` — `'default'` is the error
 * catch-all, never the success schema. `$ref`'d responses are
 * dereferenced against `Components` (matching the runtime).
 */
type ErrorJsonSchemaOf<Resp, Components>
  = [Explicit4xx5xxJsonSchemaOf<Resp, Components>] extends [never]
    ? Resp extends { default: infer D }
      ? ResolveResponseRef<D, Components> extends { content: infer C } ? JsonMediaSchema<C> : never
      : never
    : Explicit4xx5xxJsonSchemaOf<Resp, Components>;

// ---------------------------------------------------------------------------
// Operation-level $ref resolution (mirrors the runtime's
// resolveOperationNode in openapi.ts at the type level)
// ---------------------------------------------------------------------------

/**
 * Resolves an operation-level requestBody `$ref`
 * (`{ $ref: '#/components/requestBodies/N' }`) against the spec's
 * `components.requestBodies` map — the type-level counterpart of the
 * runtime's `resolveOperationNode`. Resolves to `never` when the ref
 * cannot be followed (external ref, missing component, widened components
 * type, or a ref-to-ref chain); {@link BodySlot} then falls back to a
 * **required** `Schema<unknown>` slot so the spec's required-ness is
 * preserved instead of silently compiling the body away.
 */
type ResolveRequestBodyRef<RB, Components>
  = RB extends { $ref: `#/components/requestBodies/${infer Name}` }
    ? Components extends { requestBodies: infer Bodies }
      ? Name extends keyof Bodies
        ? Bodies[Name] extends { $ref: unknown }
          ? never // ref-to-ref chains are not walked at the type level
          : Bodies[Name]
        : never
      : never
    : never;

/**
 * Resolves a response node that may be an operation-level `$ref`
 * (`{ $ref: '#/components/responses/N' }`) against the spec's
 * `components.responses` map. Non-ref nodes pass through untouched.
 * Unresolvable refs resolve to `unknown` (which carries no `content`), so
 * the surrounding slot degrades to absent — `result.data` is then
 * `unknown`, mirroring the runtime's warn-and-skip.
 */
type ResolveResponseRef<R, Components>
  = R extends { $ref: infer Ref }
    ? Ref extends `#/components/responses/${infer Name}`
      ? Components extends { responses: infer Resps }
        ? Name extends keyof Resps ? Resps[Name] : unknown
        : unknown
      : unknown
    : R;

// ---------------------------------------------------------------------------
// Typed route-definition shape produced per method from a narrow spec
// ---------------------------------------------------------------------------

/**
 * `body` slot computed from an already-dereferenced requestBody object
 * node: required `Schema<T>` when the node carries `required: true`,
 * optional `Schema<T>` otherwise (the OpenAPI default), and an
 * explicitly-absent slot when no JSON content exists.
 */
type BodySlotFromRequestBody<RB, Defs>
  = RB extends { content: infer C }
    ? [JsonMediaSchema<C>] extends [never]
        ? { readonly body?: undefined }
        : RB extends { required: true }
          ? { readonly body: Schema<JSONSchemaToType<JsonMediaSchema<C>, Defs>> }
          : { readonly body?: Schema<JSONSchemaToType<JsonMediaSchema<C>, Defs>> }
    : { readonly body?: undefined };

/**
 * `body` slot for an operation: required `Schema<T>` when the spec marks
 * the requestBody `required: true` (a missing/mistyped body is then a
 * compile error at the call site), optional `Schema<T>` when the
 * requestBody is optional (OpenAPI defaults `required` to `false`; the
 * call-site `body` then stays optional, mirroring how the
 * `openapi-typescript` paths flow treats optional request bodies), and an
 * explicitly-absent slot when no JSON request body exists.
 *
 * A requestBody expressed as `{ $ref: '#/components/requestBodies/N' }` is
 * dereferenced against `Components` first (matching the runtime). When the
 * ref cannot be resolved at the type level, the slot is a required
 * `Schema<unknown>` — required-ness is preserved (the runtime may still
 * enforce it) while the payload stays untyped.
 */
type BodySlot<Op, Defs, Components>
  = Op extends { requestBody: infer RB }
    ? RB extends { $ref: string }
      ? [ResolveRequestBodyRef<RB, Components>] extends [never]
          ? { readonly body: Schema<unknown> }
          : BodySlotFromRequestBody<ResolveRequestBodyRef<RB, Components>, Defs>
      : BodySlotFromRequestBody<RB, Defs>
    : { readonly body?: undefined };

/**
 * `response` slot: present (and required, so call-site resolvers can match
 * `{ response: Schema<infer T> }`) exactly when a 2xx response carries a
 * JSON schema — the same condition under which `fromOpenAPI` installs a
 * runtime validator.
 */
type ResponseSlot<Op, Defs, Components>
  = Op extends { responses: infer Resp }
    ? [SuccessJsonSchemaOf<Resp, Components>] extends [never]
        ? { readonly response?: undefined }
        : { readonly response: Schema<JSONSchemaToType<SuccessJsonSchemaOf<Resp, Components>, Defs>> }
    : { readonly response?: undefined };

/**
 * `errorResponse` slot: present when an explicit 4xx/5xx — or, failing
 * that, the `'default'` catch-all — carries a JSON schema.
 */
type ErrorResponseSlot<Op, Defs, Components>
  = Op extends { responses: infer Resp }
    ? [ErrorJsonSchemaOf<Resp, Components>] extends [never]
        ? { readonly errorResponse?: undefined }
        : { readonly errorResponse: Schema<JSONSchemaToType<ErrorJsonSchemaOf<Resp, Components>, Defs>> }
    : { readonly errorResponse?: undefined };

/**
 * Route definition inferred from a single OpenAPI operation node.
 *
 * Slots are **required properties when the spec declares them** (and
 * explicitly absent otherwise) so that the call-site resolvers in
 * `types.ts` — which match non-optional properties, e.g.
 * `R[P][M] extends { response: Schema<infer T> }` — see the inferred types.
 * This is what makes the zero-codegen flow
 * `createFetch({ routes: fromOpenAPI(spec) })` produce typed `result.data`
 * / `body` / `error.body` at call sites instead of `unknown`.
 *
 * `params` and `query` remain loosely-typed optional slots: path-parameter
 * types flow from the path template (`ExtractPathParams`), and query
 * typing from `parameters` is not walked yet — the runtime validators are
 * installed either way.
 *
 * `Components` is the spec's `components` object (threaded through
 * `InferRoutesFromSpec`), used to dereference operation-level
 * `requestBody`/`responses` `$ref`s like the runtime does. The `object`
 * default means "nothing resolvable".
 */
export type InferredRouteDefinition<Op, Defs, Components = object>
  = & BodySlot<Op, Defs, Components>
    & { readonly params?: Schema; readonly query?: Schema }
    & ResponseSlot<Op, Defs, Components>
    & ErrorResponseSlot<Op, Defs, Components>;
