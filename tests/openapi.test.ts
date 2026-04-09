import { describe, expect, it } from 'bun:test';
import { fromOpenAPI } from '../src/openapi.ts';
import petstoreSpec from './fixtures/petstore.json';

describe('fromOpenAPI', () => {
  it('extracts routes from a minimal spec', async () => {
    const spec = {
      openapi: '3.1.0',
      paths: {
        '/users': {
          get: {
            responses: {
              200: {
                content: {
                  'application/json': {
                    schema: {
                      type: 'array' as const,
                      items: {
                        type: 'object' as const,
                        properties: {
                          id: { type: 'integer' as const },
                          name: { type: 'string' as const },
                        },
                      },
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
                    type: 'object' as const,
                    properties: {
                      name: { type: 'string' as const },
                    },
                    required: ['name'],
                  },
                },
              },
            },
            responses: {
              201: {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object' as const,
                      properties: {
                        id: { type: 'integer' as const },
                        name: { type: 'string' as const },
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

    const routes = fromOpenAPI(spec);

    expect(routes['/users']).toBeDefined();
    expect(routes['/users']!.GET).toBeDefined();
    expect(routes['/users']!.POST).toBeDefined();

    // Response schema should validate
    const getRoute = routes['/users']!.GET!;
    expect(getRoute.response).toBeDefined();
    const responseResult = await getRoute.response!['~standard'].validate([{ id: 1, name: 'Alice' }]);
    expect(responseResult.issues).toBeUndefined();
    expect(responseResult.value).toEqual([{ id: 1, name: 'Alice' }]);

    // Body schema should validate
    const postRoute = routes['/users']!.POST!;
    expect(postRoute.body).toBeDefined();
    const okBody = await postRoute.body!['~standard'].validate({ name: 'Bob' });
    expect(okBody.value).toEqual({ name: 'Bob' });
    const badBody = await postRoute.body!['~standard'].validate({});
    expect(badBody.issues).toBeDefined();
  });

  it('extracts path parameters', async () => {
    const spec = {
      openapi: '3.1.0',
      paths: {
        '/users/{id}': {
          get: {
            parameters: [
              {
                name: 'id',
                in: 'path' as const,
                required: true,
                schema: { type: 'string' as const },
              },
            ],
            responses: {
              200: {
                content: {
                  'application/json': {
                    schema: { type: 'object' as const },
                  },
                },
              },
            },
          },
        },
      },
    };

    const routes = fromOpenAPI(spec);
    const getRoute = routes['/users/{id}']!.GET!;
    expect(getRoute.params).toBeDefined();
    const paramsResult = await getRoute.params!['~standard'].validate({ id: '123' });
    expect(paramsResult.value).toEqual({ id: '123' });
  });

  it('extracts query parameters', () => {
    const spec = {
      openapi: '3.1.0',
      paths: {
        '/users': {
          get: {
            parameters: [
              {
                name: 'page',
                in: 'query' as const,
                schema: { type: 'integer' as const },
              },
              {
                name: 'limit',
                in: 'query' as const,
                schema: { type: 'integer' as const },
              },
            ],
            responses: {
              200: {
                content: {
                  'application/json': {
                    schema: { type: 'array' as const },
                  },
                },
              },
            },
          },
        },
      },
    };

    const routes = fromOpenAPI(spec);
    const getRoute = routes['/users']!.GET!;
    expect(getRoute.query).toBeDefined();
  });

  it('extracts error response schemas', async () => {
    const spec = {
      openapi: '3.1.0',
      paths: {
        '/users': {
          get: {
            responses: {
              200: {
                content: {
                  'application/json': {
                    schema: { type: 'array' as const },
                  },
                },
              },
              400: {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object' as const,
                      properties: {
                        message: { type: 'string' as const },
                        code: { type: 'string' as const },
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

    const routes = fromOpenAPI(spec);
    const getRoute = routes['/users']!.GET!;
    expect(getRoute.errorResponse).toBeDefined();
    const errResult = await getRoute.errorResponse!['~standard'].validate({
      message: 'Bad request',
      code: 'INVALID',
    });
    expect(errResult.value).toEqual({ message: 'Bad request', code: 'INVALID' });
  });

  it('returns empty routes for spec with no paths', () => {
    const routes = fromOpenAPI({ openapi: '3.1.0' });
    expect(routes).toEqual({});
  });

  it('ignores non-HTTP method keys in path items', () => {
    const spec = {
      openapi: '3.1.0',
      paths: {
        '/users': {
          summary: 'User operations',
          get: {
            responses: {
              200: {
                content: {
                  'application/json': {
                    schema: { type: 'array' as const },
                  },
                },
              },
            },
          },
        },
      },
    } as any;

    const routes = fromOpenAPI(spec);
    expect(routes['/users']!.GET).toBeDefined();
    expect(Object.keys(routes['/users']!)).toEqual(['GET']);
  });

  it('accepts a real JSON-imported spec without a cast', async () => {
    // Regression for §4.A4 — `import spec from './petstore.json'` widens
    // every object to include literal `description`/`summary`/etc. fields,
    // which the previous tight `OpenAPISpec` interface refused. Passing
    // `petstoreSpec` directly (no `as`, no cast) must compile and work.
    const routes = fromOpenAPI(petstoreSpec);

    expect(routes['/pets']).toBeDefined();
    expect(routes['/pets']!.GET).toBeDefined();
    expect(routes['/pets']!.POST).toBeDefined();
    expect(routes['/pets/{petId}']!.GET).toBeDefined();

    // Body schema (POST /pets) accepts a valid pet
    const postBody = routes['/pets']!.POST!.body!;
    const ok = await postBody['~standard'].validate({ id: 1, name: 'Rex' });
    expect(ok.issues).toBeUndefined();

    // And rejects a missing required field
    const bad = await postBody['~standard'].validate({ name: 'Rex' });
    expect(bad.issues).toBeDefined();

    // Path parameter on /pets/{petId}
    const params = routes['/pets/{petId}']!.GET!.params!;
    const okParams = await params['~standard'].validate({ petId: '42' });
    expect(okParams.value).toEqual({ petId: '42' });
  });
});
