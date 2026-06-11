/**
 * Regression tests for the v1.0 hardening pass over the OpenAPI runtime:
 *
 * 1. Operation-level `$ref`s (requestBody / responses / parameters) resolve
 *    against `components.requestBodies` / `.responses` / `.parameters`.
 * 2. Path-item-level `parameters` merge into every operation (operation
 *    level wins on `name`+`in`).
 * 3. `default` responses are the error catch-all — never the success slot.
 * 4. `+json` structured-suffix and parameterized media types match.
 * 5. Optional request bodies (OpenAPI defaults `required: false`) produce
 *    validators that accept `undefined`.
 * 6. Integer/number path & query params coerce numeric strings; bodies do
 *    not coerce.
 * 7. `__proto__`-named properties/components round-trip safely.
 * 8. HEAD/OPTIONS operations are extracted (parity with `HttpMethod`).
 */

import { describe, expect, it, spyOn } from 'bun:test';
import { createFetch } from '../src/fetcher.ts';
import { fromJSONSchema } from '../src/from-json-schema.ts';
import {
  extractComponentSchemas,
  extractRouteSchemas,
  fromOpenAPI,
} from '../src/openapi.ts';

// ---------------------------------------------------------------------------
// 1. Operation-level $refs
// ---------------------------------------------------------------------------

