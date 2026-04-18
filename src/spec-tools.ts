/**
 * Spec tools — runtime helpers for inspecting an OpenAPI 3.x spec against
 * fetcher's runtime validator subset and a notional "simple" schema subset.
 *
 * Two complementary library functions, sharing one visitor:
 *
 * - {@link lintSpec} flags every keyword usage the runtime
 *   `JSONSchemaValidator` does NOT enforce (e.g., `format: 'email'`,
 *   `multipleOf`, `patternProperties`, `if`/`then`/`else`). Use as a CI gate
 *   so "type says one thing, runtime accepts another" never reaches prod.
 *
 * - {@link coverage} reports per-route which slots a hypothetical zero-codegen
 *   type-level converter (referred to as "Tier 0" throughout — see the
 *   architecture doc's "Why no zero-codegen OpenAPI inference?" for status)
 *   could type, with reasons for any fallbacks. Useful as a pre-flight check
 *   on what schema features your spec actually uses.
 *
 * Both functions take a loosely-typed `unknown` spec so JSON-imported specs
 * with extra fields satisfy the input. Internal walking is defensive about
 * missing/extra fields. Zero runtime dependencies.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single drift between the spec and the runtime validator's supported
 * subset. See {@link lintSpec}.
 */
export interface SpecDriftIssue {
  /**
   * RFC 6901 JSON Pointer to the offending node, rooted at the spec.
   * Example: `'#/components/schemas/User/properties/email/format'`.
   */
  pointer: string;
  /** Unsupported keyword name, e.g. `'format'`, `'multipleOf'`, `'patternProperties'`. */
  keyword: string;
  /**
   * `'warn'` for keywords that silently lie at runtime (e.g., `format: 'email'`
   * types as `string` and runtime accepts non-emails). `'info'` for keywords
   * that are merely accepted-but-ignored annotations.
   */
  severity: 'warn' | 'info';
  /** Human-readable explanation including what the runtime does instead. */
  message: string;
}

/**
 * Spec-integrity issue detected by {@link coverage} — a discriminator
 * mismatch, a `required` key with no matching property, or a response
 * with content in a media type fetcher won't consume.
 */
export interface IntegrityIssue {
  /**
   * Category of the issue. `discriminator_mismatch` — a `oneOf` variant
   * lacks the discriminator key or has a non-`const`/single-`enum` value;
   * `discriminator_duplicate` — two variants share the same tag;
   * `required_without_property` — an `object` schema lists a key in
   * `required` that isn't in `properties`; `unreachable_response` — a
   * response declares `content` but no `application/json` or wildcard
   * (`*` `/` `*`) media type (fetcher's default extractors only match those two).
   */
  kind:
    | 'discriminator_mismatch'
    | 'discriminator_duplicate'
    | 'required_without_property'
    | 'unreachable_response';
  /** RFC 6901 JSON Pointer to the node, rooted at the spec. */
  pointer: string;
  /** Human-readable explanation. */
  message: string;
}

/** Per-route Tier 0 type-level inference readiness. See {@link coverage}. */
export interface RouteCoverage {
  path: string;
  method: string;
  /**
   * True when `JSONSchemaToType` can produce a typed body, OR when the
   * route declares no request body (vacuous true). False only when a body
   * schema is declared and the converter can't type it.
   */
  bodyTyped: boolean;
  /**
   * True when `JSONSchemaToType` can produce a typed success response, OR
   * when no 2xx JSON response is declared.
   */
  responseTyped: boolean;
  /**
   * True when `JSONSchemaToType` can produce a typed error response, OR
   * when no 4xx/5xx/`default` JSON response is declared.
   */
  errorTyped: boolean;
  /**
   * Reasons each slot fell back to `unknown` (empty when fully typed).
   * Examples: `'patternProperties in response schema'`,
   * `'recursive $ref detected at #/components/schemas/Tree in body schema'`.
   */
  fallbackReasons: string[];
  /**
   * Runtime-unsupported keywords this route uses transitively (via `$ref`).
   * Deduped across body / response / error slots. Keywords here are
   * accepted-but-unenforced at runtime — the spec declares a constraint
   * the validator silently ignores.
   */
  unsupportedKeywords: string[];
  /**
   * Spec-integrity issues detected for this route. Empty when the route
   * is internally consistent.
   */
  integrityIssues: IntegrityIssue[];
}

/** Aggregate report from {@link coverage}. */
export interface SpecCoverageReport {
  routes: RouteCoverage[];
  summary: {
    /** Total routes (path × declared method). */
    total: number;
    /** Routes where every applicable slot is typed by `JSONSchemaToType`. */
    fullyTyped: number;
    /** Routes where at least one slot is typed but at least one falls back. */
    partial: number;
    /** Routes where no slot is typed. */
    untyped: number;
    /** Routes with at least one entry in `integrityIssues`. */
    withIntegrityIssues: number;
  };
}

// ---------------------------------------------------------------------------
// Validator subset (drives lintSpec)
// ---------------------------------------------------------------------------

