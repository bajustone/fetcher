/**
 * OpenAPI 3.x adapter — converts a spec into a `Routes` table that
 * {@link createFetch} can consume, with JSON Schema validation on every
 * body, params, query, and response.
 *
 * @module
 */

import type { JSONSchemaDefinition } from './json-schema-types.ts';
import type { HttpMethod, InferRoutesFromSpec, RouteDefinition, Routes } from './types.ts';
import { fromJSONSchema } from './from-json-schema.ts';

/**
 * Raw schema data extracted from an OpenAPI spec — the build-time
 * counterpart of the runtime `Routes` object. Contains only the JSON
 * Schema nodes needed for validation, not the full spec.
 *
 * Used by the Vite/Rollup plugin to inline schemas at build time so the
 * full OpenAPI spec is never shipped to the client bundle.
 */
export interface ExtractedRouteSchemas {
  definitions: Record<string, JSONSchemaDefinition>;
  routes: Record<string, Record<string, {
    body?: JSONSchemaDefinition;
    response?: JSONSchemaDefinition;
    errorResponse?: JSONSchemaDefinition;
    params?: JSONSchemaDefinition;
    query?: JSONSchemaDefinition;
  }>>;
}

/**
 * Loose OpenAPI 3.x spec shape — the public input type for {@link fromOpenAPI}.
 *
 * Uses `any` index signatures so that an `import spec from './openapi.json'`
 * (which widens each object to include its literal `description`/`summary`/
 * etc. fields) satisfies the type without a cast. The internal parser uses
 * the tighter {@link OpenAPIOperation} / {@link OpenAPIParameter} shapes
 * below — the boundary cast happens at the iteration site in `fromOpenAPI`.
 *
 * Only `paths` and `components.schemas` are named; everything else is
 * permitted via index signatures.
 */
export interface OpenAPISpec {
  openapi?: string;
  /**
   * Map of URL paths to path-item objects. The value type is `any` (rather
   * than a closed shape) so that JSON-imported specs with extra fields like
   * `summary`/`description` on path items satisfy the constraint.
   */
  paths?: { [path: string]: any };
  components?: {
    schemas?: { [name: string]: JSONSchemaDefinition };
    [key: string]: any;
  };
  [key: string]: any;
}

/**
 * Internal narrowed shape for an OpenAPI operation. Only the fields this
 * adapter reads are named; the parser is defensive about missing/extra
 * fields via optional chaining.
 */
interface OpenAPIOperation {
  requestBody?: {
    content?: Record<string, { schema?: JSONSchemaDefinition }>;
  };
  responses?: Record<
    string,
    { content?: Record<string, { schema?: JSONSchemaDefinition }> }
  >;
  parameters?: OpenAPIParameter[];
}

/**
 * Internal narrowed shape for an OpenAPI parameter object.
 */
interface OpenAPIParameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required?: boolean;
  schema?: JSONSchemaDefinition;
}

const HTTP_METHODS: Set<string> = new Set([
  'get',
  'post',
  'put',
  'delete',
  'patch',
]);

/**
 * Converts an OpenAPI 3.x spec into typed route definitions with built-in
 * JSON Schema validators. One JSON spec gives you type safety + runtime
 * validation with zero external dependencies.
 *
 * Generic over the literal spec type: when called with an `as const` JSON
 * import (or any literal-typed object), the return type is narrowed to the
 * spec's actual paths and methods via {@link InferRoutesFromSpec}, so
 * downstream `createFetch({ routes: fromOpenAPI(spec) })` calls get path
 * autocomplete and method narrowing for free.
 *
 * Body/response type inference from the spec's JSON Schemas is a follow-up
 * (see the {@link InferRoutesFromSpec} JSDoc); the runtime validators are
 * still active either way.
 *
 * ```typescript
 * import spec from './openapi.json'
 * const f = createFetch({
 *   baseUrl: '...',
 *   routes: fromOpenAPI(spec),
 * })
 *
 * f('/pets/{petId}', { method: 'GET', params: { petId: '42' } })
 * //  ^ autocompletes from spec               ^ inferred from path template
 * ```
 */