describe('operation-level $refs', () => {
  const spec = {
    openapi: '3.1.0',
    paths: {
      '/pets': {
        post: {
          requestBody: { $ref: '#/components/requestBodies/NewPet' },
          responses: {
            201: { $ref: '#/components/responses/PetResponse' },
            400: { $ref: '#/components/responses/ErrorResponse' },
          },
        },
        get: {
          parameters: [{ $ref: '#/components/parameters/LimitParam' }],
          responses: {
            200: { $ref: '#/components/responses/PetResponse' },
          },
        },
      },
    },
    components: {
      schemas: {
        Pet: {
          type: 'object',
          properties: { id: { type: 'integer' }, name: { type: 'string' } },
          required: ['id', 'name'],
        },
      },
      requestBodies: {
        NewPet: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { name: { type: 'string' } },
                required: ['name'],
              },
            },
          },
        },
      },
      responses: {
        PetResponse: {
          description: 'A pet',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/Pet' } },
          },
        },
        ErrorResponse: {
          description: 'An error',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { message: { type: 'string' } },
                required: ['message'],
              },
            },
          },
        },
      },
      parameters: {
        LimitParam: {
          name: 'limit',
          in: 'query',
          schema: { type: 'integer' },
        },
      },
    },
  } as any;

  it('resolves requestBody $ref into a working body validator', async () => {
    const routes = fromOpenAPI(spec);
    const body = routes['/pets']!.POST!.body!;
    expect(body).toBeDefined();

    const ok = await body['~standard'].validate({ name: 'Rex' });
    expect(ok.issues).toBeUndefined();
    const bad = await body['~standard'].validate({});
    expect(bad.issues).toBeDefined();
    // required: true in the referenced body → undefined rejected
    const missing = await body['~standard'].validate(undefined);
    expect(missing.issues).toBeDefined();
  });

  it('resolves response/errorResponse $refs into working validators', async () => {
    const routes = fromOpenAPI(spec);
    const post = routes['/pets']!.POST!;
    expect(post.response).toBeDefined();
    expect(post.errorResponse).toBeDefined();

    const ok = await post.response!['~standard'].validate({ id: 1, name: 'Rex' });
    expect(ok.issues).toBeUndefined();
    const err = await post.errorResponse!['~standard'].validate({ message: 'nope' });
    expect(err.issues).toBeUndefined();
  });

  it('resolves parameter $refs into query validators', async () => {
    const routes = fromOpenAPI(spec);
    const query = routes['/pets']!.GET!.query!;
    expect(query).toBeDefined();
    const ok = await query['~standard'].validate({ limit: 5 });
    expect(ok.issues).toBeUndefined();
  });

  it('extractRouteSchemas resolves the same refs (build-time parity)', () => {
    const { routes } = extractRouteSchemas(spec);
    expect(routes['/pets']!.POST!.body).toBeDefined();
    expect(routes['/pets']!.POST!.response).toBeDefined();
    expect(routes['/pets']!.POST!.errorResponse).toBeDefined();
    expect(routes['/pets']!.GET!.query).toBeDefined();
  });

  it('throws a clear error on a cyclic operation-level $ref', () => {
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
    } as any;

    expect(() => fromOpenAPI(cyclic)).toThrow(/cyclic operation-level \$ref/);
  });

  it('warns and skips unresolvable / external operation-level $refs', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
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
                    'application/json': { schema: { type: 'object' } },
                  },
                },
              },
            },
          },
        },
      } as any;

      const routes = fromOpenAPI(broken);
      const post = routes['/x']!.POST!;
      // Unresolvable body ref → no body validator, but the route survives
      // and the resolvable 201 response still produces a validator.
      expect(post.body).toBeUndefined();
      expect(post.response).toBeDefined();
      expect(warn).toHaveBeenCalledTimes(2);
      expect(String(warn.mock.calls[0]![0])).toContain('Missing');
    }
    finally {
      warn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Path-item-level parameters
// ---------------------------------------------------------------------------

describe('path-item-level parameters', () => {
  it('applies shared path-item parameters to every operation', async () => {
    const spec = {
      openapi: '3.1.0',
      paths: {
        '/pets/{petId}': {
          parameters: [
            { name: 'petId', in: 'path', required: true, schema: { type: 'string' } },
          ],
          get: { responses: { 200: { content: { 'application/json': { schema: { type: 'object' } } } } } },
          delete: { responses: { 204: { description: 'deleted' } } },
        },
      },
    } as any;

    const routes = fromOpenAPI(spec);
    for (const method of ['GET', 'DELETE'] as const) {
      const params = routes['/pets/{petId}']![method]!.params!;
      expect(params).toBeDefined();
      const ok = await params['~standard'].validate({ petId: '42' });
      expect(ok.issues).toBeUndefined();
      const missing = await params['~standard'].validate({});
      expect(missing.issues).toBeDefined();
    }
  });

  it('operation-level parameters win on name+in collision', async () => {
    const spec = {
      openapi: '3.1.0',
      paths: {
        '/pets/{petId}': {
          parameters: [
            { name: 'petId', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'verbose', in: 'query', schema: { type: 'string' } },
          ],
          get: {
            parameters: [
              // Override: petId is an integer for this operation.
              { name: 'petId', in: 'path', required: true, schema: { type: 'integer' } },
            ],
            responses: { 200: { content: { 'application/json': { schema: { type: 'object' } } } } },
          },
        },
      },
    } as any;

    const routes = fromOpenAPI(spec);
    const get = routes['/pets/{petId}']!.GET!;

    // The op-level integer schema applies (and coerces numeric strings).
    const okInt = await get.params!['~standard'].validate({ petId: 42 });
    expect(okInt.issues).toBeUndefined();
    const bad = await get.params!['~standard'].validate({ petId: 'abc' });
    expect(bad.issues).toBeDefined();

    // The non-colliding path-level query parameter still applies.
    expect(get.query).toBeDefined();
    const okQuery = await get.query!['~standard'].validate({ verbose: 'yes' });
    expect(okQuery.issues).toBeUndefined();
  });

  it('extractRouteSchemas merges path-item parameters too', () => {
    const spec = {
      openapi: '3.1.0',
      paths: {
        '/pets/{petId}': {
          parameters: [
            { name: 'petId', in: 'path', required: true, schema: { type: 'string' } },
          ],
          get: { responses: {} },
        },
      },
    } as any;

    const { routes } = extractRouteSchemas(spec);
    const params = routes['/pets/{petId}']!.GET!.params!;
    expect(params).toBeDefined();
    expect(params.properties!.petId).toEqual({ type: 'string' });
    expect(params.required).toEqual(['petId']);
  });
});

// ---------------------------------------------------------------------------
// 3. `default` response semantics
// ---------------------------------------------------------------------------

describe('default response semantics', () => {
  it('default-only operation: errorResponse is set, response is not', async () => {
    const spec = {
      openapi: '3.1.0',
      paths: {
        '/health': {
          get: {
            responses: {
              default: {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: { message: { type: 'string' } },
                      required: ['message'],
                    },
                  },
                },
              },
            },
          },
        },
      },
    } as any;

    const routes = fromOpenAPI(spec);
    const get = routes['/health']!.GET!;
    expect(get.response).toBeUndefined();
    expect(get.errorResponse).toBeDefined();
    const ok = await get.errorResponse!['~standard'].validate({ message: 'boom' });
    expect(ok.issues).toBeUndefined();
  });

  it('200 + default: response from 200, errorResponse from default', async () => {
    const spec = {
      openapi: '3.1.0',
      paths: {
        '/pets': {
          get: {
            responses: {
              200: {
                content: {
                  'application/json': { schema: { type: 'array', items: { type: 'string' } } },
                },
              },
              default: {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: { code: { type: 'integer' } },
                      required: ['code'],
                    },
                  },
                },
              },
            },
          },
        },
      },
    } as any;

    const routes = fromOpenAPI(spec);
    const get = routes['/pets']!.GET!;
    const okResponse = await get.response!['~standard'].validate(['a', 'b']);
    expect(okResponse.issues).toBeUndefined();
    const okError = await get.errorResponse!['~standard'].validate({ code: 500 });
    expect(okError.issues).toBeUndefined();
  });

  it('204 + default: no success validator, default feeds errorResponse', () => {
    const spec = {
      openapi: '3.1.0',
      paths: {
        '/things/{id}': {
          delete: {
            responses: {
              204: { description: 'no content' },
              default: {
                content: {
                  'application/json': { schema: { type: 'object' } },
                },
              },
            },
          },
        },
      },
    } as any;

    const routes = fromOpenAPI(spec);
    const del = routes['/things/{id}']!.DELETE!;
    expect(del.response).toBeUndefined();
    expect(del.errorResponse).toBeDefined();
  });

  it('explicit 4xx wins over default for the errorResponse slot', async () => {
    const spec = {
      openapi: '3.1.0',
      paths: {
        '/pets': {
          get: {
            responses: {
              200: { content: { 'application/json': { schema: { type: 'array' } } } },
              404: {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: { notFound: { type: 'boolean' } },
                      required: ['notFound'],
                    },
                  },
                },
              },
              default: {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: { generic: { type: 'boolean' } },
                      required: ['generic'],
                    },
                  },
                },
              },
            },
          },
        },
      },
    } as any;

    const routes = fromOpenAPI(spec);
    const err = routes['/pets']!.GET!.errorResponse!;
    const ok = await err['~standard'].validate({ notFound: true });
    expect(ok.issues).toBeUndefined();
    const wrongShape = await err['~standard'].validate({ generic: true });
    expect(wrongShape.issues).toBeDefined();
  });

  it('extractRouteSchemas applies the same default-as-error semantics', () => {
    const spec = {
      openapi: '3.1.0',
      paths: {
        '/health': {
          get: {
            responses: {
              default: {
                content: { 'application/json': { schema: { type: 'object' } } },
              },
            },
          },
        },
      },
    } as any;

    const { routes } = extractRouteSchemas(spec);
    const get = routes['/health']!.GET!;
    expect(get.response).toBeUndefined();
    expect(get.errorResponse).toEqual({ type: 'object' });
  });
});