/**
 * Keywords the runtime `JSONSchemaValidator` does NOT enforce. Mirrors the
 * "Not supported (intentionally)" table in `docs/architecture.md`.
 *
 * The presence of any of these keys in a schema node produces a
 * {@link SpecDriftIssue}. Two special-case keywords (`additionalProperties`
 * with a sub-schema value; `items` with an array value) are handled inline
 * in {@link walkSchema}.
 */
/**
 * Formats that have a matching builder helper in `@bajustone/fetcher/schema`.
 * Used to enrich the `lintSpec` drift message with a concrete fix.
 */
const BUILDER_FORMAT_HELPERS: Readonly<Record<string, string>> = {
  'email': 'email()',
  'uri': 'url()',
  'url': 'url()',
  'uuid': 'uuid()',
  'date-time': 'datetime()',
  'date': 'date()',
  'time': 'time()',
};

const UNSUPPORTED_KEYWORDS: Record<string, { severity: 'warn' | 'info'; message: string }> = {
  format: {
    severity: 'warn',
    message: 'format validators (email, uri, date-time, etc.) are not enforced at runtime — runtime accepts any string.',
  },
  multipleOf: {
    severity: 'warn',
    message: 'multipleOf is not enforced at runtime.',
  },
  exclusiveMinimum: {
    severity: 'warn',
    message: 'exclusiveMinimum is not enforced at runtime — minimum is treated as inclusive.',
  },
  exclusiveMaximum: {
    severity: 'warn',
    message: 'exclusiveMaximum is not enforced at runtime — maximum is treated as inclusive.',
  },
  patternProperties: {
    severity: 'warn',
    message: 'patternProperties is not enforced at runtime — additional properties are accepted unconstrained.',
  },
  propertyNames: {
    severity: 'warn',
    message: 'propertyNames is not enforced at runtime — additional property keys are accepted unconstrained.',
  },
  if: {
    severity: 'warn',
    message: 'Conditional schemas (if/then/else) are not enforced at runtime — both branches are accepted.',
  },
  then: {
    severity: 'info',
    message: 'Conditional then-branch is not enforced at runtime (paired with if).',
  },
  else: {
    severity: 'info',
    message: 'Conditional else-branch is not enforced at runtime (paired with if).',
  },
  dependentSchemas: {
    severity: 'warn',
    message: 'dependentSchemas is not enforced at runtime.',
  },
  dependentRequired: {
    severity: 'warn',
    message: 'dependentRequired is not enforced at runtime.',
  },
  prefixItems: {
    severity: 'warn',
    message: 'Tuple-typed arrays (prefixItems) are not enforced at runtime — every element is checked against `items`.',
  },
  additionalItems: {
    severity: 'warn',
    message: 'additionalItems is not enforced at runtime (paired with positional `items`).',
  },
  $id: {
    severity: 'info',
    message: '$id is accepted but unused — only intra-spec $ref is supported.',
  },
  $schema: {
    severity: 'info',
    message: '$schema is accepted but unused.',
  },
};

// ---------------------------------------------------------------------------
// Tier 0 inference subset (drives coverage)
// ---------------------------------------------------------------------------

/**
 * Keywords that would defeat a notional zero-codegen "Tier 0" type-level
 * converter. When any of these appears in a route's body / response /
 * errorResponse schema (transitively, after `$ref` resolution),
 * {@link coverage} marks the slot as a fallback.
 *
 * The Tier 0 converter itself is not implemented and is unlikely to ship
 * (see `docs/architecture.md` → "Why no zero-codegen OpenAPI inference?"
 * for the structural blocker on JSON-import literal preservation). This
 * constant is kept because (a) it documents which schema features the
 * `<paths>` flow handles that a hand-rolled converter wouldn't, and
 * (b) it would become directly load-bearing if TypeScript ever ships
 * literal-preserving JSON imports ([microsoft/TypeScript#32063](https://github.com/microsoft/TypeScript/issues/32063)).
 */
/**
 * Keywords that defeat the v0.4.0 `JSONSchemaToType` type-level converter
 * (src/infer-spec.ts). When any of these appears in a route's body /
 * response / errorResponse schema (transitively, after `$ref` resolution),
 * {@link coverage} marks the slot as a typing fallback.
 *
 * `anyOf` / `oneOf` / `allOf` are NOT blockers — `JSONSchemaToType` handles
 * them via union / intersection. They used to be listed here; removed in
 * v0.7.0 as part of aligning coverage with real inference capabilities.
 */
const TIER_0_BLOCKER_KEYWORDS: ReadonlyArray<string> = [
  'patternProperties',
  'propertyNames',
  'prefixItems',
  'if',
  'then',
  'else',
  'dependentSchemas',
  'dependentRequired',
];

/**
 * Keywords the runtime does not enforce. Aggregated at route level into
 * `RouteCoverage.unsupportedKeywords` so CI output is grouped by route.
 */
