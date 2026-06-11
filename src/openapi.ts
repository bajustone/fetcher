/**
 * OpenAPI 3.x adapter — converts a spec into a `Routes` table that
 * {@link createFetch} can consume, with JSON Schema validation on every
 * body, params, query, and response.
 *
 * @module
 */

import type { JSONSchemaDefinition } from './json-schema-types.ts';
import type { HttpMethod, InferRoutesFromSpec, RouteDefinition, Routes } from './types.ts';
import { FETCHER_COERCE_MARKER, FETCHER_OPTIONAL_MARKER, fromJSONSchema } from './from-json-schema.ts';

/**
 * Raw schema data extracted from an OpenAPI spec — the build-time
 * counterpart of the runtime `Routes` object. Contains only the JSON
 * Schema nodes needed for validation, not the full spec.
 *
 * Used by the Vite/Rollup plugin to inline schemas at build time so the
 * full OpenAPI spec is never shipped to the client bundle.
 *
 * Two vendor-extension markers may appear on emitted schema roots and are
 * honored by `fromJSONSchema` when the validators are reconstructed:
 * `x-fetcher-optional` (optional request body — the validator accepts
 * `undefined`) and `x-fetcher-coerce` (params/query property names whose
 * numeric strings are coerced before validation).
 */
export interface ExtractedRouteSchemas {
  /** Component schemas referenced by the routes, keyed by component name. */
  definitions: Record<string, JSONSchemaDefinition>;
  /** Per-path, per-method JSON Schema nodes for each validation slot. */
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
    /**
     * Component schemas. The value type is `any` (like `paths`) so that
     * both widened JSON imports and `as const` literal specs — whose
     * `required: readonly [...]` tuples are not assignable to the mutable
     * arrays in {@link JSONSchemaDefinition} — satisfy the constraint
     * without a cast. A failed constraint here would silently collapse
     * {@link InferRoutesFromSpec}'s call-site inference to `unknown`.
     */
    schemas?: { [name: string]: any };
    [key: string]: any;
  };
  [key: string]: any;
}

/**
 * Internal narrowed shape for an OpenAPI operation. Only the fields this
 * adapter reads are named; the parser is defensive about missing/extra
 * fields via optional chaining. `requestBody` / individual responses /
 * individual parameters may each be a `{ $ref }` to a component — these
 * are resolved by {@link normalizeOperation} before extraction.
 */
interface OpenAPIOperation {
  requestBody?: OpenAPIRequestBody | OpenAPIRefNode;
  responses?: Record<string, OpenAPIResponse | OpenAPIRefNode>;
  parameters?: Array<OpenAPIParameter | OpenAPIRefNode>;
}

/** A `{ $ref: '#/components/...' }` placeholder at the operation level. */
interface OpenAPIRefNode {
  $ref?: string;
  [key: string]: unknown;
}

/** Internal narrowed shape for an OpenAPI request-body object. */
interface OpenAPIRequestBody {
  required?: boolean;
  content?: Record<string, { schema?: JSONSchemaDefinition }>;
}

