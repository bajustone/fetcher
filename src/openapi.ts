/**
 * OpenAPI 3.x adapter — converts a spec into a `Routes` table that
 * {@link createFetch} can consume, with JSON Schema validation on every
 * body, params, query, and response.
 *
 * @module
 */

import type { JSONSchemaDefinition } from './json-schema-validator.ts';
import type { HttpMethod, InferRoutesFromSpec, RouteDefinition, Routes } from './types.ts';
import { JSONSchemaValidator } from './json-schema-validator.ts';

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
        routeDef.body = new JSONSchemaValidator(bodySchema, definitions);
      }

      // Response schema (first 2xx response)
      const responseSchema = extractResponseSchema(operation);
      if (responseSchema) {
        routeDef.response = new JSONSchemaValidator(
          responseSchema,
          definitions,
        );
      }

      // Error response schema (first 4xx/5xx)
      const errorSchema = extractErrorSchema(operation);
      if (errorSchema) {
        routeDef.errorResponse = new JSONSchemaValidator(
          errorSchema,
          definitions,
        );
      }

      // Path + query parameters
      const params = extractParams(operation, 'path');
      if (params) {
        routeDef.params = new JSONSchemaValidator(params, definitions);
      }

      const query = extractParams(operation, 'query');
      if (query) {
        routeDef.query = new JSONSchemaValidator(query, definitions);
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

/** Build a flat definitions map for $ref resolution */
function buildDefinitions(
  spec: OpenAPISpec,
): Record<string, JSONSchemaDefinition> {
  const defs: Record<string, Record<string, JSONSchemaDefinition>> = {};
  if (spec.components?.schemas) {
    defs.components = { schemas: spec.components.schemas as unknown as JSONSchemaDefinition } as unknown as Record<string, JSONSchemaDefinition>;
    // Flatten for easier resolution: components/schemas/Foo
    const flat: Record<string, JSONSchemaDefinition> = {};
    for (const [name, schema] of Object.entries(spec.components.schemas)) {
      flat.components ??= {} as unknown as JSONSchemaDefinition;
      (flat as Record<string, Record<string, unknown>>).components!.schemas ??= {};
      (
        (flat as Record<string, Record<string, Record<string, unknown>>>).components!.schemas!
      )[name] = schema;
    }
    return flat;
  }
  return {};
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
