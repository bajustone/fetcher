/**
 * Regression tests aligning `lintSpec` / `coverage` with the v1.0 OpenAPI
 * runtime hardening (the runtime side is covered by
 * tests/openapi-hardening.test.ts):
 *
 * 1. Operation-level `$ref`s (requestBody / responses / parameters) are
 *    resolved against `#/components/...`, so referenced components are
 *    linted/covered as if inline — at the component's pointer.
 * 2. Path-item-level `parameters` merge into every operation (operation
 *    wins on `name`+`in`) and show up in lint + coverage.
 * 3. JSON media types match structurally — exact `application/json`, then
 *    `application/*+json`, then `*\/*`, with content-type parameters
 *    stripped — so a `problem+json` response is NOT flagged unreachable.
 * 4. Cyclic operation-level `$ref`s throw (no infinite loop) and
 *    external/unresolvable refs warn-and-skip, matching `fromOpenAPI`.
 */

import { describe, expect, it, spyOn } from 'bun:test';
import { coverage, lintSpec } from '../src/spec-tools.ts';

// ---------------------------------------------------------------------------
// 1. Operation-level $refs
// ---------------------------------------------------------------------------

describe('operation-level $refs (lintSpec)', () => {
  const spec = {
    openapi: '3.1.0',
    paths: {
      '/users': {
        post: {
          requestBody: { $ref: '#/components/requestBodies/NewUser' },
          responses: {
            400: { $ref: '#/components/responses/Problem' },
          },
        },
        get: {
          parameters: [{ $ref: '#/components/parameters/Limit' }],
          responses: {},
        },
      },
    },
    components: {
      requestBodies: {
        NewUser: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { email: { type: 'string', format: 'email' } },
              },
            },
          },
        },
      },
      responses: {
        Problem: {
          content: {
            'application/problem+json': {
              schema: { type: 'object', if: { properties: { code: {} } } },
            },
          },
        },
      },
      parameters: {
        Limit: {
          name: 'limit',
          in: 'query',
          schema: { type: 'integer', multipleOf: 10 },
        },
      },
    },
  };

  it('lints a $ref\'d requestBody as if inline, at the component pointer', () => {
    const issues = lintSpec(spec);
    const formatIssue = issues.find(i => i.keyword === 'format');
    expect(formatIssue).toBeDefined();
    expect(formatIssue!.pointer).toBe(
      '#/components/requestBodies/NewUser/content/application~1json/schema/properties/email/format',
    );
  });

  it('lints a $ref\'d response as if inline (problem+json content included)', () => {
    const issues = lintSpec(spec);
    const ifIssue = issues.find(i => i.keyword === 'if');
    expect(ifIssue).toBeDefined();
    expect(ifIssue!.pointer).toBe(
      '#/components/responses/Problem/content/application~1problem+json/schema/if',
    );
  });

  it('lints a $ref\'d parameter as if inline', () => {
    const issues = lintSpec(spec);
    const multipleOfIssue = issues.find(i => i.keyword === 'multipleOf');
    expect(multipleOfIssue).toBeDefined();
    expect(multipleOfIssue!.pointer).toBe('#/components/parameters/Limit/schema/multipleOf');
  });

  it('does not flag the intra-spec operation-level $refs themselves', () => {
    const issues = lintSpec(spec);
    expect(issues.filter(i => i.keyword === '$ref')).toEqual([]);
  });
});