export function fromOpenAPI<const Spec extends OpenAPISpec>(
  spec: Spec,
): InferRoutesFromSpec<Spec> {
  const definitions = buildDefinitions(spec);
  const routes: Routes = {};

  if (!spec.paths)
    return routes as InferRoutesFromSpec<Spec>;

  for (const [path, pathItem] of Object.entries(spec.paths)) {
    if (!pathItem || typeof pathItem !== 'object')
      continue;

    const methodDefs: Partial<Record<HttpMethod, RouteDefinition>> = {};

    for (const [method, rawOperation] of Object.entries(pathItem as Record<string, unknown>)) {
      if (!HTTP_METHODS.has(method))
        continue;
      if (!rawOperation || typeof rawOperation !== 'object')
        continue;

      // Boundary cast: the public OpenAPISpec input is loose so JSON
      // imports satisfy it; from here on we work with the tight internal
      // OpenAPIOperation shape that the parsing helpers expect.
      const operation = rawOperation as OpenAPIOperation;
      const routeDef: RouteDefinition = {};

      // Request body schema
      const bodySchema = extractBodySchema(operation);
      if (bodySchema) {
        routeDef.body = fromJSONSchema(bodySchema, definitions);
      }

      // Response schema (first 2xx response)
      const responseSchema = extractResponseSchema(operation);
      if (responseSchema) {
        routeDef.response = fromJSONSchema(responseSchema, definitions);
      }

      // Error response schema (first 4xx/5xx)
      const errorSchema = extractErrorSchema(operation);
      if (errorSchema) {
        routeDef.errorResponse = fromJSONSchema(errorSchema, definitions);
      }

      // Path + query parameters
      const params = extractParams(operation, 'path');
      if (params) {
        routeDef.params = fromJSONSchema(params, definitions);
      }

      const query = extractParams(operation, 'query');
      if (query) {
        routeDef.query = fromJSONSchema(query, definitions);
      }

      methodDefs[method.toUpperCase() as HttpMethod] = routeDef;
    }

    if (Object.keys(methodDefs).length > 0) {
      routes[path] = methodDefs;
    }
  }

  // The runtime can't statically verify the literal mapping computed by
  // InferRoutesFromSpec — that's a compile-time-only narrowing. Cast through.
  return routes as InferRoutesFromSpec<Spec>;
}

/**
 * JSON Schema draft-2020-12 dialect marker emitted on each bundled component.
 */
export const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

/**
 * Translates OpenAPI 3.0 dialect keywords to their JSON Schema draft-2020-12
 * equivalents, recursively. Returns a new object — input is not mutated.
 *
 * - `nullable: true` → add `'null'` to the `type` array
 * - `exclusiveMinimum: true` + `minimum: X` (Draft 4 boolean) → `exclusiveMinimum: X` (numeric)
 * - `exclusiveMaximum: true` + `maximum: X` → `exclusiveMaximum: X`
 * - `example: X` → `examples: [X]` (unless `examples` already present)
 * - Drops `xml`, `externalDocs` (presentation-only, not validation)
 * - Leaves `discriminator`, `readOnly`, `writeOnly` intact
 */
export function translateDialect(
  schema: JSONSchemaDefinition,
): JSONSchemaDefinition {
  return translateNode(schema) as JSONSchemaDefinition;
}

function translateNode(node: unknown): unknown {
  if (node === null || typeof node !== 'object')
    return node;
  if (Array.isArray(node))
    return node.map(translateNode);

  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(src)) {
    // Drop OpenAPI-only presentation keywords
    if (key === 'xml' || key === 'externalDocs')
      continue;
    // `nullable` is handled below
    if (key === 'nullable')
      continue;
    // `example` is handled below
    if (key === 'example')
      continue;
    // Boolean `exclusiveMinimum`/`exclusiveMaximum` (Draft 4) is handled below
    if ((key === 'exclusiveMinimum' || key === 'exclusiveMaximum') && typeof value === 'boolean')
      continue;
    out[key] = translateNode(value);
  }

  // nullable: true → add 'null' to type
  if (src.nullable === true) {
    const currentType = out.type;
    if (Array.isArray(currentType)) {
      if (!currentType.includes('null'))
        out.type = [...currentType, 'null'];
    }
    else if (typeof currentType === 'string') {
      out.type = [currentType, 'null'];
    }
    // If no type, leave as-is — nullable without type has no draft-2020-12 analogue
  }

  // Draft 4 boolean exclusiveMinimum/exclusiveMaximum → Draft 6+ numeric
  if (src.exclusiveMinimum === true && typeof src.minimum === 'number') {
    out.exclusiveMinimum = src.minimum;
    delete out.minimum;
  }
  if (src.exclusiveMaximum === true && typeof src.maximum === 'number') {
    out.exclusiveMaximum = src.maximum;
    delete out.maximum;
  }

  // example → examples (array), unless examples already present
  if ('example' in src && !('examples' in out)) {
    out.examples = [src.example];
  }

  return out;
}

