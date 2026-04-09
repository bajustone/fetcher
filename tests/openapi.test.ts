import { describe, it, expect } from "bun:test";
import { fromOpenAPI } from "../src/openapi.ts";

describe("fromOpenAPI", () => {
  it("extracts routes from a minimal spec", () => {
    const spec = {
      openapi: "3.1.0",
      paths: {
        "/users": {
          get: {
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: {
                      type: "array" as const,
                      items: {
                        type: "object" as const,
                        properties: {
                          id: { type: "integer" as const },
                          name: { type: "string" as const },
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
                "application/json": {
                  schema: {
                    type: "object" as const,
                    properties: {
                      name: { type: "string" as const },
                    },
                    required: ["name"],
                  },
                },
              },
            },
            responses: {
              "201": {
                content: {
                  "application/json": {
                    schema: {
                      type: "object" as const,
                      properties: {
                        id: { type: "integer" as const },
                        name: { type: "string" as const },
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

    expect(routes["/users"]).toBeDefined();
    expect(routes["/users"]!["GET"]).toBeDefined();
    expect(routes["/users"]!["POST"]).toBeDefined();

    // Response schema should validate
    const getRoute = routes["/users"]!["GET"]!;
    expect(getRoute.response).toBeDefined();
    const result = getRoute.response!.parse([{ id: 1, name: "Alice" }]);
    expect(result).toEqual([{ id: 1, name: "Alice" }]);

    // Body schema should validate
    const postRoute = routes["/users"]!["POST"]!;
    expect(postRoute.body).toBeDefined();
    expect(postRoute.body!.parse({ name: "Bob" })).toEqual({ name: "Bob" });
    expect(() => postRoute.body!.parse({})).toThrow();
  });

  it("extracts path parameters", () => {
    const spec = {
      openapi: "3.1.0",
      paths: {
        "/users/{id}": {
          get: {
            parameters: [
              {
                name: "id",
                in: "path" as const,
                required: true,
                schema: { type: "string" as const },
              },
            ],
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: { type: "object" as const },
                  },
                },
              },
            },
          },
        },
      },
    };

    const routes = fromOpenAPI(spec);
    const getRoute = routes["/users/{id}"]!["GET"]!;
    expect(getRoute.params).toBeDefined();
    expect(getRoute.params!.parse({ id: "123" })).toEqual({ id: "123" });
  });

  it("extracts query parameters", () => {
    const spec = {
      openapi: "3.1.0",
      paths: {
        "/users": {
          get: {
            parameters: [
              {
                name: "page",
                in: "query" as const,
                schema: { type: "integer" as const },
              },
              {
                name: "limit",
                in: "query" as const,
                schema: { type: "integer" as const },
              },
            ],
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: { type: "array" as const },
                  },
                },
              },
            },
          },
        },
      },
    };

    const routes = fromOpenAPI(spec);
    const getRoute = routes["/users"]!["GET"]!;
    expect(getRoute.query).toBeDefined();
  });

  it("extracts error response schemas", () => {
    const spec = {
      openapi: "3.1.0",
      paths: {
        "/users": {
          get: {
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: { type: "array" as const },
                  },
                },
              },
              "400": {
                content: {
                  "application/json": {
                    schema: {
                      type: "object" as const,
                      properties: {
                        message: { type: "string" as const },
                        code: { type: "string" as const },
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
    const getRoute = routes["/users"]!["GET"]!;
    expect(getRoute.errorResponse).toBeDefined();
    expect(
      getRoute.errorResponse!.parse({ message: "Bad request", code: "INVALID" }),
    ).toEqual({ message: "Bad request", code: "INVALID" });
  });

  it("returns empty routes for spec with no paths", () => {
    const routes = fromOpenAPI({ openapi: "3.1.0" });
    expect(routes).toEqual({});
  });

  it("ignores non-HTTP method keys in path items", () => {
    const spec = {
      openapi: "3.1.0",
      paths: {
        "/users": {
          summary: "User operations",
          get: {
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: { type: "array" as const },
                  },
                },
              },
            },
          },
        },
      },
    } as any;

    const routes = fromOpenAPI(spec);
    expect(routes["/users"]!["GET"]).toBeDefined();
    expect(Object.keys(routes["/users"]!)).toEqual(["GET"]);
  });
});
