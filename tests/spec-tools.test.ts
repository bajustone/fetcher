/**
 * Unit tests for `lintSpec` and `coverage` from `src/spec-tools.ts`.
 *
 * Two functions, two angles each:
 *
 * - `lintSpec`: clean fixture (petstore) → no issues; synthetic spec with
 *   every unsupported keyword → one issue per keyword with the correct
 *   JSON pointer.
 * - `coverage`: clean fixture → all routes fully typed; synthetic spec with
 *   `oneOf` / `allOf` / recursive `$ref` → those routes fall back with the
 *   right reason strings.
 */

import { describe, expect, it } from 'bun:test';
import { coverage, lintSpec } from '../src/spec-tools.ts';
import petstoreSpec from './fixtures/petstore.json';

describe('lintSpec', () => {
  it('returns [] for the clean petstore fixture', () => {
    expect(lintSpec(petstoreSpec)).toEqual([]);
  });

  it('returns [] for an empty/non-object spec', () => {
    expect(lintSpec(null)).toEqual([]);
    expect(lintSpec(undefined)).toEqual([]);
    expect(lintSpec('not a spec')).toEqual([]);
    expect(lintSpec({})).toEqual([]);
  });

  it('flags every unsupported keyword in a synthetic spec with the correct pointer', () => {
    const spec = {
      openapi: '3.0.3',
      components: {
        schemas: {
          User: {
            type: 'object',
            properties: {
              email: { type: 'string', format: 'email' },
              age: { type: 'integer', multipleOf: 1, exclusiveMinimum: 0 },
              tags: { type: 'array', items: [{ type: 'string' }, { type: 'number' }] },
              extras: { type: 'object', patternProperties: { '^x-': { type: 'string' } } },
              keys: { type: 'object', propertyNames: { pattern: '^[a-z]+$' } },
            },
          },
          Conditional: {
            type: 'object',
            if: { properties: { kind: { const: 'A' } } },
            then: { required: ['a'] },
            else: { required: ['b'] },
          },
        },
      },
      paths: {},
    };

    const issues = lintSpec(spec);
    const keywords = issues.map(i => i.keyword).sort();

    // The synthetic spec contains: format, multipleOf, exclusiveMinimum,
    // patternProperties, propertyNames, if, then, else, plus an `items` array
    // (tuple form) which is flagged as `items`.
    expect(keywords).toContain('format');
    expect(keywords).toContain('multipleOf');
    expect(keywords).toContain('exclusiveMinimum');
    expect(keywords).toContain('patternProperties');
    expect(keywords).toContain('propertyNames');
    expect(keywords).toContain('if');
    expect(keywords).toContain('then');
    expect(keywords).toContain('else');
    expect(keywords).toContain('items');

    // Spot-check pointers: `format` lives at User.properties.email.format
    const formatIssue = issues.find(i => i.keyword === 'format');
    expect(formatIssue?.pointer).toBe('#/components/schemas/User/properties/email/format');

    // multipleOf at User.properties.age.multipleOf
    const multipleOfIssue = issues.find(i => i.keyword === 'multipleOf');
    expect(multipleOfIssue?.pointer).toBe('#/components/schemas/User/properties/age/multipleOf');

    // patternProperties at User.properties.extras.patternProperties
    const patternPropsIssue = issues.find(i => i.keyword === 'patternProperties');
    expect(patternPropsIssue?.pointer).toBe('#/components/schemas/User/properties/extras/patternProperties');

    // The if/then/else trio lives on Conditional itself.
    const ifIssue = issues.find(i => i.keyword === 'if');
    expect(ifIssue?.pointer).toBe('#/components/schemas/Conditional/if');
  });

  it('flags additionalProperties when it is a sub-schema (not `false`)', () => {
    const spec = {
      openapi: '3.0.3',
      components: {
        schemas: {
          Open: {
            type: 'object',
            additionalProperties: { type: 'string' },
          },
        },
      },
      paths: {},
    };

    const issues = lintSpec(spec);
    const apIssue = issues.find(i => i.keyword === 'additionalProperties');
    expect(apIssue).toBeDefined();
    expect(apIssue?.pointer).toBe('#/components/schemas/Open/additionalProperties');
  });

  it('does NOT flag additionalProperties when it is `false`', () => {
    const spec = {
      openapi: '3.0.3',
      components: {
        schemas: {
          Closed: {
            type: 'object',
            additionalProperties: false,
          },
        },
      },
      paths: {},
    };

    expect(lintSpec(spec)).toEqual([]);
  });

  it('flags external $ref but not intra-spec $ref', () => {
    const spec = {
      openapi: '3.0.3',
      components: {
        schemas: {
          A: { type: 'object' },
          B: { type: 'object', properties: { a: { $ref: '#/components/schemas/A' } } },
          C: { type: 'object', properties: { external: { $ref: 'https://example.com/schema.json' } } },
        },
      },
      paths: {},
    };

    const issues = lintSpec(spec);
    const refIssues = issues.filter(i => i.keyword === '$ref');
    expect(refIssues).toHaveLength(1);
    expect(refIssues[0]!.message).toContain('External $ref');
  });

  it('walks operation request bodies and responses, not just components.schemas', () => {
    const spec = {
      openapi: '3.0.3',
      paths: {
        '/items': {
          post: {
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { name: { type: 'string', format: 'email' } },
                  },
                },
              },
            },
            responses: {
              200: {
                content: {
                  'application/json': {
                    schema: { type: 'object', if: { properties: { x: {} } } },
                  },
                },
              },
            },
          },
        },
      },
    };

    const issues = lintSpec(spec);
    const formatIssue = issues.find(i => i.keyword === 'format');
    expect(formatIssue?.pointer).toBe('#/paths/~1items/post/requestBody/content/application~1json/schema/properties/name/format');
    const ifIssue = issues.find(i => i.keyword === 'if');
    expect(ifIssue?.pointer).toBe('#/paths/~1items/post/responses/200/content/application~1json/schema/if');
  });
});