/**
 * Bundles a single component schema into a self-contained JSON Schema
 * draft-2020-12 document:
 *
 * - Collects the transitive closure of `#/components/schemas/*` refs reachable
 *   from the component.
 * - Rewrites every ref from `#/components/schemas/X` to `#/$defs/X`.
 * - Attaches a local `$defs` map with the translated+rewritten reached
 *   components (omitted if nothing was reached).
 * - Adds a `$schema` dialect marker.
 *
 * Returns `undefined` if the component is not present in the input map.
 */
export function bundleComponent(
  name: string,
  translatedComponents: Record<string, JSONSchemaDefinition>,
): JSONSchemaDefinition | undefined {
  const root = translatedComponents[name];
  if (!root)
    return undefined;

  const reached = new Set<string>();
  collectReached(root, translatedComponents, reached);

  const rootRewritten = rewriteRefs(root) as JSONSchemaDefinition;
  const bundled: JSONSchemaDefinition = {
    $schema: JSON_SCHEMA_DIALECT,
    ...rootRewritten,
  };

  // Merge — don't overwrite — with any $defs the component already declared
  // locally (valid in JSON Schema 2020-12 / OpenAPI 3.1).
  const existingDefs = rootRewritten.$defs;
  if (reached.size > 0 || existingDefs) {
    const merged: Record<string, JSONSchemaDefinition> = { ...(existingDefs ?? {}) };
    for (const reachedName of reached) {
      const target = translatedComponents[reachedName];
      if (target)
        merged[reachedName] = rewriteRefs(target) as JSONSchemaDefinition;
    }
    bundled.$defs = merged;
  }

  return bundled;
}

function collectReached(
  node: unknown,
  components: Record<string, JSONSchemaDefinition>,
  reached: Set<string>,
): void {
  if (node === null || typeof node !== 'object')
    return;
  if (Array.isArray(node)) {
    for (const item of node)
      collectReached(item, components, reached);
    return;
  }
  const n = node as Record<string, unknown>;
  if (typeof n.$ref === 'string' && n.$ref.startsWith('#/components/schemas/')) {
    const target = n.$ref.slice('#/components/schemas/'.length);
    if (!reached.has(target)) {
      reached.add(target);
      if (components[target])
        collectReached(components[target], components, reached);
    }
  }
  for (const value of Object.values(n)) {
    if (value !== null && typeof value === 'object')
      collectReached(value, components, reached);
  }
}

function rewriteRefs(node: unknown): unknown {
  if (node === null || typeof node !== 'object')
    return node;
  if (Array.isArray(node))
    return node.map(rewriteRefs);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (
      key === '$ref'
      && typeof value === 'string'
      && value.startsWith('#/components/schemas/')
    ) {
      out[key] = `#/$defs/${value.slice('#/components/schemas/'.length)}`;
    }
    else {
      out[key] = rewriteRefs(value);
    }
  }
  return out;
}

/**
 * Extracts component schemas from an OpenAPI spec, translates each to JSON
 * Schema draft-2020-12, and bundles each into a self-contained document with
 * a local `$defs` map containing transitively referenced components.
 *
 * The build-time companion to the plugin's `virtual:fetcher` schema export.
 */
export function extractComponentSchemas(
  spec: OpenAPISpec,
): { schemas: Record<string, JSONSchemaDefinition> } {
  const rawComponents = spec.components?.schemas ?? {};
  const translated: Record<string, JSONSchemaDefinition> = {};
  for (const [name, schema] of Object.entries(rawComponents))
    translated[name] = translateDialect(schema);

  const schemas: Record<string, JSONSchemaDefinition> = {};
  for (const name of Object.keys(translated)) {
    const bundled = bundleComponent(name, translated);
    if (bundled)
      schemas[name] = bundled;
  }

  return { schemas };
}