describe('operation-level $refs (coverage)', () => {
  it('covers a $ref\'d requestBody as if inline (typing fallback detected)', () => {
    const spec = {
      openapi: '3.1.0',
      paths: {
        '/f': {
          post: {
            requestBody: { $ref: '#/components/requestBodies/Free' },
            responses: {},
          },
        },
      },
      components: {
        requestBodies: {
          Free: {
            content: {
              'application/json': {
                schema: { type: 'object', patternProperties: { '^x-': { type: 'string' } } },
              },
            },
          },
        },
      },
    };

    const route = coverage(spec).routes[0]!;
    expect(route.bodyTyped).toBe(false);
    expect(route.fallbackReasons).toContain('patternProperties in body schema');
    expect(route.unsupportedKeywords).toContain('patternProperties');
  });

  it('aggregates unsupportedKeywords through a $ref\'d response', () => {
    const spec = {
      openapi: '3.1.0',
      paths: {
        '/l': {
          get: {
            responses: { 200: { $ref: '#/components/responses/Listed' } },
          },
        },
      },
      components: {
        responses: {
          Listed: {
            content: {
              'application/json': {
                schema: { type: 'array', uniqueItems: true, items: { type: 'string' } },
              },
            },
          },
        },
      },
    };

    const route = coverage(spec).routes[0]!;
    // uniqueItems is runtime-unenforced but not a typing blocker.
    expect(route.responseTyped).toBe(true);
    expect(route.unsupportedKeywords).toEqual(['uniqueItems']);
  });

  it('checks integrity through a $ref\'d response, at the component pointer', () => {
    const spec = {
      openapi: '3.1.0',
      paths: {
        '/s': {
          get: {
            responses: { 200: { $ref: '#/components/responses/Shape' } },
          },
        },
      },
      components: {
        responses: {
          Shape: {
            content: {
              'application/json': {
                schema: {
                  discriminator: { propertyName: 'kind' },
                  oneOf: [
                    { type: 'object', properties: { kind: { const: 'c' }, r: { type: 'number' } } },
                    { type: 'object', properties: { s: { type: 'number' } } }, // missing kind
                  ],
                },
              },
            },
          },
        },
      },
    };

    const route = coverage(spec).routes[0]!;
    const mismatch = route.integrityIssues.find(i => i.kind === 'discriminator_mismatch');
    expect(mismatch).toBeDefined();
    expect(mismatch!.pointer).toBe(
      '#/components/responses/Shape/content/application~1json/schema/oneOf/1',
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Path-item-level parameters
// ---------------------------------------------------------------------------

describe('path-item parameters (lintSpec)', () => {
  it('lints shared path-item parameter schemas for every operation', () => {
    const spec = {
      openapi: '3.1.0',
      paths: {
        '/pets/{petId}': {
          parameters: [
            { name: 'petId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          get: { responses: {} },
          delete: { responses: {} },
        },
      },
    };

    const issues = lintSpec(spec);
    const formatIssues = issues.filter(i => i.keyword === 'format');
    // Reported once per operation that inherits the parameter (GET + DELETE),
    // both pointing at the shared path-item source location.
    expect(formatIssues).toHaveLength(2);
    expect(formatIssues[0]!.pointer).toBe('#/paths/~1pets~1{petId}/parameters/0/schema/format');
    expect(formatIssues[1]!.pointer).toBe('#/paths/~1pets~1{petId}/parameters/0/schema/format');
  });

  it('does not lint a path-item parameter shadowed by an operation-level one', () => {
    const spec = {
      openapi: '3.1.0',
      paths: {
        '/pets/{petId}': {
          parameters: [
            // Shadowed below — the runtime never builds a validator from it.
            { name: 'petId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          get: {
            parameters: [
              { name: 'petId', in: 'path', required: true, schema: { type: 'integer' } },
            ],
            responses: {},
          },
        },
      },
    };

    expect(lintSpec(spec)).toEqual([]);
  });
});

describe('path-item parameters (coverage)', () => {
  it('reflects path-item parameter schemas in unsupportedKeywords', () => {
    const spec = {
      openapi: '3.1.0',
      paths: {
        '/events': {
          parameters: [
            { name: 'since', in: 'query', schema: { type: 'string', format: 'date' } },
          ],
          get: {
            responses: {
              200: { content: { 'application/json': { schema: { type: 'object' } } } },
            },
          },
        },
      },
    };

    const route = coverage(spec).routes[0]!;
    expect(route.unsupportedKeywords).toEqual(['format']);
  });

  it('operation-level override wins — shadowed path-level keyword not reported', () => {
    const spec = {
      openapi: '3.1.0',
      paths: {
        '/events': {
          parameters: [
            { name: 'since', in: 'query', schema: { type: 'string', format: 'date' } },
          ],
          get: {
            parameters: [
              { name: 'since', in: 'query', schema: { type: 'string' } },
            ],
            responses: {},
          },
        },
      },
    };

    const route = coverage(spec).routes[0]!;
    expect(route.unsupportedKeywords).toEqual([]);
  });

  it('resolves $ref\'d parameters through components.parameters', () => {
    const spec = {
      openapi: '3.1.0',
      paths: {
        '/events': {
          get: {
            parameters: [{ $ref: '#/components/parameters/Since' }],
            responses: {},
          },
        },
      },
      components: {
        parameters: {
          Since: { name: 'since', in: 'query', schema: { type: 'string', format: 'date' } },
        },
      },
    };

    const route = coverage(spec).routes[0]!;
    expect(route.unsupportedKeywords).toEqual(['format']);
  });
});

// ---------------------------------------------------------------------------
// 3. JSON media-type matching
// ---------------------------------------------------------------------------

describe('JSON media-type matching', () => {
  it('does NOT flag application/problem+json responses as unreachable', () => {
    const spec = {
      openapi: '3.1.0',
      paths: {
        '/p': {
          get: {
            responses: {
              200: { content: { 'application/json': { schema: { type: 'object' } } } },
              400: {
                content: {
                  'application/problem+json': {
                    schema: { type: 'object', properties: { detail: { type: 'string' } } },
                  },
                },
              },
            },
          },
        },
      },
    };

    const route = coverage(spec).routes[0]!;
    expect(route.integrityIssues).toEqual([]);
  });

  it('does NOT flag parameterized application/json; charset=utf-8 as unreachable', () => {
    const spec = {
      openapi: '3.1.0',
      paths: {
        '/c': {
          get: {
            responses: {
              200: {
                content: {
                  'application/json; charset=utf-8': { schema: { type: 'object' } },
                },
              },
            },
          },
        },
      },
    };

    const route = coverage(spec).routes[0]!;
    expect(route.integrityIssues).toEqual([]);
  });

  it('still flags non-JSON-only content as unreachable, naming the new matching rules', () => {
    const spec = {
      openapi: '3.1.0',
      paths: {
        '/html': {
          get: {
            responses: {
              200: { content: { 'text/html': { schema: { type: 'string' } } } },
            },
          },
        },
      },
    };

    const route = coverage(spec).routes[0]!;
    const unreachable = route.integrityIssues.find(i => i.kind === 'unreachable_response');
    expect(unreachable).toBeDefined();
    expect(unreachable!.message).toContain('text/html');
    expect(unreachable!.message).toContain('application/*+json');
  });

  it('walks problem+json error schemas for the coverage error slot', () => {
    const spec = {
      openapi: '3.1.0',
      paths: {
        '/e': {
          get: {
            responses: {
              400: {
                content: {
                  'application/problem+json': {
                    schema: { type: 'object', patternProperties: { '^e': { type: 'string' } } },
                  },
                },
              },
            },
          },
        },
      },
    };

    const route = coverage(spec).routes[0]!;
    expect(route.errorTyped).toBe(false);
    expect(route.fallbackReasons).toContain('patternProperties in error schema');
    expect(route.unsupportedKeywords).toContain('patternProperties');
  });

  it('prefers exact application/json over +json variants (matching the runtime)', () => {
    const spec = {
      openapi: '3.1.0',
      paths: {
        '/x': {
          get: {
            responses: {
              200: {
                content: {
                  'application/hal+json': {
                    schema: { type: 'object', patternProperties: { '^h': { type: 'string' } } },
                  },
                  'application/json': { schema: { type: 'object' } },
                },
              },
            },
          },
        },
      },
    };

    // The exact application/json entry wins, and it is clean — the hal+json
    // schema is never consumed by the runtime, so coverage ignores it too.
    const route = coverage(spec).routes[0]!;
    expect(route.responseTyped).toBe(true);
    expect(route.fallbackReasons).toEqual([]);
    expect(route.integrityIssues).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Cyclic / external / unresolvable operation-level $refs
// ---------------------------------------------------------------------------

describe('cyclic operation-level $refs', () => {
  const cyclic = {
    openapi: '3.1.0',
    paths: {
      '/x': {
        post: {
          requestBody: { $ref: '#/components/requestBodies/A' },
          responses: {},
        },
      },
    },
    components: {
      requestBodies: {
        A: { $ref: '#/components/requestBodies/B' },
        B: { $ref: '#/components/requestBodies/A' },
      },
    },
  };

  it('lintSpec throws a clear error instead of looping forever', () => {
    expect(() => lintSpec(cyclic)).toThrow(/cyclic operation-level \$ref/);
  });

  it('coverage throws a clear error instead of looping forever', () => {
    expect(() => coverage(cyclic)).toThrow(/cyclic operation-level \$ref/);
  });
});

describe('external / unresolved operation-level $refs', () => {
  const broken = {
    openapi: '3.1.0',
    paths: {
      '/x': {
        post: {
          requestBody: { $ref: '#/components/requestBodies/Missing' },
          responses: {
            200: { $ref: './external.yaml#/components/responses/Pet' },
            201: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { e: { type: 'string', format: 'email' } },
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  it('lintSpec warns and skips the slot, still linting the resolvable rest', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const issues = lintSpec(broken);
      // The inline 201 response is still linted.
      expect(issues.some(i => i.keyword === 'format')).toBe(true);
      // One warn for the unresolved body ref, one for the external response ref.
      expect(warn).toHaveBeenCalledTimes(2);
      expect(String(warn.mock.calls[0]![0])).toContain('Missing');
    }
    finally {
      warn.mockRestore();
    }
  });

  it('coverage warns and treats the skipped slots as vacuous (like the runtime)', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const route = coverage(broken).routes[0]!;
      // Skipped body slot → no validator at runtime → vacuously typed.
      expect(route.bodyTyped).toBe(true);
      expect(route.responseTyped).toBe(true);
      expect(route.unsupportedKeywords).toContain('format');
      expect(warn).toHaveBeenCalledTimes(2);
    }
    finally {
      warn.mockRestore();
    }
  });
});