// ---------------------------------------------------------------------------
// 4. +json structured-suffix and parameterized media types
// ---------------------------------------------------------------------------

describe('+json media types', () => {
  it('matches application/problem+json error bodies', async () => {
    const spec = {
      openapi: '3.1.0',
      paths: {
        '/pets': {
          get: {
            responses: {
              200: { content: { 'application/json': { schema: { type: 'array' } } } },
              400: {
                content: {
                  'application/problem+json': {
                    schema: {
                      type: 'object',
                      properties: { title: { type: 'string' } },
                      required: ['title'],
                    },
                  },
                },
              },
            },
          },
        },
      },
    } as any;

    const routes = fromOpenAPI(spec);
    const err = routes['/pets']!.GET!.errorResponse!;
    expect(err).toBeDefined();
    const ok = await err['~standard'].validate({ title: 'Bad Request' });
    expect(ok.issues).toBeUndefined();
  });

  it('matches parameterized application/json; charset=utf-8 bodies', async () => {
    const spec = {
      openapi: '3.1.0',
      paths: {
        '/pets': {
          post: {
            requestBody: {
              required: true,
              content: {
                'application/json; charset=utf-8': {
                  schema: {
                    type: 'object',
                    properties: { name: { type: 'string' } },
                    required: ['name'],
                  },
                },
              },
            },
            responses: {
              201: {
                content: {
                  'application/vnd.api+json': { schema: { type: 'object' } },
                },
              },
            },
          },
        },
      },
    } as any;

    const routes = fromOpenAPI(spec);
    const post = routes['/pets']!.POST!;
    expect(post.body).toBeDefined();
    expect(post.response).toBeDefined();
    const ok = await post.body!['~standard'].validate({ name: 'Rex' });
    expect(ok.issues).toBeUndefined();
  });

  it('prefers exact application/json over +json variants', async () => {
    const spec = {
      openapi: '3.1.0',
      paths: {
        '/pets': {
          get: {
            responses: {
              200: {
                content: {
                  'application/hal+json': {
                    schema: { type: 'object', properties: { hal: { type: 'boolean' } }, required: ['hal'] },
                  },
                  'application/json': {
                    schema: { type: 'object', properties: { plain: { type: 'boolean' } }, required: ['plain'] },
                  },
                },
              },
            },
          },
        },
      },
    } as any;

    const routes = fromOpenAPI(spec);
    const response = routes['/pets']!.GET!.response!;
    const ok = await response['~standard'].validate({ plain: true });
    expect(ok.issues).toBeUndefined();
    const halOnly = await response['~standard'].validate({ hal: true });
    expect(halOnly.issues).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 5. Optional request bodies
// ---------------------------------------------------------------------------

describe('optional request bodies', () => {
  const optionalBodySpec = {
    openapi: '3.1.0',
    paths: {
      '/search': {
        post: {
          // No `required: true` → OpenAPI defaults to optional.
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { q: { type: 'string' } },
                  required: ['q'],
                },
              },
            },
          },
          responses: {
            200: { content: { 'application/json': { schema: { type: 'array' } } } },
          },
        },
      },
    },
  } as any;

  it('optional body validator accepts undefined (createFetch validates omitted bodies)', async () => {
    const routes = fromOpenAPI(optionalBodySpec);
    const body = routes['/search']!.POST!.body!;

    const omitted = await body['~standard'].validate(undefined);
    expect(omitted.issues).toBeUndefined();
    expect(omitted.value).toBeUndefined();

    // A provided body is still fully validated.
    const ok = await body['~standard'].validate({ q: 'cats' });
    expect(ok.issues).toBeUndefined();
    const bad = await body['~standard'].validate({});
    expect(bad.issues).toBeDefined();
  });

  it('required body validator still rejects undefined', async () => {
    const spec = structuredClone(optionalBodySpec);
    spec.paths['/search'].post.requestBody.required = true;
    const routes = fromOpenAPI(spec);
    const body = routes['/search']!.POST!.body!;
    const omitted = await body['~standard'].validate(undefined);
    expect(omitted.issues).toBeDefined();
  });

  it('extractRouteSchemas marks optional bodies and fromJSONSchema honors the marker', async () => {
    const { routes, definitions } = extractRouteSchemas(optionalBodySpec);
    const bodySchema = routes['/search']!.POST!.body!;
    expect((bodySchema as any)['x-fetcher-optional']).toBe(true);

    // Round-trip through JSON (what the Vite plugin's virtual module does).
    const revived = JSON.parse(JSON.stringify(bodySchema));
    const validator = fromJSONSchema(revived, JSON.parse(JSON.stringify(definitions)));
    const omitted = await validator['~standard'].validate(undefined);
    expect(omitted.issues).toBeUndefined();
    const bad = await validator['~standard'].validate({});
    expect(bad.issues).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 6. Numeric param coercion
// ---------------------------------------------------------------------------

describe('numeric param coercion', () => {
  const spec = {
    openapi: '3.1.0',
    paths: {
      '/pets/{petId}': {
        get: {
          parameters: [
            { name: 'petId', in: 'path', required: true, schema: { type: 'integer' } },
            { name: 'limit', in: 'query', schema: { type: 'number' } },
            { name: 'tag', in: 'query', schema: { type: 'string' } },
            { name: 'ids', in: 'query', schema: { type: 'array', items: { type: 'integer' } } },
          ],
          responses: {
            200: { content: { 'application/json': { schema: { type: 'object' } } } },
          },
        },
      },
    },
  } as any;

  it('coerces numeric strings for integer path params', async () => {
    const routes = fromOpenAPI(spec);
    const params = routes['/pets/{petId}']!.GET!.params!;

    const fromString = await params['~standard'].validate({ petId: '42' });
    expect(fromString.issues).toBeUndefined();
    expect(fromString.value).toEqual({ petId: 42 });

    const fromNumber = await params['~standard'].validate({ petId: 42 });
    expect(fromNumber.issues).toBeUndefined();

    const garbage = await params['~standard'].validate({ petId: 'abc' });
    expect(garbage.issues).toBeDefined();

    // Integer constraint still enforced after coercion.
    const fractional = await params['~standard'].validate({ petId: '4.5' });
    expect(fractional.issues).toBeDefined();
  });

  it('coerces numeric strings (and arrays of them) for query params, leaves strings alone', async () => {
    const routes = fromOpenAPI(spec);
    const query = routes['/pets/{petId}']!.GET!.query!;

    const r = await query['~standard'].validate({ limit: '2.5', tag: '7', ids: ['1', '2'] });
    expect(r.issues).toBeUndefined();
    // `tag` is a string param — '7' must NOT be coerced.
    expect(r.value).toEqual({ limit: 2.5, tag: '7', ids: [1, 2] });
  });

  it('does NOT coerce body properties', async () => {
    const bodySpec = {
      openapi: '3.1.0',
      paths: {
        '/pets': {
          post: {
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { id: { type: 'integer' } },
                    required: ['id'],
                  },
                },
              },
            },
            responses: {},
          },
        },
      },
    } as any;

    const routes = fromOpenAPI(bodySpec);
    const body = routes['/pets']!.POST!.body!;
    const r = await body['~standard'].validate({ id: '42' });
    expect(r.issues).toBeDefined();
  });

  it('resolves $ref-typed parameter schemas for coercion detection', async () => {
    const refSpec = {
      openapi: '3.1.0',
      paths: {
        '/pets/{petId}': {
          get: {
            parameters: [
              { name: 'petId', in: 'path', required: true, schema: { $ref: '#/components/schemas/PetId' } },
            ],
            responses: {},
          },
        },
      },
      components: { schemas: { PetId: { type: 'integer' } } },
    } as any;

    const routes = fromOpenAPI(refSpec);
    const params = routes['/pets/{petId}']!.GET!.params!;
    const r = await params['~standard'].validate({ petId: '7' });
    expect(r.issues).toBeUndefined();
    expect(r.value).toEqual({ petId: 7 });
  });

  it('does not coerce when the type array also admits strings', async () => {
    const mixedSpec = {
      openapi: '3.1.0',
      paths: {
        '/x': {
          get: {
            parameters: [
              { name: 'v', in: 'query', schema: { type: ['string', 'integer'] } },
            ],
            responses: {},
          },
        },
      },
    } as any;

    const routes = fromOpenAPI(mixedSpec);
    const query = routes['/x']!.GET!.query!;
    const r = await query['~standard'].validate({ v: '42' });
    expect(r.issues).toBeUndefined();
    expect(r.value).toEqual({ v: '42' });
  });
});