/**
 * Flat map of component schemas by name. Refs in route schemas (of the form
 * `#/components/schemas/Pet`) resolve by their last path segment.
 */
function buildDefinitions(
  spec: OpenAPISpec,
): Record<string, JSONSchemaDefinition> {
  return (spec.components?.schemas ?? {}) as Record<string, JSONSchemaDefinition>;
}

function extractBodySchema(
  operation: OpenAPIOperation,
): JSONSchemaDefinition | null {
  const content = operation.requestBody?.content;
  if (!content)
    return null;
  const jsonContent
    = content['application/json'] ?? content['*/*'];
  return jsonContent?.schema ?? null;
}

function extractResponseSchema(
  operation: OpenAPIOperation,
): JSONSchemaDefinition | null {
  if (!operation.responses)
    return null;
  // Find first 2xx response
  for (const [code, response] of Object.entries(operation.responses)) {
    if (code.startsWith('2') || code === 'default') {
      const content = response.content;
      if (!content)
        continue;
      const jsonContent
        = content['application/json'] ?? content['*/*'];
      if (jsonContent?.schema)
        return jsonContent.schema;
    }
  }
  return null;
}

function extractErrorSchema(
  operation: OpenAPIOperation,
): JSONSchemaDefinition | null {
  if (!operation.responses)
    return null;
  for (const [code, response] of Object.entries(operation.responses)) {
    if (code.startsWith('4') || code.startsWith('5')) {
      const content = response.content;
      if (!content)
        continue;
      const jsonContent
        = content['application/json'] ?? content['*/*'];
      if (jsonContent?.schema)
        return jsonContent.schema;
    }
  }
  return null;
}

function extractParams(
  operation: OpenAPIOperation,
  location: 'path' | 'query',
): JSONSchemaDefinition | null {
  const params = operation.parameters?.filter(p => p.in === location);
  if (!params || params.length === 0)
    return null;

  const properties: Record<string, JSONSchemaDefinition> = {};
  const required: string[] = [];

  for (const param of params) {
    properties[param.name] = param.schema ?? { type: 'string' };
    if (param.required) {
      required.push(param.name);
    }
  }

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

/**
 * Extracts only the JSON Schema nodes needed for validation from an
 * OpenAPI spec — without constructing `JSONSchemaValidator` instances.
 *
 * This is the build-time companion to {@link fromOpenAPI}: the Vite/Rollup
 * plugin calls this at build time, serializes the result as inline JSON,
 * and reconstructs validators on the client from the pre-extracted data.
 * The full spec never reaches the bundle.
 */
export function extractRouteSchemas(spec: OpenAPISpec): ExtractedRouteSchemas {
  const definitions = buildDefinitions(spec);
  const routes: ExtractedRouteSchemas['routes'] = {};

  if (!spec.paths)
    return { definitions, routes };

  for (const [path, pathItem] of Object.entries(spec.paths)) {
    if (!pathItem || typeof pathItem !== 'object')
      continue;

    const methodDefs: Record<string, {
      body?: JSONSchemaDefinition;
      response?: JSONSchemaDefinition;
      errorResponse?: JSONSchemaDefinition;
      params?: JSONSchemaDefinition;
      query?: JSONSchemaDefinition;
    }> = {};

    for (const [method, rawOperation] of Object.entries(pathItem as Record<string, unknown>)) {
      if (!HTTP_METHODS.has(method))
        continue;
      if (!rawOperation || typeof rawOperation !== 'object')
        continue;

      const operation = rawOperation as OpenAPIOperation;
      const schemas: typeof methodDefs[string] = {};

      const bodySchema = extractBodySchema(operation);
      if (bodySchema)
        schemas.body = bodySchema;

      const responseSchema = extractResponseSchema(operation);
      if (responseSchema)
        schemas.response = responseSchema;

      const errorSchema = extractErrorSchema(operation);
      if (errorSchema)
        schemas.errorResponse = errorSchema;

      const params = extractParams(operation, 'path');
      if (params)
        schemas.params = params;

      const query = extractParams(operation, 'query');
      if (query)
        schemas.query = query;

      if (Object.keys(schemas).length > 0) {
        methodDefs[method.toUpperCase()] = schemas;
      }
    }

    if (Object.keys(methodDefs).length > 0) {
      routes[path] = methodDefs;
    }
  }

  return { definitions, routes };
}
