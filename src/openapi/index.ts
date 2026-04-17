/**
 * `@bajustone/fetcher/openapi` — OpenAPI 3.x adapter and JSON Schema
 * interoperability helpers. Pulls in the schema-extraction / ref-bundling /
 * inlining utilities only when you import from this subpath.
 *
 * @module
 */

export { fromJSONSchema } from '../from-json-schema.ts';
export { inline } from '../inline.ts';
export type { JSONSchemaDefinition } from '../json-schema-types.ts';
export {
  bundleComponent,
  extractComponentSchemas,
  extractRouteSchemas,
  fromOpenAPI,
  JSON_SCHEMA_DIALECT,
  translateDialect,
} from '../openapi.ts';
export type { ExtractedRouteSchemas } from '../openapi.ts';