// ---------------------------------------------------------------------------
// 7. __proto__ safety
// ---------------------------------------------------------------------------

describe('__proto__ safety', () => {
  it('fromJSONSchema handles a property literally named __proto__', async () => {
    const schema = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"number"}},"required":["__proto__"]}',
    );
    const validator = fromJSONSchema(schema);

    const ok = await validator['~standard'].validate(JSON.parse('{"__proto__": 5}'));
    expect(ok.issues).toBeUndefined();

    const missing = await validator['~standard'].validate({});
    expect(missing.issues).toBeDefined();
  });

  it('extractComponentSchemas keeps a component named __proto__', () => {
    const spec = JSON.parse(`{
      "openapi": "3.1.0",
      "components": { "schemas": {
        "__proto__": { "type": "object", "properties": { "x": { "type": "number" } } },
        "Pet": { "type": "object" }
      } }
    }`);
    const { schemas } = extractComponentSchemas(spec);
    expect(Object.keys(schemas).sort()).toEqual(['Pet', '__proto__'].sort());
  });

  it('fromOpenAPI resolves a $ref to a component named __proto__', async () => {
    const spec = JSON.parse(`{
      "openapi": "3.1.0",
      "paths": { "/x": { "post": {
        "requestBody": { "required": true, "content": { "application/json": {
          "schema": { "$ref": "#/components/schemas/__proto__" }
        } } },
        "responses": {}
      } } },
      "components": { "schemas": {
        "__proto__": { "type": "object", "properties": { "x": { "type": "number" } }, "required": ["x"] }
      } }
    }`);

    const routes = fromOpenAPI(spec);
    const body = routes['/x']!.POST!.body!;
    const ok = await body['~standard'].validate({ x: 1 });
    expect(ok.issues).toBeUndefined();
    const bad = await body['~standard'].validate({});
    expect(bad.issues).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// End-to-end through createFetch: the consequences of the validator-level
// fixes above must hold on the actual request path. `createFetch` validates
// the body whenever the route declares a schema (even when omitted) and
// puts the VALIDATED output on the wire.
// ---------------------------------------------------------------------------

describe('createFetch + fromOpenAPI end-to-end', () => {
  it('a call omitting an optional body succeeds (validate(undefined) passes)', async () => {
    const spec = {
      openapi: '3.1.0',
      paths: {
        '/search': {
          post: {
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { q: { type: 'string' } },
                    required: ['q'],
                  },
                },
              },
            },
            responses: {
              200: { content: { 'application/json': { schema: { type: 'array' } } } },
            },
          },
        },
      },
    } as any;

    const mockFetch = async (req: Request): Promise<Response> => {
      expect(req.method).toBe('POST');
      expect(req.body).toBeNull();
      return new Response('[]', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const f = createFetch({
      baseUrl: 'https://api.example.test',
      routes: fromOpenAPI(spec),
      fetch: mockFetch,
    });

    const result = await f('/search', { method: 'POST' }).result();
    expect(result.ok).toBe(true);
  });

  it('a numeric-string path param validates, coerces, and interpolates', async () => {
    const spec = {
      openapi: '3.1.0',
      paths: {
        '/pets/{petId}': {
          get: {
            parameters: [
              { name: 'petId', in: 'path', required: true, schema: { type: 'integer' } },
            ],
            responses: {
              200: { content: { 'application/json': { schema: { type: 'object' } } } },
            },
          },
        },
      },
    } as any;

    let requestedUrl = '';
    const mockFetch = async (req: Request): Promise<Response> => {
      requestedUrl = req.url;
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const f = createFetch({
      baseUrl: 'https://api.example.test',
      routes: fromOpenAPI(spec),
      fetch: mockFetch,
    });

    const ok = await f('/pets/{petId}', { method: 'GET', params: { petId: '42' } }).result();
    expect(ok.ok).toBe(true);
    expect(requestedUrl).toBe('https://api.example.test/pets/42');

    const bad = await f('/pets/{petId}', { method: 'GET', params: { petId: 'abc' } }).result();
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error.kind).toBe('validation');
      if (bad.error.kind === 'validation')
        expect(bad.error.location).toBe('params');
    }
  });
});

