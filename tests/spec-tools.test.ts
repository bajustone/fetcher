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

  it('skips trace operations — the runtime never builds TRACE routes', () => {
    // Regression: spec-tools walked 'trace' while the runtime adapter
    // (fromOpenAPI) and the HttpMethod type exclude it, so lintSpec flagged
    // keywords on schemas the runtime never compiles.
    const spec = {
      openapi: '3.0.3',
      paths: {
        '/t': {
          trace: {
            responses: {
              200: {
                content: {
                  'application/json': {
                    schema: { type: 'array', uniqueItems: true, items: { type: 'string' } },
                  },
                },
              },
            },
          },
          get: { responses: { 200: { description: 'ok' } } },
        },
      },
    };
    // The only unsupported keyword (uniqueItems) lives under the trace
    // operation, which the runtime never compiles → nothing to report.
    expect(lintSpec(spec)).toEqual([]);
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

  it('skips trace operations — the runtime never builds TRACE routes', () => {
    // Regression: coverage counted TRACE routes in summary.total and
    // reported slots for operations fromOpenAPI never builds and the type
    // layer (LowercaseHttpMethod) never infers.
    const spec = {
      openapi: '3.0.3',
      paths: {
        '/t': {
          trace: {
            responses: {
              200: { content: { 'application/json': { schema: { type: 'string' } } } },
            },
          },
          get: {
            responses: {
              200: { content: { 'application/json': { schema: { type: 'string' } } } },
            },
          },
        },
      },
    };
    const report = coverage(spec);
    expect(report.routes.map(r => `${r.method} ${r.path}`)).toEqual(['GET /t']);
    expect(report.summary.total).toBe(1);
  });

  it('returns an empty report for an empty/non-object spec', () => {
    const empty = coverage({});
    expect(empty.routes).toEqual([]);
    expect(empty.summary).toEqual({ total: 0, fullyTyped: 0, partial: 0, untyped: 0, withIntegrityIssues: 0 });

    const nonObj = coverage(null);
    expect(nonObj.routes).toEqual([]);
  });

  it('does NOT flag `oneOf` / `anyOf` / `allOf` — v0.4.0 JSONSchemaToType handles them', () => {
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
    for (const route of report.routes) {
      expect(route.fallbackReasons).toEqual([]);
      expect(route.bodyTyped).toBe(true);
      expect(route.responseTyped).toBe(true);
    }
    expect(report.summary.fullyTyped).toBe(2);
  });

  it('flags `patternProperties` as a fallback reason', () => {
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
                    patternProperties: {
                      '^S_': { type: 'string' },
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
    expect(route.bodyTyped).toBe(false);
    expect(route.fallbackReasons).toContain('patternProperties in body schema');
  });

  it('flags conditional schemas (if/then/else) as fallback reasons', () => {
    const spec = {
      openapi: '3.0.3',
      paths: {
        '/cond': {
          post: {
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    if: { properties: { kind: { const: 'a' } } },
                    then: { required: ['a'] },
                    else: { required: ['b'] },
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
    expect(route.fallbackReasons.some(r => r.startsWith('if in'))).toBe(true);
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
                      type: 'object',
                      patternProperties: {
                        '^err_': { type: 'string' },
                      },
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
    // default has patternProperties → error slot falls back, NOT response.
    expect(route.errorTyped).toBe(false);
    expect(route.fallbackReasons).toContain('patternProperties in error schema');
  });

  it('unsupportedKeywords aggregates runtime-unenforced keywords per route', () => {
    const spec = {
      openapi: '3.0.3',
      paths: {
        '/u': {
          post: {
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      email: { type: 'string', format: 'email' },
                      age: { type: 'integer', exclusiveMinimum: 0, multipleOf: 1 },
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
    expect(route.unsupportedKeywords.sort()).toEqual(['exclusiveMinimum', 'format', 'multipleOf']);
  });

  it('integrityIssues: discriminator_mismatch when variant lacks tag', () => {
    const spec = {
      openapi: '3.0.3',
      paths: {
        '/shape': {
          get: {
            responses: {
              200: {
                content: {
                  'application/json': {
                    schema: {
                      discriminator: { propertyName: 'kind' },
                      oneOf: [
                        { type: 'object', properties: { kind: { const: 'circle' }, radius: { type: 'number' } } },
                        { type: 'object', properties: { side: { type: 'number' } } }, // missing `kind`
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
    const mismatch = route.integrityIssues.find(i => i.kind === 'discriminator_mismatch');
    expect(mismatch).toBeDefined();
    expect(mismatch!.message).toContain('kind');
    expect(report.summary.withIntegrityIssues).toBe(1);
  });

  it('integrityIssues: discriminator_duplicate when two variants share a tag', () => {
    const spec = {
      openapi: '3.0.3',
      paths: {
        '/shape': {
          get: {
            responses: {
              200: {
                content: {
                  'application/json': {
                    schema: {
                      discriminator: { propertyName: 'kind' },
                      oneOf: [
                        { type: 'object', properties: { kind: { const: 'x' }, a: { type: 'number' } } },
                        { type: 'object', properties: { kind: { const: 'x' }, b: { type: 'number' } } },
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
    const dup = route.integrityIssues.find(i => i.kind === 'discriminator_duplicate');
    expect(dup).toBeDefined();
    expect(dup!.message).toContain('x');
  });

  it('integrityIssues: required_without_property surfaces spec typos', () => {
    const spec = {
      openapi: '3.0.3',
      paths: {
        '/u': {
          post: {
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['name', 'nameTypo'],
                    properties: {
                      name: { type: 'string' },
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
    const missing = route.integrityIssues.find(i => i.kind === 'required_without_property');
    expect(missing).toBeDefined();
    expect(missing!.message).toContain('nameTypo');
  });

  it('integrityIssues: unreachable_response when content lacks application/json', () => {
    const spec = {
      openapi: '3.0.3',
      paths: {
        '/html-only': {
          get: {
            responses: {
              200: {
                content: {
                  'text/html': {
                    schema: { type: 'string' },
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
    const unreachable = route.integrityIssues.find(i => i.kind === 'unreachable_response');
    expect(unreachable).toBeDefined();
    expect(unreachable!.message).toContain('text/html');
  });

  it('integrityIssues: wildcard */* is consumable, not unreachable', () => {
    const spec = {
      openapi: '3.0.3',
      paths: {
        '/wild': {
          get: {
            responses: {
              200: {
                content: {
                  '*/*': { schema: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    };

    const report = coverage(spec);
    const route = report.routes[0]!;
    expect(route.integrityIssues).toEqual([]);
  });

  it('resolves $ref before checking integrity', () => {
    const spec = {
      openapi: '3.0.3',
      components: {
        schemas: {
          Shape: {
            discriminator: { propertyName: 'kind' },
            oneOf: [
              { type: 'object', properties: { kind: { const: 'c' }, r: { type: 'number' } } },
              { type: 'object', properties: { s: { type: 'number' } } }, // missing kind
            ],
          },
        },
      },
      paths: {
        '/s': {
          get: {
            responses: {
              200: {
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/Shape' },
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
    expect(route.integrityIssues.some(i => i.kind === 'discriminator_mismatch')).toBe(true);
  });
});

describe('lintSpec completed keyword table (v1.0 hardening)', () => {
  it('flags not / uniqueItems / minProperties / maxProperties / contains family / unevaluated*', () => {
    const spec = {
      openapi: '3.1.0',
      components: {
        schemas: {
          Strict: {
            type: 'object',
            minProperties: 2,
            maxProperties: 5,
            unevaluatedProperties: false,
            properties: {
              role: { not: { const: 'admin' } },
              tags: { type: 'array', uniqueItems: true, contains: { type: 'string' }, minContains: 1, maxContains: 3 },
              tuple: { type: 'array', prefixItems: [{ type: 'string' }], unevaluatedItems: false },
            },
          },
        },
      },
      paths: {},
    };

    const issues = lintSpec(spec);
    const byKeyword = new Map(issues.map(i => [i.keyword, i]));

    expect(byKeyword.get('not')?.pointer).toBe('#/components/schemas/Strict/properties/role/not');
    expect(byKeyword.get('not')?.severity).toBe('warn');
    expect(byKeyword.get('uniqueItems')?.pointer).toBe('#/components/schemas/Strict/properties/tags/uniqueItems');
    expect(byKeyword.get('uniqueItems')?.severity).toBe('warn');
    expect(byKeyword.get('minProperties')?.pointer).toBe('#/components/schemas/Strict/minProperties');
    expect(byKeyword.get('minProperties')?.severity).toBe('warn');
    expect(byKeyword.get('maxProperties')?.pointer).toBe('#/components/schemas/Strict/maxProperties');
    expect(byKeyword.get('maxProperties')?.severity).toBe('warn');
    expect(byKeyword.get('contains')?.pointer).toBe('#/components/schemas/Strict/properties/tags/contains');
    expect(byKeyword.get('contains')?.severity).toBe('warn');
    expect(byKeyword.get('minContains')?.severity).toBe('info');
    expect(byKeyword.get('maxContains')?.severity).toBe('info');
    expect(byKeyword.get('unevaluatedProperties')?.pointer).toBe('#/components/schemas/Strict/unevaluatedProperties');
    expect(byKeyword.get('unevaluatedProperties')?.severity).toBe('warn');
    expect(byKeyword.get('unevaluatedItems')?.pointer).toBe('#/components/schemas/Strict/properties/tuple/unevaluatedItems');
    expect(byKeyword.get('unevaluatedItems')?.severity).toBe('warn');
  });

  it('flags content* keywords as info-level annotations', () => {
    const spec = {
      openapi: '3.1.0',
      components: {
        schemas: {
          Blob: {
            type: 'string',
            contentMediaType: 'application/json',
            contentEncoding: 'base64',
            contentSchema: { type: 'object' },
          },
        },
      },
      paths: {},
    };

    const issues = lintSpec(spec);
    for (const keyword of ['contentMediaType', 'contentEncoding', 'contentSchema']) {
      const issue = issues.find(i => i.keyword === keyword);
      expect(issue).toBeDefined();
      expect(issue!.severity).toBe('info');
      expect(issue!.pointer).toBe(`#/components/schemas/Blob/${keyword}`);
    }
  });

  it('flags $dynamicRef (warn) and $anchor / $dynamicAnchor (info)', () => {
    const spec = {
      openapi: '3.1.0',
      components: {
        schemas: {
          Dyn: {
            type: 'object',
            $anchor: 'dyn',
            $dynamicAnchor: 'node',
            properties: { next: { $dynamicRef: '#node' } },
          },
        },
      },
      paths: {},
    };

    const issues = lintSpec(spec);
    expect(issues.find(i => i.keyword === '$dynamicRef')?.severity).toBe('warn');
    expect(issues.find(i => i.keyword === '$anchor')?.severity).toBe('info');
    expect(issues.find(i => i.keyword === '$dynamicAnchor')?.severity).toBe('info');
  });

  it('coverage aggregates the new keywords into unsupportedKeywords', () => {
    const spec = {
      openapi: '3.1.0',
      paths: {
        '/u': {
          post: {
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    minProperties: 1,
                    properties: {
                      role: { not: { const: 'admin' } },
                      tags: { type: 'array', uniqueItems: true, contains: { type: 'string' } },
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
    expect(route.unsupportedKeywords).toEqual(['contains', 'minProperties', 'not', 'uniqueItems']);
  });

  // Differential guard: walk every JSON Schema 2020-12 validation/applicator
  // keyword and assert each one is either ENFORCED by the runtime converter
  // (from-json-schema.ts) or flagged by lintSpec. If the runtime ever gains
  // or loses keyword support, or 2020-12 keywords are added here, this test
  // forces the lint table to keep up — lintSpec's CI-gate contract is "no
  // silent type/runtime drift".
  it('differential: every 2020-12 keyword is either enforced or flagged', () => {
    // Keywords the runtime converter consumes (see from-json-schema.ts
    // pickStringOpts / pickNumberOpts / pickArrayOpts + convert()), plus
    // pure-annotation keywords that cannot drift because they assert nothing.
    const ENFORCED_OR_ANNOTATION = new Set([
      'type',
      'enum',
      'const',
      'minLength',
      'maxLength',
      'pattern',
      'minimum',
      'maximum',
      'minItems',
      'maxItems',
      'properties',
      'required',
      'items',
      'oneOf',
      'anyOf',
      'allOf',
      'additionalProperties', // `false` form enforced; sub-schema form special-cased below
      '$ref',
      '$defs',
      'discriminator',
      'title',
      'description',
      'default',
      'deprecated',
      'readOnly',
      'writeOnly',
      'examples',
      '$comment',
    ]);

    // One minimal usage per 2020-12 validation / applicator / core keyword.
    const KEYWORD_USAGES: Record<string, object> = {
      type: { type: 'string' },
      enum: { enum: ['a'] },
      const: { const: 'a' },
      multipleOf: { type: 'number', multipleOf: 2 },
      maximum: { type: 'number', maximum: 1 },
      exclusiveMaximum: { type: 'number', exclusiveMaximum: 1 },
      minimum: { type: 'number', minimum: 0 },
      exclusiveMinimum: { type: 'number', exclusiveMinimum: 0 },
      maxLength: { type: 'string', maxLength: 3 },
      minLength: { type: 'string', minLength: 1 },
      pattern: { type: 'string', pattern: '^a' },
      maxItems: { type: 'array', maxItems: 3 },
      minItems: { type: 'array', minItems: 1 },
      uniqueItems: { type: 'array', uniqueItems: true },
      maxContains: { type: 'array', contains: { type: 'string' }, maxContains: 2 },
      minContains: { type: 'array', contains: { type: 'string' }, minContains: 1 },
      contains: { type: 'array', contains: { type: 'string' } },
      maxProperties: { type: 'object', maxProperties: 3 },
      minProperties: { type: 'object', minProperties: 1 },
      required: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
      dependentRequired: { type: 'object', dependentRequired: { a: ['b'] } },
      properties: { type: 'object', properties: { a: { type: 'string' } } },
      patternProperties: { type: 'object', patternProperties: { '^x-': { type: 'string' } } },
      additionalProperties: { type: 'object', additionalProperties: false },
      propertyNames: { type: 'object', propertyNames: { pattern: '^[a-z]+$' } },
      items: { type: 'array', items: { type: 'string' } },
      prefixItems: { type: 'array', prefixItems: [{ type: 'string' }] },
      allOf: { allOf: [{ type: 'object' }] },
      anyOf: { anyOf: [{ type: 'object' }] },
      oneOf: { oneOf: [{ type: 'object' }] },
      not: { not: { type: 'null' } },
      if: { if: { type: 'object' } },
      then: { if: { type: 'object' }, then: { required: [] } },
      else: { if: { type: 'object' }, else: { required: [] } },
      dependentSchemas: { type: 'object', dependentSchemas: { a: { required: ['b'] } } },
      unevaluatedItems: { type: 'array', unevaluatedItems: false },
      unevaluatedProperties: { type: 'object', unevaluatedProperties: false },
      format: { type: 'string', format: 'email' },
      contentEncoding: { type: 'string', contentEncoding: 'base64' },
      contentMediaType: { type: 'string', contentMediaType: 'application/json' },
      contentSchema: { type: 'string', contentMediaType: 'application/json', contentSchema: { type: 'object' } },
      $anchor: { type: 'object', $anchor: 'a' },
      $dynamicAnchor: { type: 'object', $dynamicAnchor: 'a' },
      $dynamicRef: { $dynamicRef: '#a' },
      $id: { type: 'object', $id: 'https://example.com/s' },
      $schema: { type: 'object', $schema: 'https://json-schema.org/draft/2020-12/schema' },
    };

    const schemas: Record<string, object> = {};
    for (const [keyword, usage] of Object.entries(KEYWORD_USAGES))
      schemas[`Uses_${keyword.replace('$', 'dollar_')}`] = usage;

    const issues = lintSpec({ openapi: '3.1.0', components: { schemas }, paths: {} });
    const flagged = new Set(issues.map(i => i.keyword));

    const unaccounted = Object.keys(KEYWORD_USAGES).filter(
      keyword => !ENFORCED_OR_ANNOTATION.has(keyword) && !flagged.has(keyword),
    );
    expect(unaccounted).toEqual([]);
  });

  it('differential: the sub-schema form of additionalProperties is still flagged', () => {
    const issues = lintSpec({
      openapi: '3.1.0',
      components: { schemas: { Open: { type: 'object', additionalProperties: { type: 'string' } } } },
      paths: {},
    });
    expect(issues.some(i => i.keyword === 'additionalProperties')).toBe(true);
  });
});

describe('lintSpec format helper hint (item 1)', () => {
  it('suggests email() builder helper for format: email', () => {
    const spec = {
      openapi: '3.0.3',
      components: {
        schemas: {
          User: {
            type: 'object',
            properties: {
              email: { type: 'string', format: 'email' },
            },
          },
        },
      },
    };

    const issues = lintSpec(spec);
    const formatIssue = issues.find(i => i.keyword === 'format');
    expect(formatIssue).toBeDefined();
    expect(formatIssue!.message).toContain('email()');
    expect(formatIssue!.message).toContain('@bajustone/fetcher/schema');
  });

  it('falls back to generic message for formats without a helper', () => {
    const spec = {
      openapi: '3.0.3',
      components: {
        schemas: {
          User: {
            type: 'object',
            properties: {
              ip: { type: 'string', format: 'ipv4' },
            },
          },
        },
      },
    };

    const issues = lintSpec(spec);
    const formatIssue = issues.find(i => i.keyword === 'format');
    expect(formatIssue).toBeDefined();
    expect(formatIssue!.message).toContain('ipv4');
    expect(formatIssue!.message).toContain('No matching builder helper');
  });
});
