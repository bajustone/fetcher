import { describe, expect, it } from 'bun:test';
import {
  bundleComponent,
  extractComponentSchemas,
  fromOpenAPI,
  JSON_SCHEMA_DIALECT,
  translateDialect,
} from '../src/openapi.ts';
import dialect31Spec from './fixtures/dialect-3.1.json';
import dialectSpec from './fixtures/dialect.json';
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

describe('translateDialect', () => {
  it('rewrites nullable: true to a type array with "null"', () => {
    const result = translateDialect({
      type: 'string',
      nullable: true,
    }) as any;
    expect(result.nullable).toBeUndefined();
    expect(result.type).toEqual(['string', 'null']);
  });

  it('appends "null" to an existing type array', () => {
    const result = translateDialect({
      type: ['string', 'number'],
      nullable: true,
    }) as any;
    expect(result.type).toEqual(['string', 'number', 'null']);
  });

  it('converts Draft-4 boolean exclusiveMinimum to Draft-6+ numeric', () => {
    const result = translateDialect({
      type: 'integer',
      minimum: 0,
      exclusiveMinimum: true,
    }) as any;
    expect(result.exclusiveMinimum).toBe(0);
    expect(result.minimum).toBeUndefined();
  });

  it('converts Draft-4 boolean exclusiveMaximum to numeric and drops exclusiveMaximum: false', () => {
    const trueCase = translateDialect({
      type: 'integer',
      maximum: 100,
      exclusiveMaximum: true,
    }) as any;
    expect(trueCase.exclusiveMaximum).toBe(100);
    expect(trueCase.maximum).toBeUndefined();

    const falseCase = translateDialect({
      type: 'integer',
      maximum: 100,
      exclusiveMaximum: false,
    }) as any;
    // Boolean false form: drop exclusiveMaximum, keep maximum as-is
    expect(falseCase.exclusiveMaximum).toBeUndefined();
    expect(falseCase.maximum).toBe(100);
  });

  it('moves example to examples (array)', () => {
    const result = translateDialect({ type: 'string', example: 'demo' } as any) as any;
    expect(result.example).toBeUndefined();
    expect(result.examples).toEqual(['demo']);
  });

  it('preserves existing examples and does not overwrite from example', () => {
    const result = translateDialect({
      type: 'string',
      example: 'demo',
      examples: ['preserved'],
    } as any) as any;
    expect(result.examples).toEqual(['preserved']);
  });

  it('drops xml and externalDocs keywords', () => {
    const result = translateDialect({
      type: 'object',
      xml: { name: 'X' },
      externalDocs: { url: 'u' },
    } as any) as any;
    expect(result.xml).toBeUndefined();
    expect(result.externalDocs).toBeUndefined();
  });

  it('preserves discriminator, readOnly, writeOnly intact', () => {
    const result = translateDialect({
      type: 'object',
      discriminator: { propertyName: 'kind' },
      properties: {
        a: { type: 'string', readOnly: true },
        b: { type: 'string', writeOnly: true },
      },
    } as any) as any;
    expect(result.discriminator).toEqual({ propertyName: 'kind' });
    expect(result.properties.a.readOnly).toBe(true);
    expect(result.properties.b.writeOnly).toBe(true);
  });

  it('recurses into properties, items, oneOf, anyOf, allOf, additionalProperties', () => {
    const result = translateDialect({
      type: 'object',
      properties: {
        inItems: { type: 'array', items: { type: 'string', nullable: true } },
        inAdd: { type: 'object', additionalProperties: { type: 'string', nullable: true } },
        inOneOf: { oneOf: [{ type: 'string', nullable: true }] },
        inAnyOf: { anyOf: [{ type: 'string', nullable: true }] },
        inAllOf: { allOf: [{ type: 'string', nullable: true }] },
      },
    }) as any;
    expect(result.properties.inItems.items.type).toEqual(['string', 'null']);
    expect(result.properties.inAdd.additionalProperties.type).toEqual(['string', 'null']);
    expect(result.properties.inOneOf.oneOf[0].type).toEqual(['string', 'null']);
    expect(result.properties.inAnyOf.anyOf[0].type).toEqual(['string', 'null']);
    expect(result.properties.inAllOf.allOf[0].type).toEqual(['string', 'null']);
  });

  it('does not mutate the input', () => {
    const input = { type: 'string', nullable: true };
    translateDialect(input);
    expect(input.nullable).toBe(true);
    expect(input.type).toBe('string');
  });
});