describe('coverage', () => {
  it('reports the petstore fixture as fully Tier 0 ready', () => {
    const report = coverage(petstoreSpec);

    // Petstore has 3 routes: GET /pets, POST /pets, GET /pets/{petId}.
    expect(report.summary.total).toBe(3);
    expect(report.summary.fullyTyped).toBe(3);
    expect(report.summary.partial).toBe(0);
    expect(report.summary.untyped).toBe(0);

    for (const route of report.routes) {
      expect(route.fallbackReasons).toEqual([]);
      expect(route.bodyTyped).toBe(true);
      expect(route.responseTyped).toBe(true);
      expect(route.errorTyped).toBe(true);
    }

    // Spot-check that the routes are picked up correctly.
    const paths = report.routes.map(r => `${r.method} ${r.path}`).sort();
    expect(paths).toEqual([
      'GET /pets',
      'GET /pets/{petId}',
      'POST /pets',
    ]);
  });

  it('returns an empty report for an empty/non-object spec', () => {
    const empty = coverage({});
    expect(empty.routes).toEqual([]);
    expect(empty.summary).toEqual({ total: 0, fullyTyped: 0, partial: 0, untyped: 0 });

    const nonObj = coverage(null);
    expect(nonObj.routes).toEqual([]);
  });

  it('flags `oneOf` in a response schema as a fallback reason', () => {
    const spec = {
      openapi: '3.0.3',
      paths: {
        '/poly': {
          get: {
            responses: {
              200: {
                content: {
                  'application/json': {
                    schema: {
                      oneOf: [
                        { type: 'object', properties: { kind: { const: 'a' } } },
                        { type: 'object', properties: { kind: { const: 'b' } } },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    const report = coverage(spec);
    expect(report.summary.total).toBe(1);
    const route = report.routes[0]!;
    expect(route.responseTyped).toBe(false);
    expect(route.fallbackReasons).toContain('oneOf in response schema');
    // body and error are vacuous true (none declared).
    expect(route.bodyTyped).toBe(true);
    expect(route.errorTyped).toBe(true);
    // Mixed = partial.
    expect(report.summary.partial).toBe(1);
    expect(report.summary.fullyTyped).toBe(0);
  });

  it('flags `allOf` in a body schema as a fallback reason', () => {
    const spec = {
      openapi: '3.0.3',
      paths: {
        '/items': {
          post: {
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { type: 'object', properties: { id: { type: 'string' } } },
                      { type: 'object', properties: { name: { type: 'string' } } },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    };

    const report = coverage(spec);
    const route = report.routes[0]!;
    expect(route.bodyTyped).toBe(false);
    expect(route.fallbackReasons).toContain('allOf in body schema');
  });

  it('detects recursive $ref through components.schemas', () => {
    const spec = {
      openapi: '3.0.3',
      components: {
        schemas: {
          Tree: {
            type: 'object',
            properties: {
              value: { type: 'string' },
              children: {
                type: 'array',
                items: { $ref: '#/components/schemas/Tree' },
              },
            },
          },
        },
      },
      paths: {
        '/tree': {
          get: {
            responses: {
              200: {
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/Tree' },
                  },
                },
              },
            },
          },
        },
      },
    };

    const report = coverage(spec);
    const route = report.routes[0]!;
    expect(route.responseTyped).toBe(false);
    const recursionReason = route.fallbackReasons.find(r => r.startsWith('recursive $ref'));
    expect(recursionReason).toBeDefined();
    expect(recursionReason).toContain('#/components/schemas/Tree');
  });

  it('treats `default` response as error, not success (matching the prototype)', () => {
    const spec = {
      openapi: '3.0.3',
      paths: {
        '/items': {
          get: {
            responses: {
              200: {
                content: {
                  'application/json': {
                    schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
                  },
                },
              },
              default: {
                content: {
                  'application/json': {
                    schema: {
                      oneOf: [
                        { type: 'object', properties: { code: { type: 'integer' } } },
                        { type: 'string' },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    const report = coverage(spec);
    const route = report.routes[0]!;
    // 200 is clean → response slot is typed
    expect(route.responseTyped).toBe(true);
    // default has oneOf → error slot falls back, NOT response.
    expect(route.errorTyped).toBe(false);
    expect(route.fallbackReasons).toContain('oneOf in error schema');
  });
});