/** Internal narrowed shape for an OpenAPI response object. */
interface OpenAPIResponse {
  content?: Record<string, { schema?: JSONSchemaDefinition }>;
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

/** Fully dereferenced operation, ready for schema extraction. */
interface NormalizedOperation {
  requestBody?: OpenAPIRequestBody;
  responses?: Record<string, OpenAPIResponse>;
  parameters?: OpenAPIParameter[];
}

const HTTP_METHODS: Set<string> = new Set([
  'get',
  'post',
  'put',
  'delete',
  'patch',
  'head',
  'options',
]);

// ---------------------------------------------------------------------------
// Operation-level $ref resolution (requestBodies / responses / parameters)
// ---------------------------------------------------------------------------

const REF_PREFIX = /^#\//;
const UNESCAPE_SLASH = /~1/g;
const UNESCAPE_TILDE = /~0/g;

function unescapePointer(token: string): string {
  return token.replace(UNESCAPE_SLASH, '/').replace(UNESCAPE_TILDE, '~');
}

/** RFC 6901 JSON-pointer walk over the spec document. Local refs only. */
function resolvePointer(spec: OpenAPISpec, ref: string): unknown {
  const parts = ref.replace(REF_PREFIX, '').split('/').map(unescapePointer);
  let current: unknown = spec;
  for (const part of parts) {
    if (current !== null && typeof current === 'object' && Object.hasOwn(current, part))
      current = (current as Record<string, unknown>)[part];
    else
      return undefined;
  }
  return current;
}

/**
 * Resolves an operation-level `$ref` chain (`requestBody`, a single
 * response, or a single parameter expressed as
 * `{ $ref: '#/components/requestBodies/X' }` etc.) against the spec.
 *
 * - Cyclic chains throw a clear `Error` naming the cycle — a cyclic
 *   operation-level ref is a malformed spec, and silently dropping it
 *   would strip runtime validation while the type layer still claims it.
 * - External (`./other.yaml#/...`) or unresolvable refs emit a
 *   `console.warn` and resolve to `undefined` (the slot is skipped), so a
 *   partially-external spec still produces validators for everything else
 *   instead of failing the whole build.
 */
function resolveOperationNode<T extends object>(
  spec: OpenAPISpec,
  node: T | OpenAPIRefNode | undefined,
  context: string,
): T | undefined {
  let current: unknown = node;
  const seen = new Set<string>();
  while (
    current !== null
    && typeof current === 'object'
    && typeof (current as OpenAPIRefNode).$ref === 'string'
  ) {
    const ref = (current as OpenAPIRefNode).$ref as string;
    if (seen.has(ref)) {
      throw new Error(
        `fromOpenAPI: cyclic operation-level $ref detected at ${context}: `
        + `${[...seen, ref].join(' -> ')}`,
      );
    }
    seen.add(ref);
    if (!ref.startsWith('#/')) {
      console.warn(
        `[fetcher] fromOpenAPI: external $ref "${ref}" at ${context} cannot be resolved — `
        + `the slot is skipped and will not be validated at runtime. Bundle the spec first.`,
      );
      return undefined;
    }
    current = resolvePointer(spec, ref);
    if (current === undefined) {
      console.warn(
        `[fetcher] fromOpenAPI: unresolved $ref "${ref}" at ${context} — `
        + `the slot is skipped and will not be validated at runtime.`,
      );
      return undefined;
    }
  }
  if (current === null || typeof current !== 'object')
    return undefined;
  return current as T;
}

/**
 * Dereferences operation-level `$ref`s and merges path-item-level
 * `parameters` (shared across all methods of a path, per the OpenAPI spec)
 * with operation-level ones. Operation-level parameters win on a
 * `name` + `in` collision.
 */
function normalizeOperation(
  spec: OpenAPISpec,
  rawOperation: OpenAPIOperation,
  pathItemParameters: unknown,
  context: string,
): NormalizedOperation {
  const out: NormalizedOperation = {};

  const requestBody = resolveOperationNode<OpenAPIRequestBody>(
    spec,
    rawOperation.requestBody,
    `${context}.requestBody`,
  );
  if (requestBody)
    out.requestBody = requestBody;

  if (rawOperation.responses && typeof rawOperation.responses === 'object') {
    const responses: Record<string, OpenAPIResponse> = Object.create(null) as Record<string, OpenAPIResponse>;
    let any = false;
    for (const [code, rawResponse] of Object.entries(rawOperation.responses)) {
      const resolved = resolveOperationNode<OpenAPIResponse>(
        spec,
        rawResponse,
        `${context}.responses.${code}`,
      );
      if (resolved) {
        responses[code] = resolved;
        any = true;
      }
    }
    if (any)
      out.responses = responses;
  }

  const merged: OpenAPIParameter[] = [];
  const slotByKey = new Map<string, number>();
  const addParameters = (list: unknown, from: string): void => {
    if (!Array.isArray(list))
      return;
    for (const rawParam of list) {
      const resolved = resolveOperationNode<OpenAPIParameter>(
        spec,
        rawParam as OpenAPIParameter | OpenAPIRefNode,
        `${from}.parameters`,
      );
      if (!resolved || typeof resolved.name !== 'string' || typeof resolved.in !== 'string')
        continue;
      const key = `${resolved.in}:${resolved.name}`;
      const existing = slotByKey.get(key);
      if (existing !== undefined)
        merged[existing] = resolved; // operation-level overrides path-level
      else
        slotByKey.set(key, merged.push(resolved) - 1);
    }
  };
  // Path-item parameters first, then operation parameters so the latter win.
  addParameters(pathItemParameters, context.slice(0, context.lastIndexOf('.')));
  addParameters(rawOperation.parameters, context);
  if (merged.length > 0)
    out.parameters = merged;

  return out;
}

// ---------------------------------------------------------------------------
// Media-type matching
// ---------------------------------------------------------------------------

/**
 * Picks the JSON-bearing entry from a `content` map. Media types are
 * matched structurally (parameters such as `; charset=utf-8` are
 * stripped): exact `application/json` wins over structured-suffix
 * `application/*+json` types (`problem+json`, `vnd.api+json`, `hal+json`,
 * ...), which win over the `*\/*` wildcard.
 */
function pickJsonContent(
  content: Record<string, { schema?: JSONSchemaDefinition }> | undefined,
): { schema?: JSONSchemaDefinition } | null {
  if (!content || typeof content !== 'object')
    return null;
  let suffixMatch: { schema?: JSONSchemaDefinition } | null = null;
  for (const [key, value] of Object.entries(content)) {
    if (!value || typeof value !== 'object')
      continue;
    const mime = key.split(';', 1)[0]!.trim().toLowerCase();
    if (mime === 'application/json')
      return value;
    if (suffixMatch === null && mime.startsWith('application/') && mime.endsWith('+json'))
      suffixMatch = value;
  }
  return suffixMatch ?? content['*/*'] ?? null;
}

/**
 * Converts an OpenAPI 3.x spec into typed route definitions with built-in
 * JSON Schema validators. One JSON spec gives you type safety + runtime
 * validation with zero external dependencies.
 *
 * Generic over the literal spec type: when called with an `as const` JSON
 * import (or any literal-typed object), the return type is narrowed to the
 * spec's actual paths and methods via {@link InferRoutesFromSpec}, and the
 * body / response / errorResponse types inferred from the spec's JSON
 * Schemas flow through `createFetch({ routes: fromOpenAPI(spec) })` to the
 * call sites — `result.data` and the `body` option are typed without
 * codegen.
 *
 * Runtime behavior notes:
 *
 * - Operation-level `$ref`s (`requestBody`/`responses`/`parameters`
 *   pointing into `components.requestBodies` etc.) are resolved before
 *   extraction. Cyclic refs throw; unresolvable refs warn and skip.
 * - Path-item-level `parameters` are merged into every operation
 *   (operation-level wins on `name`+`in`).
 * - A `default` response is the error catch-all: it feeds `errorResponse`
 *   when no explicit 4xx/5xx JSON response exists, and never the success
 *   `response` slot.
 * - Optional request bodies (the OpenAPI default) produce validators that
 *   accept `undefined`, since `createFetch` validates the body whenever a
 *   schema is declared.
 * - Integer/number path & query parameters coerce numeric strings before
 *   validation (parameters arrive as strings on the wire). Bodies never
 *   coerce.
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
  const routes: Routes = Object.create(null) as Routes;

  if (!spec.paths)
    return routes as InferRoutesFromSpec<Spec>;

  for (const [path, pathItem] of Object.entries(spec.paths)) {
    if (!pathItem || typeof pathItem !== 'object')
      continue;

    const methodDefs: Partial<Record<HttpMethod, RouteDefinition>> = {};
    const pathItemParameters = (pathItem as Record<string, unknown>).parameters;

    for (const [method, rawOperation] of Object.entries(pathItem as Record<string, unknown>)) {
      if (!HTTP_METHODS.has(method))
        continue;
      if (!rawOperation || typeof rawOperation !== 'object')
        continue;

      // Boundary cast: the public OpenAPISpec input is loose so JSON
      // imports satisfy it; from here on we work with the tight internal
      // OpenAPIOperation shape that the parsing helpers expect.
      const operation = normalizeOperation(
        spec,
        rawOperation as OpenAPIOperation,
        pathItemParameters,
        `${path}.${method}`,
      );
      const routeDef: RouteDefinition = {};

      // Request body schema
      const bodyExtraction = extractBodySchema(operation);
      if (bodyExtraction) {
        routeDef.body = fromJSONSchema(
          markOptionalBody(bodyExtraction.schema, bodyExtraction.required),
          definitions,
        );
      }

      // Response schema (first 2xx response with JSON content)
      const responseSchema = extractResponseSchema(operation);
      if (responseSchema) {
        routeDef.response = fromJSONSchema(responseSchema, definitions);
      }

      // Error response schema (first 4xx/5xx; `default` as the catch-all)
      const errorSchema = extractErrorSchema(operation);
      if (errorSchema) {
        routeDef.errorResponse = fromJSONSchema(errorSchema, definitions);
      }

      // Path + query parameters
      const params = extractParams(operation, 'path', definitions);
      if (params) {
        routeDef.params = fromJSONSchema(params, definitions);
      }

      const query = extractParams(operation, 'query', definitions);
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
  // Null-prototype output: keys are spec-controlled, and a property named
  // '__proto__' (e.g. inside a `properties` map) must be copied as an own
  // key instead of triggering the prototype setter.
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

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
  const root = Object.hasOwn(translatedComponents, name)
    ? translatedComponents[name]
    : undefined;
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
    const merged: Record<string, JSONSchemaDefinition> = Object.assign(
      Object.create(null) as Record<string, JSONSchemaDefinition>,
      existingDefs ?? {},
    );
    for (const reachedName of reached) {
      const target = Object.hasOwn(translatedComponents, reachedName)
        ? translatedComponents[reachedName]
        : undefined;
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
      if (Object.hasOwn(components, target))
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
  // Null-prototype output for the same '__proto__'-safety reason as
  // translateNode.
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
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
  // Null-prototype accumulators: component names are spec-controlled and a
  // component literally named '__proto__' must not be silently dropped (or
  // worse, mutate the accumulator's prototype).
  const translated: Record<string, JSONSchemaDefinition>
    = Object.create(null) as Record<string, JSONSchemaDefinition>;
  for (const [name, schema] of Object.entries(rawComponents))
    translated[name] = translateDialect(schema);

  const schemas: Record<string, JSONSchemaDefinition>
    = Object.create(null) as Record<string, JSONSchemaDefinition>;
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

/**
 * Returns the request-body JSON schema plus whether the spec marks the
 * body required. OpenAPI defaults `requestBody.required` to `false`, so
 * anything other than literal `true` is optional.
 */
function extractBodySchema(
  operation: NormalizedOperation,
): { schema: JSONSchemaDefinition; required: boolean } | null {
  const requestBody = operation.requestBody;
  if (!requestBody?.content)
    return null;
  const jsonContent = pickJsonContent(requestBody.content);
  if (!jsonContent?.schema)
    return null;
  return { schema: jsonContent.schema, required: requestBody.required === true };
}

/**
 * Removes any spec-supplied `x-fetcher-optional` / `x-fetcher-coerce`
 * markers from an extracted schema root. The markers are an internal
 * contract between the extractors and `fromJSONSchema` — a third-party
 * spec carrying them must not be able to disable required-body
 * enforcement or enable body coercion. Returns the input untouched when
 * no marker is present.
 */
function stripFetcherMarkers(schema: JSONSchemaDefinition): JSONSchemaDefinition {
  if (
    !Object.hasOwn(schema, FETCHER_OPTIONAL_MARKER)
    && !Object.hasOwn(schema, FETCHER_COERCE_MARKER)
  ) {
    return schema;
  }
  const out = { ...schema } as Record<string, unknown>;
  delete out[FETCHER_OPTIONAL_MARKER];
  delete out[FETCHER_COERCE_MARKER];
  return out as JSONSchemaDefinition;
}

/**
 * Tags an optional request-body schema with the `x-fetcher-optional`
 * marker so `fromJSONSchema` compiles a validator that accepts
 * `undefined`. Required bodies pass through with any spec-supplied
 * markers stripped — only the extractor may emit markers.
 */
function markOptionalBody(
  schema: JSONSchemaDefinition,
  required: boolean,
): JSONSchemaDefinition {
  const clean = stripFetcherMarkers(schema);
  if (required)
    return clean;
  return { ...clean, [FETCHER_OPTIONAL_MARKER]: true };
}

function extractResponseSchema(
  operation: NormalizedOperation,
): JSONSchemaDefinition | null {
  if (!operation.responses)
    return null;
  // First 2xx response with JSON content. `default` is intentionally NOT a
  // success candidate — it's the error catch-all (see extractErrorSchema),
  // matching `OpenAPIErrorStatus` in types.ts and spec-tools' isErrorStatus.
  for (const [code, response] of Object.entries(operation.responses)) {
    if (code.startsWith('2')) {
      const jsonContent = pickJsonContent(response.content);
      if (jsonContent?.schema)
        return stripFetcherMarkers(jsonContent.schema);
    }
  }
  return null;
}

function extractErrorSchema(
  operation: NormalizedOperation,
): JSONSchemaDefinition | null {
  if (!operation.responses)
    return null;
  for (const [code, response] of Object.entries(operation.responses)) {
    if (code.startsWith('4') || code.startsWith('5')) {
      const jsonContent = pickJsonContent(response.content);
      if (jsonContent?.schema)
        return stripFetcherMarkers(jsonContent.schema);
    }
  }
  // No explicit 4xx/5xx with JSON content — `default` is the catch-all
  // error per OpenAPI convention (and per this library's type layer).
  const defaultResponse = operation.responses.default;
  if (defaultResponse) {
    const jsonContent = pickJsonContent(defaultResponse.content);
    if (jsonContent?.schema)
      return stripFetcherMarkers(jsonContent.schema);
  }
  return null;
}

/**
 * Follows a `$ref` chain through the flat definitions map (by last path
 * segment) so parameter schemas expressed as refs can still drive numeric
 * coercion detection. Cycle-safe; returns `undefined` on a broken chain.
 */
function resolveSchemaNode(
  schema: JSONSchemaDefinition | undefined,
  definitions: Record<string, JSONSchemaDefinition>,
  seen: Set<string> = new Set(),
): JSONSchemaDefinition | undefined {
  let current = schema;
  while (current && typeof current.$ref === 'string') {
    const ref = current.$ref;
    if (seen.has(ref))
      return undefined;
    seen.add(ref);
    const idx = ref.lastIndexOf('/');
    const name = idx >= 0 ? ref.slice(idx + 1) : ref;
    current = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  }
  return current;
}

/**
 * True when a parameter schema is unambiguously numeric (`integer` /
 * `number`, directly or as the sole non-null member of a 3.1 type array,
 * or an array of such items). Schemas that also admit strings are NOT
 * coercible — coercion would change the meaning of valid string input.
 *
 * One `seen` set is shared across the whole walk — both the `$ref` chain
 * resolution and the `items` recursion — so a self-referential array
 * component (`A = { type: 'array', items: { $ref: A } }`) terminates
 * (returning `false`, no coercion) instead of recursing forever.
 */
function isNumericParamSchema(
  schema: JSONSchemaDefinition | undefined,
  definitions: Record<string, JSONSchemaDefinition>,
  seen: Set<string> = new Set(),
): boolean {
  const resolved = resolveSchemaNode(schema, definitions, seen);
  if (!resolved)
    return false;
  const type = resolved.type;
  if (type === 'integer' || type === 'number')
    return true;
  if (Array.isArray(type)) {
    // A type union admitting 'string' never coerces — a string value is
    // legitimate there, and coercing it would corrupt valid input.
    if (type.includes('string'))
      return false;
    if (type.includes('integer') || type.includes('number'))
      return true;
    // Nullable arrays (type: ['array', 'null']) coerce by their items,
    // exactly like the plain type === 'array' branch below.
    if (type.includes('array'))
      return isNumericParamSchema(resolved.items, definitions, seen);
    return false;
  }
  if (type === 'array')
    return isNumericParamSchema(resolved.items, definitions, seen);
  return false;
}

/**
 * Builds the object schema for the `path` or `query` parameters of an
 * operation. Properties whose schemas are numeric are listed under the
 * `x-fetcher-coerce` marker so the compiled validator coerces numeric
 * strings (parameters arrive as strings on the wire).
 */
function extractParams(
  operation: NormalizedOperation,
  location: 'path' | 'query',
  definitions: Record<string, JSONSchemaDefinition>,
): JSONSchemaDefinition | null {
  const params = operation.parameters?.filter(p => p.in === location);
  if (!params || params.length === 0)
    return null;

  // Null-prototype accumulator — parameter names are spec-controlled.
  const properties: Record<string, JSONSchemaDefinition>
    = Object.create(null) as Record<string, JSONSchemaDefinition>;
  const required: string[] = [];
  const coerce: string[] = [];

  for (const param of params) {
    // Strip any spec-supplied x-fetcher-* markers — only the extractor may
    // emit them (the root marker below is built from scratch, so the root
    // itself is already extractor-owned).
    properties[param.name] = stripFetcherMarkers(param.schema ?? { type: 'string' });
    if (param.required) {
      required.push(param.name);
    }
    if (isNumericParamSchema(param.schema, definitions)) {
      coerce.push(param.name);
    }
  }

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    ...(coerce.length > 0 ? { [FETCHER_COERCE_MARKER]: coerce } : {}),
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
 *
 * Mirrors {@link fromOpenAPI}'s extraction semantics exactly: operation-
 * level `$ref` resolution, path-item parameter merging, `default`-as-error,
 * `+json` media types, the `x-fetcher-optional` marker on optional request
 * bodies, and the `x-fetcher-coerce` marker on numeric params/query
 * properties (both honored by `fromJSONSchema` at reconstruction time).
 */
export function extractRouteSchemas(spec: OpenAPISpec): ExtractedRouteSchemas {
  const definitions = buildDefinitions(spec);
  const routes: ExtractedRouteSchemas['routes'] = Object.create(null) as ExtractedRouteSchemas['routes'];

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
    const pathItemParameters = (pathItem as Record<string, unknown>).parameters;

    for (const [method, rawOperation] of Object.entries(pathItem as Record<string, unknown>)) {
      if (!HTTP_METHODS.has(method))
        continue;
      if (!rawOperation || typeof rawOperation !== 'object')
        continue;

      const operation = normalizeOperation(
        spec,
        rawOperation as OpenAPIOperation,
        pathItemParameters,
        `${path}.${method}`,
      );
      const schemas: typeof methodDefs[string] = {};

      const bodyExtraction = extractBodySchema(operation);
      if (bodyExtraction)
        schemas.body = markOptionalBody(bodyExtraction.schema, bodyExtraction.required);

      const responseSchema = extractResponseSchema(operation);
      if (responseSchema)
        schemas.response = responseSchema;

      const errorSchema = extractErrorSchema(operation);
      if (errorSchema)
        schemas.errorResponse = errorSchema;

      const params = extractParams(operation, 'path', definitions);
      if (params)
        schemas.params = params;

      const query = extractParams(operation, 'query', definitions);
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