describe('bundleComponent', () => {
  it('produces a self-contained schema with #/$defs/X refs and a local $defs', () => {
    const translated: Record<string, any> = {
      UsesAddress: {
        type: 'object',
        properties: { address: { $ref: '#/components/schemas/Address' } },
      },
      Address: {
        type: 'object',
        properties: { city: { type: 'string' } },
      },
    };
    const bundled = bundleComponent('UsesAddress', translated) as any;
    expect(bundled.properties.address.$ref).toBe('#/$defs/Address');
    expect(bundled.$defs.Address).toBeDefined();
    expect(bundled.$defs.Address.properties.city.type).toBe('string');
  });

  it('includes only transitively reached components in $defs', () => {
    const translated: Record<string, any> = {
      UsesAddress: {
        type: 'object',
        properties: { address: { $ref: '#/components/schemas/Address' } },
      },
      Address: {
        type: 'object',
        properties: { country: { $ref: '#/components/schemas/Country' } },
      },
      Country: { type: 'object', properties: { code: { type: 'string' } } },
      Unrelated: { type: 'object', properties: { x: { type: 'string' } } },
    };
    const bundled = bundleComponent('UsesAddress', translated) as any;
    expect(Object.keys(bundled.$defs).sort()).toEqual(['Address', 'Country']);
    expect(bundled.$defs.Unrelated).toBeUndefined();
  });

  it('handles self-reference by placing the component in its own $defs', () => {
    const translated: Record<string, any> = {
      Tree: {
        type: 'object',
        properties: {
          children: {
            type: 'array',
            items: { $ref: '#/components/schemas/Tree' },
          },
        },
      },
    };
    const bundled = bundleComponent('Tree', translated) as any;
    expect(bundled.properties.children.items.$ref).toBe('#/$defs/Tree');
    expect(bundled.$defs.Tree).toBeDefined();
    expect(bundled.$defs.Tree.properties.children.items.$ref).toBe('#/$defs/Tree');
  });

  it('handles mutual recursion (A ↔ B)', () => {
    const translated: Record<string, any> = {
      Node: {
        type: 'object',
        properties: { edge: { $ref: '#/components/schemas/Edge' } },
      },
      Edge: {
        type: 'object',
        properties: { to: { $ref: '#/components/schemas/Node' } },
      },
    };
    const bundled = bundleComponent('Node', translated) as any;
    expect(bundled.properties.edge.$ref).toBe('#/$defs/Edge');
    expect(bundled.$defs.Edge.properties.to.$ref).toBe('#/$defs/Node');
    expect(bundled.$defs.Node).toBeDefined();
  });

  it('omits $defs when the component has no refs', () => {
    const translated: Record<string, any> = {
      Plain: { type: 'object', properties: { x: { type: 'string' } } },
    };
    const bundled = bundleComponent('Plain', translated) as any;
    expect(bundled.$defs).toBeUndefined();
  });

  it('returns undefined for a missing component name', () => {
    expect(bundleComponent('NotThere', {})).toBeUndefined();
  });

  it('attaches the draft-2020-12 $schema marker', () => {
    const translated: Record<string, any> = {
      Plain: { type: 'object' },
    };
    const bundled = bundleComponent('Plain', translated) as any;
    expect(bundled.$schema).toBe(JSON_SCHEMA_DIALECT);
  });
});

