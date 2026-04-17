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
  type?: string | string[];
  properties?: Record<string, JSONSchemaDefinition>;
  required?: string[];
  items?: JSONSchemaDefinition;
  enum?: unknown[];
  nullable?: boolean;
  oneOf?: JSONSchemaDefinition[];
  anyOf?: JSONSchemaDefinition[];
  allOf?: JSONSchemaDefinition[];
  $ref?: string;
  $defs?: Record<string, JSONSchemaDefinition>;
  $schema?: string;
  $id?: string;
  const?: unknown;
  additionalProperties?: boolean | JSONSchemaDefinition;
  format?: string;
  default?: unknown;
  description?: string;
  title?: string;
  example?: unknown;
  examples?: unknown[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number | boolean;
  exclusiveMaximum?: number | boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
  readOnly?: boolean;
  writeOnly?: boolean;
  discriminator?: { propertyName: string; mapping?: Record<string, string> };
  xml?: unknown;
  externalDocs?: unknown;
  [key: `x-${string}`]: unknown;
}