// ---------------------------------------------------------------------------
// 8. HEAD / OPTIONS parity with HttpMethod
// ---------------------------------------------------------------------------

describe('HEAD/OPTIONS extraction', () => {
  it('extracts head and options operations', () => {
    const spec = {
      openapi: '3.1.0',
      paths: {
        '/status': {
          head: { responses: { 200: { description: 'ok' } } },
          options: {
            responses: {
              200: { content: { 'application/json': { schema: { type: 'object' } } } },
            },
          },
        },
      },
    } as any;

    const routes = fromOpenAPI(spec);
    expect(routes['/status']!.HEAD).toBeDefined();
    expect(routes['/status']!.OPTIONS).toBeDefined();
    expect(routes['/status']!.OPTIONS!.response).toBeDefined();
  });
});

describe('numeric coercion losslessness + recursion guards (review follow-up)', () => {
  const paramSpec = (schema: Record<string, unknown>): any => ({
    openapi: '3.1.0',
    paths: {
      '/items/{id}': {
        get: {
          parameters: [{ name: 'id', in: 'path', required: true, schema }],
          responses: { 200: { content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
    },
  });

  it('does not coerce numeric strings beyond 2^53 (int64 snowflake IDs stay loud errors)', async () => {
    const routes = fromOpenAPI(paramSpec({ type: 'integer' }));
    const params = routes['/items/{id}']!.GET!.params!;

    // 2^53 + 1 — Number() would silently round to a DIFFERENT resource ID.
    const big = await params['~standard'].validate({ id: '9007199254740993' });
    expect(big.issues).toBeDefined();

    // Exponent form would become scientific notation in the URL.
    const expForm = await params['~standard'].validate({ id: '1e3' });
    expect(expForm.issues).toBeDefined();

    // Round-trippable values still coerce.
    const fine = await params['~standard'].validate({ id: '9007199254740991' });
    expect(fine.issues).toBeUndefined();
    expect(fine.value).toEqual({ id: 9007199254740991 });
  });

  it('a self-referential array parameter schema does not hang or overflow', () => {
    const spec: any = {
      openapi: '3.1.0',
      components: { schemas: { Nest: { type: 'array', items: { $ref: '#/components/schemas/Nest' } } } },
      paths: {
        '/items/{id}': {
          get: {
            parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/Nest' } }],
            responses: { 200: { content: { 'application/json': { schema: { type: 'object' } } } } },
          },
        },
      },
    };
    // Pre-fix this hung forever on Bun (proper tail calls) — completing at
    // all is the assertion; a deadline guards against regress-to-hang.
    const start = performance.now();
    const routes = fromOpenAPI(spec);
    expect(routes['/items/{id}']!.GET).toBeDefined();
    expect(performance.now() - start).toBeLessThan(2_000);
  });

  it('x-fetcher markers in user-supplied spec schemas are stripped, not honored', async () => {
    const spec: any = {
      openapi: '3.1.0',
      paths: {
        '/items': {
          post: {
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  // Hostile/accidental marker: must NOT disable required-body
                  // enforcement or enable body coercion.
                  schema: { 'type': 'object', 'x-fetcher-optional': true, 'x-fetcher-coerce': ['n'], 'properties': { n: { type: 'integer' } }, 'required': ['n'] },
                },
              },
            },
            responses: { 200: { content: { 'application/json': { schema: { type: 'object' } } } } },
          },
        },
      },
    };
    const routes = fromOpenAPI(spec);
    const body = routes['/items']!.POST!.body!;
    const omitted = await body['~standard'].validate(undefined);
    expect(omitted.issues).toBeDefined(); // required body still required
    const coerced = await body['~standard'].validate({ n: '42' });
    expect(coerced.issues).toBeDefined(); // bodies never coerce
  });
});
