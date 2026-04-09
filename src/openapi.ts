import type { JSONSchemaDefinition } from './json-schema-validator.ts';
import type { HttpMethod, RouteDefinition, Routes } from './types.ts';
import { JSONSchemaValidator } from './json-schema-validator.ts';

interface OpenAPISpec {
  openapi: string;
  paths?: Record<string, Record<string, OpenAPIOperation>>;
  components?: {
    schemas?: Record<string, JSONSchemaDefinition>;
  };
}

interface OpenAPIOperation {
  requestBody?: {
    content?: Record<
      string,
      { schema?: JSONSchemaDefinition }
    >;
  };
  responses?: Record<
    string,
    {
      content?: Record<
        string,
        { schema?: JSONSchemaDefinition }
      >;
    }
  >;
  parameters?: OpenAPIParameter[];
}

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
 * ```typescript
 * import spec from './openapi.json'
 * const routes = fromOpenAPI(spec)
 * const f = createFetch({ baseUrl: '...', routes })
 * ```
 */
export function fromOpenAPI(spec: OpenAPISpec): Routes {
  const definitions = buildDefinitions(spec);
  const routes: Routes = {};

  if (!spec.paths)
    return routes;

  for (const [path, pathItem] of Object.entries(spec.paths)) {
    const methodDefs: Partial<Record<HttpMethod, RouteDefinition>> = {};

    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method))
        continue;

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

  return routes;
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