const RUNTIME_UNSUPPORTED_KEYWORDS: ReadonlyArray<string> = [
  'format',
  'multipleOf',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'patternProperties',
  'propertyNames',
  'if',
  'then',
  'else',
  'dependentSchemas',
  'dependentRequired',
  'prefixItems',
  'additionalItems',
];

const HTTP_METHODS = new Set([
  'get',
  'post',
  'put',
  'delete',
  'patch',
  'options',
  'head',
  'trace',
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Walks an OpenAPI 3.x spec and returns every keyword usage the runtime
 * `JSONSchemaValidator` does NOT enforce. Use as a CI gate to surface
 * type-vs-runtime divergence before it reaches production.
 *
 * @example
 * ```typescript
 * import { lintSpec } from '@bajustone/fetcher';
 * import spec from './openapi.json' with { type: 'json' };
 *
 * const issues = lintSpec(spec);
 * if (issues.length > 0) {
 *   for (const i of issues)
 *     console.error(`${i.severity}: ${i.pointer} — ${i.message}`);
 *   process.exit(1);
 * }
 * ```
 */
export function lintSpec(spec: unknown): SpecDriftIssue[] {
  if (!spec || typeof spec !== 'object')
    return [];

  const driftIssues: SpecDriftIssue[] = [];

  // Walk every schema in components.schemas (covers reusable definitions
  // even if no operation references them).
  const componentsSchemas = (spec as Record<string, unknown>).components;
  if (componentsSchemas && typeof componentsSchemas === 'object') {
    const schemas = (componentsSchemas as Record<string, unknown>).schemas;
    if (schemas && typeof schemas === 'object') {
      for (const [name, schema] of Object.entries(schemas)) {
        walkForLint(schema, `#/components/schemas/${escapePointer(name)}`, driftIssues);
      }
    }
  }

  // Walk every operation's body / response / parameter schemas. Reused
  // schemas referenced by $ref will be walked again here, which produces
  // duplicate issues for the same source location — that's intentional:
  // the duplication makes the offending route easy to spot in CI output.
  const paths = (spec as Record<string, unknown>).paths;
  if (paths && typeof paths === 'object') {
    for (const [path, pathItem] of Object.entries(paths)) {
      if (!pathItem || typeof pathItem !== 'object')
        continue;
      const escapedPath = escapePointer(path);

      for (const [method, operation] of Object.entries(pathItem as Record<string, unknown>)) {
        if (!HTTP_METHODS.has(method))
          continue;
        if (!operation || typeof operation !== 'object')
          continue;
        const op = operation as Record<string, unknown>;
        const opPointer = `#/paths/${escapedPath}/${method}`;

        walkRequestBodyForLint(op.requestBody, `${opPointer}/requestBody`, driftIssues);
        walkResponsesForLint(op.responses, `${opPointer}/responses`, driftIssues);
        walkParametersForLint(op.parameters, `${opPointer}/parameters`, driftIssues);
      }
    }
  }

  return driftIssues;
}

/**
 * Walks an OpenAPI 3.x spec and reports per-route which body / response /
 * error slots a hypothetical zero-codegen "Tier 0" type-level converter
 * could type, with reasons for any fallbacks. Useful as a pre-flight check
 * on what schema features your spec actually uses (`oneOf`, `allOf`,
 * recursive `$ref`, etc.) and whether they're concentrated in a few routes
 * or spread across the surface.
 *
 * **Tier 0 status:** the type-level converter itself is *not* implemented
 * and is unlikely to ship. TypeScript intentionally widens string values on
 * JSON imports ([microsoft/TypeScript#32063](https://github.com/microsoft/TypeScript/issues/32063)),
 * which makes a leaf-level `JSONSchemaToType<S>` converter unable to
 * discriminate `{ "type": "integer" }` from `{ "type": "string" }` when
 * walking an imported JSON spec. See `docs/architecture.md` →
 * "Why no zero-codegen OpenAPI inference?" for the full discovery and the
 * relevant TS issues.
 *
 * The recommended path for typed body/response inference is the `<paths>`
 * workflow with `openapi-typescript`. `coverage()` is kept because it's
 * still useful as a spec-feature pre-flight check, and because it would
 * become directly load-bearing if TypeScript ever ships #32063.
 *
 * @example
 * ```typescript
 * import { coverage } from '@bajustone/fetcher';
 * import spec from './openapi.json' with { type: 'json' };
 *
 * const report = coverage(spec);
 * console.log(`${report.summary.fullyTyped}/${report.summary.total} routes use only the simple subset`);
 * for (const r of report.routes) {
 *   if (r.fallbackReasons.length > 0) {
 *     console.log(`  ${r.method} ${r.path}: ${r.fallbackReasons.join(', ')}`);
 *   }
 * }
 * ```
 */
export function coverage(spec: unknown): SpecCoverageReport {
  if (!spec || typeof spec !== 'object') {
    return {
      routes: [],
      summary: { total: 0, fullyTyped: 0, partial: 0, untyped: 0, withIntegrityIssues: 0 },
    };
  }

  const routes: RouteCoverage[] = [];
  const paths = (spec as Record<string, unknown>).paths;

  if (paths && typeof paths === 'object') {
    for (const [path, pathItem] of Object.entries(paths)) {
      if (!pathItem || typeof pathItem !== 'object')
        continue;
      const escapedPath = escapePointer(path);

      for (const [method, operation] of Object.entries(pathItem as Record<string, unknown>)) {
        if (!HTTP_METHODS.has(method))
          continue;
        if (!operation || typeof operation !== 'object')
          continue;
        const op = operation as Record<string, unknown>;
        const opPointer = `#/paths/${escapedPath}/${method}`;

        const bodySlot = walkBodySlot(spec, op.requestBody);
        const responseSlot = walkResponseSlot(spec, op.responses, 'response', isSuccessStatus);
        const errorSlot = walkResponseSlot(spec, op.responses, 'error', isErrorStatus);

        const fallbackReasons: string[] = [
          ...bodySlot.reasons,
          ...responseSlot.reasons,
          ...errorSlot.reasons,
        ];

        const unsupportedSet = new Set<string>();
        collectUnsupported(spec, op.requestBody, unsupportedSet);
        collectUnsupportedFromResponses(spec, op.responses, unsupportedSet);

        const integrityIssues: IntegrityIssue[] = [];
        checkIntegrityFromBody(spec, op.requestBody, `${opPointer}/requestBody`, integrityIssues);
        checkIntegrityFromResponses(spec, op.responses, `${opPointer}/responses`, integrityIssues);

        routes.push({
          path,
          method: method.toUpperCase(),
          bodyTyped: bodySlot.typed,
          responseTyped: responseSlot.typed,
          errorTyped: errorSlot.typed,
          fallbackReasons,
          unsupportedKeywords: Array.from(unsupportedSet).sort(),
          integrityIssues,
        });
      }
    }
  }

  let fullyTyped = 0;
  let partial = 0;
  let untyped = 0;
  let withIntegrityIssues = 0;
  for (const r of routes) {
    const slotsTyped = (r.bodyTyped ? 1 : 0) + (r.responseTyped ? 1 : 0) + (r.errorTyped ? 1 : 0);
    if (slotsTyped === 3)
      fullyTyped++;
    else if (slotsTyped === 0)
      untyped++;
    else
      partial++;
    if (r.integrityIssues.length > 0)
      withIntegrityIssues++;
  }

  return {
    routes,
    summary: {
      total: routes.length,
      fullyTyped,
      partial,
      untyped,
      withIntegrityIssues,
    },
  };
}

// ---------------------------------------------------------------------------
// Lint walkers (per-schema)
// ---------------------------------------------------------------------------

function walkRequestBodyForLint(
  requestBody: unknown,
  pointer: string,
  driftIssues: SpecDriftIssue[],
): void {
  const content = (requestBody as { content?: unknown } | undefined)?.content;
  if (!content || typeof content !== 'object')
    return;
  for (const [mediaType, mediaContent] of Object.entries(content as Record<string, unknown>)) {
    const schema = (mediaContent as { schema?: unknown } | undefined)?.schema;
    if (schema)
      walkForLint(schema, `${pointer}/content/${escapePointer(mediaType)}/schema`, driftIssues);
  }
}

function walkResponsesForLint(
  responses: unknown,
  pointer: string,
  driftIssues: SpecDriftIssue[],
): void {
  if (!responses || typeof responses !== 'object')
    return;
  for (const [status, response] of Object.entries(responses as Record<string, unknown>)) {
    const content = (response as { content?: unknown } | undefined)?.content;
    if (!content || typeof content !== 'object')
      continue;
    for (const [mediaType, mediaContent] of Object.entries(content as Record<string, unknown>)) {
      const schema = (mediaContent as { schema?: unknown } | undefined)?.schema;
      if (schema) {
        walkForLint(
          schema,
          `${pointer}/${escapePointer(status)}/content/${escapePointer(mediaType)}/schema`,
          driftIssues,
        );
      }
    }
  }
}

function walkParametersForLint(
  parameters: unknown,
  pointer: string,
  driftIssues: SpecDriftIssue[],
): void {
  if (!Array.isArray(parameters))
    return;
  parameters.forEach((param, i) => {
    const schema = (param as { schema?: unknown } | undefined)?.schema;
    if (schema)
      walkForLint(schema, `${pointer}/${i}/schema`, driftIssues);
  });
}

/**
 * Recursively walks a single schema node, accumulating drift issues for
 * every unsupported keyword found. Does NOT follow `$ref` (the target lives
 * in `components.schemas` and is walked separately by {@link lintSpec}'s
 * top-level loop, so following refs would only produce duplicates from a
 * different source pointer).
 */
function walkForLint(node: unknown, pointer: string, driftIssues: SpecDriftIssue[]): void {
  if (!node || typeof node !== 'object')
    return;
  const obj = node as Record<string, unknown>;

  // Skip $ref nodes — the target is reachable via components.schemas, walked
  // by lintSpec's top-level loop. Flag external refs as a drift issue, since
  // the runtime validator does not support them.
  if (typeof obj.$ref === 'string') {
    if (!obj.$ref.startsWith('#/')) {
      driftIssues.push({
        pointer,
        keyword: '$ref',
        severity: 'warn',
        message: `External $ref ${obj.$ref} is not supported. Only intra-spec refs work.`,
      });
    }
    return;
  }

  for (const [keyword, value] of Object.entries(obj)) {
    const meta = UNSUPPORTED_KEYWORDS[keyword];
    if (meta) {
      let message = meta.message;
      if (keyword === 'format' && typeof value === 'string') {
        const helper = BUILDER_FORMAT_HELPERS[value];
        if (helper !== undefined) {
          message = `format '${value}' is not enforced by the raw-JSON runtime. Use the ${helper} builder helper from @bajustone/fetcher/schema for runtime enforcement (it pairs format with an enforcing pattern).`;
        }
        else {
          message = `format '${value}' is not enforced at runtime — runtime accepts any string. No matching builder helper; add a pattern constraint if enforcement matters.`;
        }
      }
      driftIssues.push({
        pointer: `${pointer}/${escapePointer(keyword)}`,
        keyword,
        severity: meta.severity,
        message,
      });
      continue;
    }

    // Special-case: additionalProperties is supported as `false`, but not as
    // a sub-schema. Sub-schema form is unenforced (additional props pass).
    if (keyword === 'additionalProperties' && value && typeof value === 'object') {
      driftIssues.push({
        pointer: `${pointer}/additionalProperties`,
        keyword: 'additionalProperties',
        severity: 'warn',
        message: 'additionalProperties as a sub-schema is not enforced at runtime — only `false` is recognized.',
      });
      // Recurse into it anyway so nested unsupported keywords are also caught.
      walkForLint(value, `${pointer}/additionalProperties`, driftIssues);
      continue;
    }

    // Special-case: items as an array (positional/tuple-typed).
    if (keyword === 'items' && Array.isArray(value)) {
      driftIssues.push({
        pointer: `${pointer}/items`,
        keyword: 'items',
        severity: 'warn',
        message: 'Tuple-typed arrays (items as an array) are not enforced at runtime — every element is checked against the first schema.',
      });
      value.forEach((item, i) => walkForLint(item, `${pointer}/items/${i}`, driftIssues));
      continue;
    }
  }

  // Recurse into properties / items (single schema) / oneOf / anyOf / allOf.
  if (obj.properties && typeof obj.properties === 'object') {
    for (const [key, sub] of Object.entries(obj.properties as Record<string, unknown>))
      walkForLint(sub, `${pointer}/properties/${escapePointer(key)}`, driftIssues);
  }
  if (obj.items && !Array.isArray(obj.items) && typeof obj.items === 'object')
    walkForLint(obj.items, `${pointer}/items`, driftIssues);

  for (const combinator of ['oneOf', 'anyOf', 'allOf'] as const) {
    const subs = obj[combinator];
    if (Array.isArray(subs))
      subs.forEach((sub, i) => walkForLint(sub, `${pointer}/${combinator}/${i}`, driftIssues));
  }
}

// ---------------------------------------------------------------------------
// Coverage walkers (per-slot)
// ---------------------------------------------------------------------------

interface SlotResult { typed: boolean; reasons: string[] }

function walkBodySlot(spec: unknown, requestBody: unknown): SlotResult {
  const content = (requestBody as { content?: unknown } | undefined)?.content;
  if (!content || typeof content !== 'object')
    return { typed: true, reasons: [] }; // vacuous: no body declared
  const json = (content as Record<string, unknown>)['application/json'];
  const schema = (json as { schema?: unknown } | undefined)?.schema;
  if (!schema)
    return { typed: true, reasons: [] }; // vacuous: no JSON body
  return walkSchemaForCoverage(spec, schema, 'body');
}

function walkResponseSlot(
  spec: unknown,
  responses: unknown,
  slot: 'response' | 'error',
  matches: (status: string) => boolean,
): SlotResult {
  if (!responses || typeof responses !== 'object')
    return { typed: true, reasons: [] }; // vacuous: no responses declared
  const reasons: string[] = [];
  let foundAny = false;

  for (const [status, response] of Object.entries(responses as Record<string, unknown>)) {
    if (!matches(status))
      continue;
    const content = (response as { content?: unknown } | undefined)?.content;
    if (!content || typeof content !== 'object')
      continue;
    const json = (content as Record<string, unknown>)['application/json'];
    const schema = (json as { schema?: unknown } | undefined)?.schema;
    if (!schema)
      continue;
    foundAny = true;
    const result = walkSchemaForCoverage(spec, schema, slot);
    reasons.push(...result.reasons);
  }

  if (!foundAny)
    return { typed: true, reasons: [] }; // vacuous: no JSON responses for this status group
  return { typed: reasons.length === 0, reasons };
}

function walkSchemaForCoverage(
  spec: unknown,
  schema: unknown,
  slot: 'body' | 'response' | 'error',
): SlotResult {
  const reasons: string[] = [];
  walkForCoverage(spec, schema, slot, reasons, new Set());
  return { typed: reasons.length === 0, reasons };
}

function walkForCoverage(
  spec: unknown,
  node: unknown,
  slot: 'body' | 'response' | 'error',
  reasons: string[],
  visitedRefs: Set<string>,
): void {
  if (!node || typeof node !== 'object')
    return;
  const obj = node as Record<string, unknown>;

  if (typeof obj.$ref === 'string') {
    if (visitedRefs.has(obj.$ref)) {
      reasons.push(`recursive $ref detected at ${obj.$ref} in ${slot} schema`);
      return;
    }
    if (!obj.$ref.startsWith('#/')) {
      reasons.push(`external $ref ${obj.$ref} in ${slot} schema`);
      return;
    }
    const target = resolveRef(spec, obj.$ref);
    if (target === undefined) {
      reasons.push(`unresolved $ref ${obj.$ref} in ${slot} schema`);
      return;
    }
    visitedRefs.add(obj.$ref);
    walkForCoverage(spec, target, slot, reasons, visitedRefs);
    visitedRefs.delete(obj.$ref);
    return;
  }

  // Tier 0 blocker keywords. Each is reported once per slot to avoid noise.
  for (const keyword of TIER_0_BLOCKER_KEYWORDS) {
    if (obj[keyword] !== undefined) {
      const reason = `${keyword} in ${slot} schema`;
      if (!reasons.includes(reason))
        reasons.push(reason);
    }
  }

  // additionalProperties as sub-schema is also a blocker (Tier 0 only handles
  // closed objects with declared properties).
  if (obj.additionalProperties && typeof obj.additionalProperties === 'object') {
    const reason = `additionalProperties (sub-schema) in ${slot} schema`;
    if (!reasons.includes(reason))
      reasons.push(reason);
  }

  // Recurse into nested schemas. We still recurse even when a blocker was
  // found at this level so deeply-nested issues are reported alongside
  // shallow ones.
  if (obj.properties && typeof obj.properties === 'object') {
    for (const sub of Object.values(obj.properties as Record<string, unknown>))
      walkForCoverage(spec, sub, slot, reasons, visitedRefs);
  }
  if (obj.items && !Array.isArray(obj.items) && typeof obj.items === 'object')
    walkForCoverage(spec, obj.items, slot, reasons, visitedRefs);
  for (const combinator of ['oneOf', 'anyOf', 'allOf'] as const) {
    const subs = obj[combinator];
    if (Array.isArray(subs)) {
      for (const sub of subs)
        walkForCoverage(spec, sub, slot, reasons, visitedRefs);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ESCAPE_TILDE = /~/g;
const ESCAPE_SLASH = /\//g;
const REF_PREFIX = /^#\//;

/** RFC 6901 escape: `~` → `~0`, `/` → `~1`. */
function escapePointer(token: string): string {
  return token.replace(ESCAPE_TILDE, '~0').replace(ESCAPE_SLASH, '~1');
}

function resolveRef(spec: unknown, ref: string): unknown {
  const parts = ref.replace(REF_PREFIX, '').split('/').map(unescapePointer);
  let current: unknown = spec;
  for (const part of parts) {
    if (current && typeof current === 'object' && part in (current as Record<string, unknown>))
      current = (current as Record<string, unknown>)[part];
    else
      return undefined;
  }
  return current;
}

const UNESCAPE_SLASH = /~1/g;
const UNESCAPE_TILDE = /~0/g;

function unescapePointer(token: string): string {
  return token.replace(UNESCAPE_SLASH, '/').replace(UNESCAPE_TILDE, '~');
}

/**
 * Matches the prototype's `OpenAPISuccessStatus` semantics: numeric 2xx
 * statuses (200–206) are success. `'default'` is intentionally NOT a
 * success — it's the catch-all error per OpenAPI convention when paired
 * with a specific 2xx, and the prototype's response inference treats it
 * that way too.
 */
function isSuccessStatus(status: string): boolean {
  if (status === 'default')
    return false;
  const code = Number.parseInt(status, 10);
  return Number.isFinite(code) && code >= 200 && code < 300;
}

/**
 * Matches the prototype's `OpenAPIErrorStatus` semantics: numeric 4xx/5xx
 * statuses are errors, plus `'default'` as the catch-all error.
 */
function isErrorStatus(status: string): boolean {
  if (status === 'default')
    return true;
  const code = Number.parseInt(status, 10);
  return Number.isFinite(code) && code >= 400 && code < 600;
}

// ---------------------------------------------------------------------------
// Unsupported-keyword collector (item 2 — route-level aggregate)
// ---------------------------------------------------------------------------

function collectUnsupported(
  spec: unknown,
  requestBody: unknown,
  out: Set<string>,
): void {
  if (!requestBody || typeof requestBody !== 'object')
    return;
  const content = (requestBody as { content?: unknown }).content;
  if (!content || typeof content !== 'object')
    return;
  const json = (content as Record<string, unknown>)['application/json'];
  const schema = (json as { schema?: unknown } | undefined)?.schema;
  if (!schema)
    return;
  walkForUnsupported(spec, schema, out, new Set());
}

function collectUnsupportedFromResponses(
  spec: unknown,
  responses: unknown,
  out: Set<string>,
): void {
  if (!responses || typeof responses !== 'object')
    return;
  for (const response of Object.values(responses as Record<string, unknown>)) {
    const content = (response as { content?: unknown } | undefined)?.content;
    if (!content || typeof content !== 'object')
      continue;
    const json = (content as Record<string, unknown>)['application/json'];
    const schema = (json as { schema?: unknown } | undefined)?.schema;
    if (!schema)
      continue;
    walkForUnsupported(spec, schema, out, new Set());
  }
}

function walkForUnsupported(
  spec: unknown,
  node: unknown,
  out: Set<string>,
  visitedRefs: Set<string>,
): void {
  if (!node || typeof node !== 'object')
    return;
  const obj = node as Record<string, unknown>;

  if (typeof obj.$ref === 'string') {
    if (visitedRefs.has(obj.$ref) || !obj.$ref.startsWith('#/'))
      return;
    const target = resolveRef(spec, obj.$ref);
    if (target === undefined)
      return;
    visitedRefs.add(obj.$ref);
    walkForUnsupported(spec, target, out, visitedRefs);
    visitedRefs.delete(obj.$ref);
    return;
  }

  for (const kw of RUNTIME_UNSUPPORTED_KEYWORDS) {
    if (obj[kw] !== undefined)
      out.add(kw);
  }
  if (
    obj.additionalProperties
    && typeof obj.additionalProperties === 'object'
    && !Array.isArray(obj.additionalProperties)
  ) {
    out.add('additionalProperties');
  }
  if (Array.isArray(obj.items))
    out.add('items');

  if (obj.properties && typeof obj.properties === 'object') {
    for (const sub of Object.values(obj.properties as Record<string, unknown>))
      walkForUnsupported(spec, sub, out, visitedRefs);
  }
  if (obj.items && !Array.isArray(obj.items) && typeof obj.items === 'object')
    walkForUnsupported(spec, obj.items, out, visitedRefs);
  for (const combinator of ['oneOf', 'anyOf', 'allOf'] as const) {
    const subs = obj[combinator];
    if (Array.isArray(subs)) {
      for (const s of subs)
        walkForUnsupported(spec, s, out, visitedRefs);
    }
  }
  if (
    obj.additionalProperties
    && typeof obj.additionalProperties === 'object'
    && !Array.isArray(obj.additionalProperties)
  ) {
    walkForUnsupported(spec, obj.additionalProperties, out, visitedRefs);
  }
}

// ---------------------------------------------------------------------------
// Integrity checks (items 4, 5, 6)
// ---------------------------------------------------------------------------

function checkIntegrityFromBody(
  spec: unknown,
  requestBody: unknown,
  pointer: string,
  out: IntegrityIssue[],
): void {
  if (!requestBody || typeof requestBody !== 'object')
    return;
  const body = requestBody as Record<string, unknown>;
  checkUnreachableContent(body.content, pointer, out);
  if (body.content && typeof body.content === 'object') {
    const json = (body.content as Record<string, unknown>)['application/json'];
    const schema = (json as { schema?: unknown } | undefined)?.schema;
    if (schema) {
      walkForIntegrity(
        spec,
        schema,
        `${pointer}/content/application~1json/schema`,
        out,
        new Set(),
      );
    }
  }
}

function checkIntegrityFromResponses(
  spec: unknown,
  responses: unknown,
  pointer: string,
  out: IntegrityIssue[],
): void {
  if (!responses || typeof responses !== 'object')
    return;
  for (const [status, response] of Object.entries(responses as Record<string, unknown>)) {
    const respPointer = `${pointer}/${escapePointer(status)}`;
    const respObj = response as Record<string, unknown> | undefined;
    checkUnreachableContent(respObj?.content, respPointer, out);
    if (respObj?.content && typeof respObj.content === 'object') {
      const json = (respObj.content as Record<string, unknown>)['application/json'];
      const schema = (json as { schema?: unknown } | undefined)?.schema;
      if (schema) {
        walkForIntegrity(
          spec,
          schema,
          `${respPointer}/content/application~1json/schema`,
          out,
          new Set(),
        );
      }
    }
  }
}

function checkUnreachableContent(
  content: unknown,
  pointer: string,
  out: IntegrityIssue[],
): void {
  if (!content || typeof content !== 'object')
    return;
  const c = content as Record<string, unknown>;
  const mediaTypes = Object.keys(c);
  if (mediaTypes.length === 0)
    return;
  const consumable = mediaTypes.some(m => m === 'application/json' || m === '*/*');
  if (!consumable) {
    out.push({
      kind: 'unreachable_response',
      pointer: `${pointer}/content`,
      message: `Response declares content in [${mediaTypes.join(', ')}] but no application/json or */* media type — fetcher extracts only JSON by default, so this schema is unreachable.`,
    });
  }
}

function walkForIntegrity(
  spec: unknown,
  node: unknown,
  pointer: string,
  out: IntegrityIssue[],
  visitedRefs: Set<string>,
): void {
  if (!node || typeof node !== 'object')
    return;
  const obj = node as Record<string, unknown>;

  if (typeof obj.$ref === 'string') {
    if (visitedRefs.has(obj.$ref) || !obj.$ref.startsWith('#/'))
      return;
    const target = resolveRef(spec, obj.$ref);
    if (target === undefined)
      return;
    visitedRefs.add(obj.$ref);
    walkForIntegrity(spec, target, obj.$ref, out, visitedRefs);
    visitedRefs.delete(obj.$ref);
    return;
  }

  if (Array.isArray(obj.oneOf) && obj.discriminator && typeof obj.discriminator === 'object') {
    checkDiscriminator(
      spec,
      obj.oneOf,
      obj.discriminator as Record<string, unknown>,
      pointer,
      out,
    );
  }

  if (obj.type === 'object' && Array.isArray(obj.required) && obj.properties && typeof obj.properties === 'object') {
    const props = obj.properties as Record<string, unknown>;
    for (const required of obj.required as unknown[]) {
      if (typeof required === 'string' && !(required in props)) {
        out.push({
          kind: 'required_without_property',
          pointer: `${pointer}/required`,
          message: `Schema declares '${required}' in required but '${required}' is not in properties — every request will emit a 'missing' error for this key.`,
        });
      }
    }
  }

  if (obj.properties && typeof obj.properties === 'object') {
    for (const [k, sub] of Object.entries(obj.properties as Record<string, unknown>))
      walkForIntegrity(spec, sub, `${pointer}/properties/${escapePointer(k)}`, out, visitedRefs);
  }
  if (obj.items && !Array.isArray(obj.items) && typeof obj.items === 'object')
    walkForIntegrity(spec, obj.items, `${pointer}/items`, out, visitedRefs);
  for (const combinator of ['oneOf', 'anyOf', 'allOf'] as const) {
    const subs = obj[combinator];
    if (Array.isArray(subs)) {
      subs.forEach((s, i) =>
        walkForIntegrity(spec, s, `${pointer}/${combinator}/${i}`, out, visitedRefs),
      );
    }
  }
}

function checkDiscriminator(
  spec: unknown,
  variants: unknown[],
  discriminator: Record<string, unknown>,
  pointer: string,
  out: IntegrityIssue[],
): void {
  const propName = discriminator.propertyName;
  if (typeof propName !== 'string')
    return;
  const seenTags = new Map<string, number>();
  variants.forEach((variant, i) => {
    const resolved = resolveVariantSchema(spec, variant);
    if (!resolved)
      return;
    const tagValue = readDiscriminatorTag(resolved, propName);
    if (tagValue === undefined) {
      out.push({
        kind: 'discriminator_mismatch',
        pointer: `${pointer}/oneOf/${i}`,
        message: `oneOf variant lacks a discriminator value for '${propName}' — must have properties.${propName}.const or a single-valued enum.`,
      });
      return;
    }
    const prior = seenTags.get(tagValue);
    if (prior !== undefined) {
      out.push({
        kind: 'discriminator_duplicate',
        pointer: `${pointer}/oneOf/${i}`,
        message: `oneOf variant has discriminator '${propName}' value '${tagValue}' but variant ${prior} already uses that value.`,
      });
    }
    else {
      seenTags.set(tagValue, i);
    }
  });
}

function resolveVariantSchema(
  spec: unknown,
  variant: unknown,
): Record<string, unknown> | undefined {
  if (!variant || typeof variant !== 'object')
    return undefined;
  const v = variant as Record<string, unknown>;
  if (typeof v.$ref === 'string' && v.$ref.startsWith('#/')) {
    const target = resolveRef(spec, v.$ref);
    if (!target || typeof target !== 'object')
      return undefined;
    return target as Record<string, unknown>;
  }
  return v;
}

function readDiscriminatorTag(
  variant: Record<string, unknown>,
  propName: string,
): string | undefined {
  const props = variant.properties as Record<string, unknown> | undefined;
  if (!props)
    return undefined;
  const prop = props[propName] as Record<string, unknown> | undefined;
  if (!prop)
    return undefined;
  if (typeof prop.const === 'string')
    return prop.const;
  if (Array.isArray(prop.enum) && prop.enum.length === 1 && typeof prop.enum[0] === 'string')
    return prop.enum[0];
  return undefined;
}
