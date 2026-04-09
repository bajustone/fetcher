import { describe, it, expect } from "bun:test";
import { createFetch } from "../src/fetcher.ts";
import { authBearer } from "../src/middleware.ts";
import type { Schema } from "../src/types.ts";

/** Helper to create a mock fetch that returns a JSON response */
function mockFetch(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): typeof globalThis.fetch {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
}

/** Helper to create a mock fetch that returns a text response */
function mockTextFetch(body: string, status = 200): typeof globalThis.fetch {
  return async () =>
    new Response(body, {
      status,
      headers: { "content-type": "text/plain" },
    });
}

/** Simple schema for testing */
function schema<T>(validate: (data: unknown) => T): Schema<T> {
  return { parse: validate };
}

describe("createFetch", () => {
  describe("basic fetch", () => {
    it("makes a GET request", async () => {
      const f = createFetch({
        baseUrl: "https://api.example.com",
        fetch: mockFetch({ message: "hello" }),
      });

      const response = await f("/test", { method: "GET" });
      expect(response.ok).toBe(true);
      expect(response.status).toBe(200);

      const { data, error } = await response.result();
      expect(data).toEqual({ message: "hello" });
      expect(error).toBeUndefined();
    });

    it("makes a POST request with JSON body", async () => {
      let capturedRequest: Request | null = null;
      const f = createFetch({
        baseUrl: "https://api.example.com",
        fetch: async (req) => {
          capturedRequest = req as Request;
          return new Response(JSON.stringify({ id: 1 }), {
            status: 201,
            headers: { "content-type": "application/json" },
          });
        },
      });

      const response = await f("/users", {
        method: "POST",
        body: { name: "Alice" },
      });

      expect(capturedRequest!.method).toBe("POST");
      expect(capturedRequest!.headers.get("content-type")).toBe("application/json");
      const sentBody = await capturedRequest!.json();
      expect(sentBody).toEqual({ name: "Alice" });

      const { data } = await response.result();
      expect(data).toEqual({ id: 1 });
    });

    it("returns a real Response — native methods work", async () => {
      const f = createFetch({
        baseUrl: "https://api.example.com",
        fetch: mockFetch({ key: "value" }),
      });

      const response = await f("/test", { method: "GET" });

      // Native .json() still works
      const json = await response.json();
      expect(json).toEqual({ key: "value" });
    });

    it("handles text responses", async () => {
      const f = createFetch({
        baseUrl: "https://api.example.com",
        fetch: mockTextFetch("plain text"),
      });

      const response = await f("/text", { method: "GET" });
      const { data } = await response.result();
      expect(data).toBe("plain text");
    });
  });

  describe("path parameters", () => {
    it("interpolates path params", async () => {
      let capturedUrl = "";
      const f = createFetch({
        baseUrl: "https://api.example.com",
        fetch: async (req) => {
          capturedUrl = (req as Request).url;
          return new Response(JSON.stringify({}), {
            headers: { "content-type": "application/json" },
          });
        },
      });

      await f("/users/{id}/posts/{postId}", {
        method: "GET",
        params: { id: "123", postId: "456" },
      });

      expect(capturedUrl).toBe("https://api.example.com/users/123/posts/456");
    });

    it("encodes path params", async () => {
      let capturedUrl = "";
      const f = createFetch({
        baseUrl: "https://api.example.com",
        fetch: async (req) => {
          capturedUrl = (req as Request).url;
          return new Response(JSON.stringify({}), {
            headers: { "content-type": "application/json" },
          });
        },
      });

      await f("/search/{query}", {
        method: "GET",
        params: { query: "hello world" },
      });

      expect(capturedUrl).toBe(
        "https://api.example.com/search/hello%20world",
      );
    });
  });

  describe("query parameters", () => {
    it("serializes query params", async () => {
      let capturedUrl = "";
      const f = createFetch({
        baseUrl: "https://api.example.com",
        fetch: async (req) => {
          capturedUrl = (req as Request).url;
          return new Response(JSON.stringify({}), {
            headers: { "content-type": "application/json" },
          });
        },
      });

      await f("/users", {
        method: "GET",
        query: { page: 1, limit: 10, active: true },
      });

      const url = new URL(capturedUrl);
      expect(url.searchParams.get("page")).toBe("1");
      expect(url.searchParams.get("limit")).toBe("10");
      expect(url.searchParams.get("active")).toBe("true");
    });

    it("skips undefined query params", async () => {
      let capturedUrl = "";
      const f = createFetch({
        baseUrl: "https://api.example.com",
        fetch: async (req) => {
          capturedUrl = (req as Request).url;
          return new Response(JSON.stringify({}), {
            headers: { "content-type": "application/json" },
          });
        },
      });

      await f("/users", {
        method: "GET",
        query: { page: 1, filter: undefined },
      });

      const url = new URL(capturedUrl);
      expect(url.searchParams.get("page")).toBe("1");
      expect(url.searchParams.has("filter")).toBe(false);
    });
  });

  describe("error responses", () => {
    it("returns error for non-ok responses", async () => {
      const f = createFetch({
        baseUrl: "https://api.example.com",
        fetch: mockFetch({ message: "Not found" }, 404),
      });

      const response = await f("/missing", { method: "GET" });
      expect(response.ok).toBe(false);
      expect(response.status).toBe(404);

      const { data, error } = await response.result();
      expect(data).toBeUndefined();
      expect(error).toEqual({ message: "Not found" });
    });

    it("handles text error responses", async () => {
      const f = createFetch({
        baseUrl: "https://api.example.com",
        fetch: mockTextFetch("Internal Server Error", 500),
      });

      const response = await f("/error", { method: "GET" });
      const { error } = await response.result();
      expect(error).toBe("Internal Server Error");
    });
  });

  describe("schema validation", () => {
    it("validates response with route schema", async () => {
      const userSchema = schema((data: unknown) => {
        const obj = data as Record<string, unknown>;
        if (typeof obj.name !== "string") throw new Error("name must be string");
        return obj as { name: string; age?: number };
      });

      const f = createFetch({
        baseUrl: "https://api.example.com",
        routes: {
          "/user": {
            GET: { response: userSchema },
          },
        },
        fetch: mockFetch({ name: "Alice", age: 30 }),
      });

      const response = await f("/user", { method: "GET" });
      const { data } = await response.result();
      expect(data).toEqual({ name: "Alice", age: 30 });
    });

    it("returns validation error when schema fails", async () => {
      const strictSchema = schema((data: unknown) => {
        const obj = data as Record<string, unknown>;
        if (typeof obj.name !== "string") throw new Error("name must be string");
        return obj;
      });

      const f = createFetch({
        baseUrl: "https://api.example.com",
        routes: {
          "/user": {
            GET: { response: strictSchema },
          },
        },
        fetch: mockFetch({ name: 42 }),
      });

      const response = await f("/user", { method: "GET" });
      const { data, error } = await response.result();
      expect(data).toBeUndefined();
      expect(error).toBeDefined();
    });

    it("validates with ad-hoc per-call schema", async () => {
      const mySchema = schema((data: unknown) => {
        return data as { count: number };
      });

      const f = createFetch({
        baseUrl: "https://api.example.com",
        fetch: mockFetch({ count: 42 }),
      });

      const response = await f("/stats", {
        method: "GET",
        responseSchema: mySchema,
      });

      const { data } = await response.result();
      expect(data).toEqual({ count: 42 });
    });

    it("validates request body against schema", async () => {
      const bodySchema = schema((data: unknown) => {
        const obj = data as Record<string, unknown>;
        if (!obj.email) throw new Error("email required");
        return obj as { email: string };
      });

      const f = createFetch({
        baseUrl: "https://api.example.com",
        routes: {
          "/login": {
            POST: { body: bodySchema },
          },
        },
        fetch: mockFetch({ token: "abc" }),
      });

      // Valid body passes
      const response = await f("/login", {
        method: "POST",
        body: { email: "test@example.com" },
      });
      expect(response.ok).toBe(true);

      // Invalid body throws
      expect(() =>
        f("/login", { method: "POST", body: {} }),
      ).toThrow("email required");
    });
  });

  describe("custom fetch", () => {
    it("uses per-call fetch override", async () => {
      const defaultMock = mockFetch({ from: "default" });
      const overrideMock = mockFetch({ from: "override" });

      const f = createFetch({
        baseUrl: "https://api.example.com",
        fetch: defaultMock,
      });

      // Uses default
      const r1 = await f("/test", { method: "GET" });
      const { data: d1 } = await r1.result();
      expect(d1).toEqual({ from: "default" });

      // Uses override (SvelteKit-style)
      const r2 = await f("/test", { method: "GET", fetch: overrideMock });
      const { data: d2 } = await r2.result();
      expect(d2).toEqual({ from: "override" });
    });
  });

  describe("default headers", () => {
    it("applies default headers", async () => {
      let capturedHeaders: Headers | null = null;
      const f = createFetch({
        baseUrl: "https://api.example.com",
        defaultHeaders: { "X-Api-Key": "secret123" },
        fetch: async (req) => {
          capturedHeaders = (req as Request).headers;
          return new Response(JSON.stringify({}), {
            headers: { "content-type": "application/json" },
          });
        },
      });

      await f("/test", { method: "GET" });
      expect(capturedHeaders!.get("x-api-key")).toBe("secret123");
    });

    it("per-call headers override defaults", async () => {
      let capturedHeaders: Headers | null = null;
      const f = createFetch({
        baseUrl: "https://api.example.com",
        defaultHeaders: { "X-Api-Key": "default" },
        fetch: async (req) => {
          capturedHeaders = (req as Request).headers;
          return new Response(JSON.stringify({}), {
            headers: { "content-type": "application/json" },
          });
        },
      });

      await f("/test", {
        method: "GET",
        headers: { "X-Api-Key": "override" },
      });
      expect(capturedHeaders!.get("x-api-key")).toBe("override");
    });
  });

  describe("middleware", () => {
    it("executes middleware in order", async () => {
      const order: string[] = [];

      const f = createFetch({
        baseUrl: "https://api.example.com",
        middleware: [
          async (_req, next) => {
            order.push("m1-before");
            const res = await next();
            order.push("m1-after");
            return res;
          },
          async (_req, next) => {
            order.push("m2-before");
            const res = await next();
            order.push("m2-after");
            return res;
          },
        ],
        fetch: async () => {
          order.push("fetch");
          return new Response(JSON.stringify({}), {
            headers: { "content-type": "application/json" },
          });
        },
      });

      await f("/test", { method: "GET" });
      expect(order).toEqual([
        "m1-before",
        "m2-before",
        "fetch",
        "m2-after",
        "m1-after",
      ]);
    });

    it("authBearer middleware attaches token", async () => {
      let capturedHeaders: Headers | null = null;

      const f = createFetch({
        baseUrl: "https://api.example.com",
        middleware: [authBearer(() => "my-token")],
        fetch: async (req) => {
          capturedHeaders = (req as Request).headers;
          return new Response(JSON.stringify({}), {
            headers: { "content-type": "application/json" },
          });
        },
      });

      await f("/test", { method: "GET" });
      expect(capturedHeaders!.get("authorization")).toBe("Bearer my-token");
    });

    it("authBearer skips when token is null", async () => {
      let capturedHeaders: Headers | null = null;

      const f = createFetch({
        baseUrl: "https://api.example.com",
        middleware: [authBearer(() => null)],
        fetch: async (req) => {
          capturedHeaders = (req as Request).headers;
          return new Response(JSON.stringify({}), {
            headers: { "content-type": "application/json" },
          });
        },
      });

      await f("/test", { method: "GET" });
      expect(capturedHeaders!.get("authorization")).toBeNull();
    });
  });
});
