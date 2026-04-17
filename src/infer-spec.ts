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
 * Walks a JSON Schema shape and produces the TypeScript type of values that
 * satisfy it. Handles the subset enforced by `@bajustone/fetcher/schema`'s
 * runtime validator:
 *
 * - Primitives: `string`, `number`, `integer`, `boolean`, `null`
 * - `array` (`items`) and `object` (`properties` + `required`)
 * - `enum`, `const`
 * - `anyOf` / `oneOf` → union, `allOf` → intersection
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
              : S extends { nullable: true; type: infer T }
                ? JSONSchemaToType<{ type: T }, Defs> | null
                : S extends { type: 'array'; items: infer I }
                  ? JSONSchemaToType<I, Defs>[]
                  : S extends { type: 'object'; properties: infer P; required: infer R }
                    ? R extends readonly unknown[]
                      ? ObjectFromProps<P, R[number], Defs>
                      : ObjectFromProps<P, never, Defs>
                    : S extends { type: 'object'; properties: infer P }
                      ? ObjectFromProps<P, never, Defs>
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

type JsonSchema<Content>
  = Content extends { 'application/json': { schema: infer Schema } }
    ? Schema
    : Content extends { '*/*': { schema: infer Schema } }
      ? Schema
      : never;

type First2xx<Responses>
  = Responses extends { 200: infer R } ? R
    : Responses extends { 201: infer R } ? R
      : Responses extends { 202: infer R } ? R
        : Responses extends { 204: infer R } ? R
          : never;

type First4xx5xx<Responses>
  = Responses extends { 400: infer R } ? R
    : Responses extends { 401: infer R } ? R
      : Responses extends { 403: infer R } ? R
        : Responses extends { 404: infer R } ? R
          : Responses extends { 409: infer R } ? R
            : Responses extends { 422: infer R } ? R
              : Responses extends { 500: infer R } ? R
                : Responses extends { default: infer R } ? R
                  : never;

type BodyTypeFromOp<Op, Defs>
  = Op extends { requestBody: { content: infer C } }
    ? [JsonSchema<C>] extends [never] ? unknown : JSONSchemaToType<JsonSchema<C>, Defs>
    : unknown;

type ResponseTypeFromOp<Op, Defs>
  = Op extends { responses: infer Resp }
    ? [First2xx<Resp>] extends [never]
        ? unknown
        : First2xx<Resp> extends { content: infer C }
          ? [JsonSchema<C>] extends [never] ? unknown : JSONSchemaToType<JsonSchema<C>, Defs>
          : unknown
    : unknown;

type ErrorTypeFromOp<Op, Defs>
  = Op extends { responses: infer Resp }
    ? [First4xx5xx<Resp>] extends [never]
        ? unknown
        : First4xx5xx<Resp> extends { content: infer C }
          ? [JsonSchema<C>] extends [never] ? unknown : JSONSchemaToType<JsonSchema<C>, Defs>
          : unknown
    : unknown;

// ---------------------------------------------------------------------------
// Typed route-definition shape produced per method from a narrow spec
// ---------------------------------------------------------------------------

export interface InferredRouteDefinition<Op, Defs> {
  readonly body?: Schema<BodyTypeFromOp<Op, Defs>>;
  readonly params?: Schema;
  readonly query?: Schema;
  readonly response?: Schema<ResponseTypeFromOp<Op, Defs>>;
  readonly errorResponse?: Schema<ErrorTypeFromOp<Op, Defs>>;
}