describe('extractComponentSchemas', () => {
  it('runs every component through translateDialect + bundleComponent', () => {
    const { schemas } = extractComponentSchemas(dialectSpec as any);

    // nullable translated:
    expect((schemas.NullableUser as any).properties.nickname.type).toEqual(['string', 'null']);
    expect((schemas.NullableUser as any).properties.nickname.nullable).toBeUndefined();

    // Draft-4 boolean exclusiveMinimum translated:
    expect((schemas.BoundedNumber as any).properties.age.exclusiveMinimum).toBe(0);
    expect((schemas.BoundedNumber as any).properties.age.minimum).toBeUndefined();
    expect((schemas.BoundedNumber as any).properties.age.exclusiveMaximum).toBeUndefined();
    expect((schemas.BoundedNumber as any).properties.age.maximum).toBe(150);

    // example → examples, xml/externalDocs dropped:
    expect((schemas.WithExample as any).properties.tag.examples).toEqual(['demo']);
    expect((schemas.WithExample as any).xml).toBeUndefined();
    expect((schemas.WithExample as any).externalDocs).toBeUndefined();

    // Transitive $defs bundling:
    expect((schemas.UsesAddress as any).properties.address.$ref).toBe('#/$defs/Address');
    expect(Object.keys((schemas.UsesAddress as any).$defs).sort()).toEqual([
      'Address',
      'Country',
    ]);
  });

  it('emits the draft-2020-12 dialect marker on every component', () => {
    const { schemas } = extractComponentSchemas(dialectSpec as any);
    for (const schema of Object.values(schemas)) {
      expect((schema as any).$schema).toBe(JSON_SCHEMA_DIALECT);
    }
  });

  it('returns an empty map when the spec has no components.schemas', () => {
    const { schemas } = extractComponentSchemas({ openapi: '3.0.0' });
    expect(schemas).toEqual({});
  });
});

