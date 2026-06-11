/**
 * Shared type definitions for plain JSON Schema objects consumed by the
 * OpenAPI adapter, the Vite plugin, and the `inline()` helper.
 *
 * This file exports types only — no runtime code.
 *
 * @module
 */

/**
 * A JSON Schema node. Only the fields consumed by `@bajustone/fetcher`
 * tooling (OpenAPI adapter, `inline()`, Vite plugin, `fromJSONSchema`) are
 * declared — other keywords pass through untouched.
 */
export interface JSONSchemaDefinition {
  /** Schema type name (`'object'`, `'string'`, …) or a 3.1 type array (`['string', 'null']`). */
  type?: string | string[];
  /** Named property schemas for `type: 'object'`. */
  properties?: Record<string, JSONSchemaDefinition>;
  /** Property names that must be present on an object value. */
  required?: string[];
  /** Element schema for `type: 'array'`. */
  items?: JSONSchemaDefinition;
  /** Closed set of allowed values. */
  enum?: unknown[];
  /** OpenAPI 3.0 nullability flag (3.1 uses `type` arrays instead). */
  nullable?: boolean;
  /** Exactly-one-of composition (often paired with `discriminator`). */
  oneOf?: JSONSchemaDefinition[];
  /** Any-of composition — value must match at least one member. */
  anyOf?: JSONSchemaDefinition[];
  /** All-of composition — value must match every member. */
  allOf?: JSONSchemaDefinition[];
  /** JSON Pointer reference to another schema (e.g. `#/components/schemas/Pet`). */
  $ref?: string;
  /** Local definitions referenced via `#/$defs/Name`. */
  $defs?: Record<string, JSONSchemaDefinition>;
  /** Dialect identifier (accepted, unused by the runtime). */
  $schema?: string;
  /** Schema identifier (accepted; only intra-document `$ref` is resolved). */
  $id?: string;
  /** Single allowed value. */
  const?: unknown;
  /** `false` closes the object; a sub-schema constrains undeclared keys. */
  additionalProperties?: boolean | JSONSchemaDefinition;
  /** Semantic format annotation (`'email'`, `'uuid'`, `'date-time'`, …). */
  format?: string;
  /** Default-value annotation. */
  default?: unknown;
  /** Human-readable description annotation. */
  description?: string;
  /** Human-readable title annotation. */
  title?: string;
  /** OpenAPI single-example annotation. */
  example?: unknown;
  /** JSON Schema examples annotation. */
  examples?: unknown[];
  /** Inclusive lower bound for numeric values. */
  minimum?: number;
  /** Inclusive upper bound for numeric values. */
  maximum?: number;
  /** Exclusive lower bound (draft-4 used a boolean modifier form). */
  exclusiveMinimum?: number | boolean;
  /** Exclusive upper bound (draft-4 used a boolean modifier form). */
  exclusiveMaximum?: number | boolean;
  /** Minimum string length (code points). */
  minLength?: number;
  /** Maximum string length (code points). */
  maxLength?: number;
  /** ECMA-262 regex the string must match. */
  pattern?: string;
  /** Minimum array length. */
  minItems?: number;
  /** Maximum array length. */
  maxItems?: number;
  /** OpenAPI annotation: present in responses only. */
  readOnly?: boolean;
  /** OpenAPI annotation: present in requests only. */
  writeOnly?: boolean;
  /** OpenAPI discriminator hint for `oneOf` dispatch. */
  discriminator?: { propertyName: string; mapping?: Record<string, string> };
  /** OpenAPI XML serialization metadata (passed through untouched). */
  xml?: unknown;
  /** OpenAPI external documentation link (passed through untouched). */
  externalDocs?: unknown;
  /** OpenAPI vendor extensions (`x-*`) pass through untouched. */
  [key: `x-${string}`]: unknown;
}