describe('OpenAPI 3.1 coverage', () => {
  describe('translateDialect idempotency on 3.1-native input', () => {
    it('leaves type: [..., "null"] unchanged (no nullable to translate)', () => {
      const input = { type: ['string', 'null'] } as any;
      const result = translateDialect(input) as any;
      expect(result.type).toEqual(['string', 'null']);
      expect(result.nullable).toBeUndefined();
    });

    it('does not duplicate "null" if type array already has it', () => {
      // translateDialect is idempotent — running it twice gives the same result.
      const input = { type: ['string', 'null'] } as any;
      const once = translateDialect(input) as any;
      const twice = translateDialect(once) as any;
      expect(twice.type).toEqual(['string', 'null']);
    });

    it('passes numeric exclusiveMinimum/exclusiveMaximum through unchanged', () => {
      const result = translateDialect({
        type: 'integer',
        exclusiveMinimum: 0,
        exclusiveMaximum: 150,
      } as any) as any;
      expect(result.exclusiveMinimum).toBe(0);
      expect(result.exclusiveMaximum).toBe(150);
      expect(result.minimum).toBeUndefined();
      expect(result.maximum).toBeUndefined();
    });

    it('preserves examples array unchanged', () => {
      const result = translateDialect({
        type: 'string',
        examples: ['a', 'b'],
      } as any) as any;
      expect(result.examples).toEqual(['a', 'b']);
    });

    it('preserves const keyword', () => {
      const result = translateDialect({
        type: 'string',
        const: 'active',
      } as any) as any;
      expect(result.const).toBe('active');
    });

    it('preserves $ref with sibling keywords (legal in 3.1)', () => {
      const result = translateDialect({
        description: 'a ref with a sibling description',
        $ref: '#/components/schemas/User',
      } as any) as any;
      expect(result.$ref).toBe('#/components/schemas/User');
      expect(result.description).toBe('a ref with a sibling description');
    });

    it('preserves $id at schema level', () => {
      const result = translateDialect({
        $id: 'https://example.com/schemas/User',
        type: 'object',
      } as any) as any;
      expect(result.$id).toBe('https://example.com/schemas/User');
    });
  });

  describe('bundleComponent on 3.1 schemas', () => {
    it('preserves component-local $defs when no cross-component refs are present', () => {
      const translated: Record<string, any> = {
        WithLocalDefs: {
          type: 'object',
          properties: { inner: { $ref: '#/$defs/Inner' } },
          $defs: { Inner: { type: 'string' } },
        },
      };
      const bundled = bundleComponent('WithLocalDefs', translated) as any;
      expect(bundled.$defs.Inner).toEqual({ type: 'string' });
      expect(bundled.properties.inner.$ref).toBe('#/$defs/Inner');
    });

    it('merges component-local $defs with transitively-reached components', () => {
      const translated: Record<string, any> = {
        WithLocalAndExternalDefs: {
          type: 'object',
          properties: {
            inner: { $ref: '#/$defs/Inner' },
            user: { $ref: '#/components/schemas/User' },
          },
          $defs: { Inner: { type: 'string' } },
        },
        User: { type: 'object', properties: { name: { type: 'string' } } },
      };
      const bundled = bundleComponent('WithLocalAndExternalDefs', translated) as any;
      // Both the local Inner and the transitively-reached User should be in $defs
      expect(bundled.$defs.Inner).toEqual({ type: 'string' });
      expect(bundled.$defs.User.properties.name.type).toBe('string');
      // Refs rewritten appropriately:
      expect(bundled.properties.inner.$ref).toBe('#/$defs/Inner');
      expect(bundled.properties.user.$ref).toBe('#/$defs/User');
    });

    it('preserves $ref siblings in 3.1-style schemas', () => {
      const translated: Record<string, any> = {
        RefWithSiblings: {
          description: 'sibling metadata on a $ref',
          $ref: '#/components/schemas/User',
        },
        User: { type: 'object' },
      };
      const bundled = bundleComponent('RefWithSiblings', translated) as any;
      expect(bundled.description).toBe('sibling metadata on a $ref');
      expect(bundled.$ref).toBe('#/$defs/User');
      expect(bundled.$defs.User).toEqual({ type: 'object' });
    });
  });

  describe('extractComponentSchemas on a 3.1 spec', () => {
    it('passes through 3.1-native shapes without mangling them', () => {
      const { schemas } = extractComponentSchemas(dialect31Spec as any);

      // type: [..., 'null'] preserved:
      expect((schemas.NullableUser as any).properties.nickname.type).toEqual(['string', 'null']);
      // numeric exclusive bounds preserved:
      expect((schemas.BoundedInt as any).exclusiveMinimum).toBe(0);
      expect((schemas.BoundedInt as any).exclusiveMaximum).toBe(150);
      // examples array preserved:
      expect((schemas.WithExamples as any).examples).toEqual(['active', 'dormant']);
      // const preserved:
      expect((schemas.StatusConst as any).const).toBe('active');
      // $ref with siblings preserved (3.1 allows this):
      expect((schemas.RefWithSiblings as any).description).toBe('A user ref with a sibling description');
      expect((schemas.RefWithSiblings as any).$ref).toBe('#/$defs/NullableUser');
    });

    it('merges component-local $defs with transitive component refs', () => {
      const { schemas } = extractComponentSchemas(dialect31Spec as any);
      const withBoth = schemas.WithLocalAndExternalDefs as any;
      // Local Inner preserved:
      expect(withBoth.$defs.Inner).toEqual({ type: 'string' });
      // Transitive NullableUser bundled in:
      expect(withBoth.$defs.NullableUser).toBeDefined();
      expect(withBoth.$defs.NullableUser.properties.nickname.type).toEqual(['string', 'null']);
    });

    it('emits the draft-2020-12 dialect marker on every component', () => {
      const { schemas } = extractComponentSchemas(dialect31Spec as any);
      for (const schema of Object.values(schemas)) {
        expect((schema as any).$schema).toBe(JSON_SCHEMA_DIALECT);
      }
    });
  });

  describe('fromOpenAPI on a 3.1 spec', () => {
    it('extracts routes from the 3.1 fixture and produces working validators', async () => {
      const routes = fromOpenAPI(dialect31Spec as any);

      const getRoute = routes['/pets']!.GET!;
      expect(getRoute.response).toBeDefined();

      const postRoute = routes['/pets']!.POST!;
      expect(postRoute.body).toBeDefined();

      // Body accepts a Pet with the 3.1 nullable field as either string or null.
      const okWithTag = await postRoute.body!['~standard'].validate({
        id: 1,
        name: 'Rex',
        tag: 'good-boy',
      });
      expect(okWithTag.issues).toBeUndefined();

      const okWithNull = await postRoute.body!['~standard'].validate({
        id: 1,
        name: 'Rex',
        tag: null,
      });
      expect(okWithNull.issues).toBeUndefined();

      const bad = await postRoute.body!['~standard'].validate({
        id: 'not-an-int',
        name: 'Rex',
      });
      expect(bad.issues).toBeDefined();
    });
  });
});
