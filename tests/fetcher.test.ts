import type { FetcherError, FetchFn, Schema } from '../src/types.ts';
import { describe, expect, it } from 'bun:test';
import { createFetch, extractErrorMessage, FetcherRequestError } from '../src/fetcher.ts';
import { authBearer } from '../src/middleware.ts';

/** Helper to create a mock fetch that returns a JSON response */
function mockFetch(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): FetchFn {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
}

/** Helper to create a mock fetch that returns a text response */
function mockTextFetch(body: string, status = 200): FetchFn {
  return async () =>
    new Response(body, {
      status,
      headers: { 'content-type': 'text/plain' },
    });
}

/** Simple Standard Schema V1 helper for testing */
function schema<T>(validate: (data: unknown) => T): Schema<T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'fetcher-test',
      validate: (value: unknown) => {
        try {
          return { value: validate(value) };
        }
        catch (err) {
          return {
            issues: [{ message: err instanceof Error ? err.message : String(err) }],
          };
        }
      },
    },
  };
}

describe('createFetch', () => {
  describe('basic fetch', () => {
    it('makes a GET request', async () => {
      const f = createFetch({
        baseUrl: 'https://api.example.com',
        fetch: mockFetch({ message: 'hello' }),
      });

      const response = await f('/test', { method: 'GET' });
      expect(response.ok).toBe(true);
      expect(response.status).toBe(200);

      const result = await response.result();
      expect(result.ok).toBe(true);
      if (result.ok)
        expect(result.data).toEqual({ message: 'hello' });
    });

    it('makes a POST request with JSON body', async () => {
      let capturedRequest: Request | null = null;
      const f = createFetch({
        baseUrl: 'https://api.example.com',
        fetch: async (req) => {
          capturedRequest = req as Request;
          return new Response(JSON.stringify({ id: 1 }), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          });
        },
      });

      const response = await f('/users', {
        method: 'POST',
        body: { name: 'Alice' },
      });

      expect(capturedRequest!.method).toBe('POST');
      expect(capturedRequest!.headers.get('content-type')).toBe('application/json');
      const sentBody = await capturedRequest!.json();
      expect(sentBody).toEqual({ name: 'Alice' });

      const result = await response.result();
      expect(result.ok).toBe(true);
      if (result.ok)
        expect(result.data).toEqual({ id: 1 });
    });

    it('returns a real Response — native methods work', async () => {
      const f = createFetch({
        baseUrl: 'https://api.example.com',
        fetch: mockFetch({ key: 'value' }),
      });

      const response = await f('/test', { method: 'GET' });

      // Native .json() still works
      const json = await response.json();
      expect(json).toEqual({ key: 'value' });
    });

    it('handles text responses', async () => {
      const f = createFetch({
        baseUrl: 'https://api.example.com',
        fetch: mockTextFetch('plain text'),
      });

      const response = await f('/text', { method: 'GET' });
      const result = await response.result();
      expect(result.ok).toBe(true);
      if (result.ok)
        expect(result.data).toBe('plain text');
    });
  });

  describe('promise .result() shorthand', () => {
    it('resolves to the same ResultData as the two-await form', async () => {
      const f = createFetch({
        baseUrl: 'https://api.example.com',
        fetch: mockFetch({ id: 1, name: 'Rex' }),
      });

      // Two-await form (existing)
      const response = await f('/pets', { method: 'GET' });
      const twoAwait = await response.result();

      // One-await form (new)
      const oneAwait = await f('/pets', { method: 'GET' }).result();

      expect(oneAwait).toEqual(twoAwait);
      expect(oneAwait.ok).toBe(true);
      if (oneAwait.ok)
        expect(oneAwait.data).toEqual({ id: 1, name: 'Rex' });
    });

    it('works with method shortcuts', async () => {
      const f = createFetch({
        baseUrl: 'https://api.example.com',
        fetch: mockFetch({ count: 42 }),
      });

      const result = await f.get('/count').result();
      expect(result.ok).toBe(true);
      if (result.ok)
        expect(result.data).toEqual({ count: 42 });
    });

    it('surfaces errors through the shorthand', async () => {
      const f = createFetch({
        baseUrl: 'https://api.example.com',
        fetch: async () => new Response(JSON.stringify({ error: 'not found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
      });

      const result = await f.get('/missing').result();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('http');
        if (result.error.kind === 'http')
          expect(result.error.status).toBe(404);
      }
    });
  });

  describe('path parameters', () => {
    it('interpolates path params', async () => {
      let capturedUrl = '';
      const f = createFetch({
        baseUrl: 'https://api.example.com',
        fetch: async (req) => {
          capturedUrl = (req as Request).url;
          return new Response(JSON.stringify({}), {
            headers: { 'content-type': 'application/json' },
          });
        },
      });

      await f('/users/{id}/posts/{postId}', {
        method: 'GET',
        params: { id: '123', postId: '456' },
      });

      expect(capturedUrl).toBe('https://api.example.com/users/123/posts/456');
    });

    it('encodes path params', async () => {
      let capturedUrl = '';
      const f = createFetch({
        baseUrl: 'https://api.example.com',
        fetch: async (req) => {
          capturedUrl = (req as Request).url;
          return new Response(JSON.stringify({}), {
            headers: { 'content-type': 'application/json' },
          });
        },
      });

      await f('/search/{query}', {
        method: 'GET',
        params: { query: 'hello world' },
      });

      expect(capturedUrl).toBe(
        'https://api.example.com/search/hello%20world',
      );
    });
  });

  describe('query parameters', () => {
    it('serializes query params', async () => {
      let capturedUrl = '';
      const f = createFetch({
        baseUrl: 'https://api.example.com',
        fetch: async (req) => {
          capturedUrl = (req as Request).url;
          return new Response(JSON.stringify({}), {
            headers: { 'content-type': 'application/json' },
          });
        },
      });

      await f('/users', {
        method: 'GET',
        query: { page: 1, limit: 10, active: true },
      });

      const url = new URL(capturedUrl);
      expect(url.searchParams.get('page')).toBe('1');
      expect(url.searchParams.get('limit')).toBe('10');
      expect(url.searchParams.get('active')).toBe('true');
    });

    it('skips undefined query params', async () => {
      let capturedUrl = '';
      const f = createFetch({
        baseUrl: 'https://api.example.com',
        fetch: async (req) => {
          capturedUrl = (req as Request).url;
          return new Response(JSON.stringify({}), {
            headers: { 'content-type': 'application/json' },
          });
        },
      });

      await f('/users', {
        method: 'GET',
        query: { page: 1, filter: undefined },
      });

      const url = new URL(capturedUrl);
      expect(url.searchParams.get('page')).toBe('1');
      expect(url.searchParams.has('filter')).toBe(false);
    });
  });

  describe('error responses', () => {
    it('returns kind:http error for non-ok JSON responses', async () => {
      const f = createFetch({
        baseUrl: 'https://api.example.com',
        fetch: mockFetch({ message: 'Not found' }, 404),
      });

      const response = await f('/missing', { method: 'GET' });
      expect(response.ok).toBe(false);
      expect(response.status).toBe(404);

      const result = await response.result();
      expect(result.ok).toBe(false);
      if (!result.ok && result.error.kind === 'http') {
        expect(result.error.status).toBe(404);
        expect(result.error.body).toEqual({ message: 'Not found' });
      }
      else {
        throw new Error('expected kind:http error');
      }
    });

    it('returns kind:http error for non-ok text responses', async () => {
      const f = createFetch({
        baseUrl: 'https://api.example.com',
        fetch: mockTextFetch('Internal Server Error', 500),
      });

      const response = await f('/error', { method: 'GET' });
      const result = await response.result();
      expect(result.ok).toBe(false);
      if (!result.ok && result.error.kind === 'http') {
        expect(result.error.status).toBe(500);
        expect(result.error.body).toBe('Internal Server Error');
      }
      else {
        throw new Error('expected kind:http error');
      }
    });

    it('returns kind:network error when the underlying fetch rejects', async () => {
      const networkFailure = new Error('connection refused');
      const f = createFetch({
        baseUrl: 'https://api.example.com',

        fetch: async () => {
          throw networkFailure;
        },
      });

      // Calling f never throws — the rejection surfaces via .result().
      const response = await f('/test', { method: 'GET' });
      const result = await response.result();
      expect(result.ok).toBe(false);
      if (!result.ok && result.error.kind === 'network') {
        expect(result.error.cause).toBe(networkFailure);
      }
      else {
        throw new Error('expected kind:network error');
      }
    });
  });

  describe('schema validation', () => {
    it('validates response with route schema', async () => {
      const userSchema = schema((data: unknown) => {
        const obj = data as Record<string, unknown>;
        if (typeof obj.name !== 'string')
          throw new Error('name must be string');
        return obj as { name: string; age?: number };
      });

      const f = createFetch({
        baseUrl: 'https://api.example.com',
        routes: {
          '/user': {
            GET: { response: userSchema },
          },
        },
        fetch: mockFetch({ name: 'Alice', age: 30 }),
      });

      const response = await f('/user', { method: 'GET' });
      const result = await response.result();
      expect(result.ok).toBe(true);
      if (result.ok)
        expect(result.data).toEqual({ name: 'Alice', age: 30 });
    });

    it('returns kind:validation location:response when response schema fails', async () => {
      const strictSchema = schema((data: unknown) => {
        const obj = data as Record<string, unknown>;
        if (typeof obj.name !== 'string')
          throw new Error('name must be string');
        return obj;
      });

      const f = createFetch({
        baseUrl: 'https://api.example.com',
        routes: {
          '/user': {
            GET: { response: strictSchema },
          },
        },
        fetch: mockFetch({ name: 42 }),
      });

      const response = await f('/user', { method: 'GET' });
      const result = await response.result();
      expect(result.ok).toBe(false);
      if (!result.ok && result.error.kind === 'validation') {
        expect(result.error.location).toBe('response');
        expect(result.error.issues.length).toBeGreaterThan(0);
        expect(result.error.issues[0]!.message).toContain('name must be string');
      }
      else {
        throw new Error('expected kind:validation location:response');
      }
    });

    it('validates with ad-hoc per-call schema', async () => {
      const mySchema = schema((data: unknown) => {
        return data as { count: number };
      });

      const f = createFetch({
        baseUrl: 'https://api.example.com',
        fetch: mockFetch({ count: 42 }),
      });

      const response = await f('/stats', {
        method: 'GET',
        responseSchema: mySchema,
      });

      const result = await response.result();
      expect(result.ok).toBe(true);
      if (result.ok)
        expect(result.data).toEqual({ count: 42 });
    });

    it('surfaces body validation failure as kind:validation location:body', async () => {
      let fetchCalled = false;
      const bodySchema = schema((data: unknown) => {
        const obj = data as Record<string, unknown>;
        if (!obj.email)
          throw new Error('email required');
        return obj as { email: string };
      });

      const f = createFetch({
        baseUrl: 'https://api.example.com',
        routes: {
          '/login': {
            POST: { body: bodySchema },
          },
        },

        fetch: async () => {
          fetchCalled = true;
          return new Response(JSON.stringify({ token: 'abc' }), {
            headers: { 'content-type': 'application/json' },
          });
        },
      });

      // Valid body passes
      const ok = await f('/login', {
        method: 'POST',
        body: { email: 'test@example.com' },
      });
      const okResult = await ok.result();
      expect(okResult.ok).toBe(true);
      expect(fetchCalled).toBe(true);

      // Invalid body — call resolves to a synthetic response, fetch is NOT
      // called, error surfaces via .result() as kind:validation location:body.
      fetchCalled = false;
      const bad = await f('/login', {
        method: 'POST',
        // @ts-expect-error — intentionally missing required `email`
        body: {},
      });
      expect(fetchCalled).toBe(false);

      const badResult = await bad.result();
      expect(badResult.ok).toBe(false);
      if (!badResult.ok && badResult.error.kind === 'validation') {
        expect(badResult.error.location).toBe('body');
        expect(badResult.error.issues[0]!.message).toContain('email required');
      }
      else {
        throw new Error('expected kind:validation location:body');
      }
    });

    it('surfaces params validation failure as kind:validation location:params (§4.A2)', async () => {
      let fetchCalled = false;
      const paramsSchema = schema((data: unknown) => {
        const obj = data as Record<string, unknown>;
        if (typeof obj.id !== 'string' || obj.id.length === 0)
          throw new Error('id must be a non-empty string');
        return obj as { id: string };
      });

      const f = createFetch({
        baseUrl: 'https://api.example.com',
        routes: {
          '/users/{id}': {
            GET: { params: paramsSchema },
          },
        },

        fetch: async () => {
          fetchCalled = true;
          return new Response(JSON.stringify({}), {
            headers: { 'content-type': 'application/json' },
          });
        },
      });

      // Valid params pass
      const ok = await f('/users/{id}', {
        method: 'GET',
        params: { id: '42' },
      });
      expect((await ok.result()).ok).toBe(true);
      expect(fetchCalled).toBe(true);

      // Invalid params (empty id) — fetch never called
      fetchCalled = false;
      const bad = await f('/users/{id}', {
        method: 'GET',
        params: { id: '' },
      });
      expect(fetchCalled).toBe(false);

      const badResult = await bad.result();
      expect(badResult.ok).toBe(false);
      if (!badResult.ok && badResult.error.kind === 'validation') {
        expect(badResult.error.location).toBe('params');
        expect(badResult.error.issues[0]!.message).toContain('id must be a non-empty string');
      }
      else {
        throw new Error('expected kind:validation location:params');
      }
    });

    it('surfaces query validation failure as kind:validation location:query (§4.A2)', async () => {
      let fetchCalled = false;
      const querySchema = schema((data: unknown) => {
        const obj = data as Record<string, unknown>;
        if (obj.page !== undefined && (typeof obj.page !== 'number' || obj.page < 1))
          throw new Error('page must be a positive number');
        return obj as { page?: number };
      });

      const f = createFetch({
        baseUrl: 'https://api.example.com',
        routes: {
          '/users': {
            GET: { query: querySchema },
          },
        },

        fetch: async () => {
          fetchCalled = true;
          return new Response(JSON.stringify([]), {
            headers: { 'content-type': 'application/json' },
          });
        },
      });

      // Valid query passes
      const ok = await f('/users', { method: 'GET', query: { page: 1 } });
      expect((await ok.result()).ok).toBe(true);
      expect(fetchCalled).toBe(true);

      // Invalid query — fetch never called
      fetchCalled = false;
      const bad = await f('/users', { method: 'GET', query: { page: 0 } });
      expect(fetchCalled).toBe(false);

      const badResult = await bad.result();
      expect(badResult.ok).toBe(false);
      if (!badResult.ok && badResult.error.kind === 'validation') {
        expect(badResult.error.location).toBe('query');
        expect(badResult.error.issues[0]!.message).toContain('page must be a positive number');
      }
      else {
        throw new Error('expected kind:validation location:query');
      }
    });
  });

  describe('custom fetch', () => {
    it('uses per-call fetch override', async () => {
      const defaultMock = mockFetch({ from: 'default' });
      const overrideMock = mockFetch({ from: 'override' });

      const f = createFetch({
        baseUrl: 'https://api.example.com',
        fetch: defaultMock,
      });

      // Uses default
      const r1 = await f('/test', { method: 'GET' });
      const result1 = await r1.result();
      expect(result1.ok).toBe(true);
      if (result1.ok)
        expect(result1.data).toEqual({ from: 'default' });

      // Uses override (SvelteKit-style)
      const r2 = await f('/test', { method: 'GET', fetch: overrideMock });
      const result2 = await r2.result();
      expect(result2.ok).toBe(true);
      if (result2.ok)
        expect(result2.data).toEqual({ from: 'override' });
    });
  });

  describe('default headers', () => {
    it('applies default headers', async () => {
      let capturedHeaders: Headers | null = null;
      const f = createFetch({
        baseUrl: 'https://api.example.com',
        defaultHeaders: { 'X-Api-Key': 'secret123' },
        fetch: async (req) => {
          capturedHeaders = (req as Request).headers;
          return new Response(JSON.stringify({}), {
            headers: { 'content-type': 'application/json' },
          });
        },
      });

      await f('/test', { method: 'GET' });
      expect(capturedHeaders!.get('x-api-key')).toBe('secret123');
    });

    it('per-call headers override defaults', async () => {
      let capturedHeaders: Headers | null = null;
      const f = createFetch({
        baseUrl: 'https://api.example.com',
        defaultHeaders: { 'X-Api-Key': 'default' },
        fetch: async (req) => {
          capturedHeaders = (req as Request).headers;
          return new Response(JSON.stringify({}), {
            headers: { 'content-type': 'application/json' },
          });
        },
      });

      await f('/test', {
        method: 'GET',
        headers: { 'X-Api-Key': 'override' },
      });
      expect(capturedHeaders!.get('x-api-key')).toBe('override');
    });
  });

  describe('middleware', () => {
    it('executes middleware in order', async () => {
      const order: string[] = [];

      const f = createFetch({
        baseUrl: 'https://api.example.com',
        middleware: [
          async (_req, next) => {
            order.push('m1-before');
            const res = await next();
            order.push('m1-after');
            return res;
          },
          async (_req, next) => {
            order.push('m2-before');
            const res = await next();
            order.push('m2-after');
            return res;
          },
        ],
        fetch: async () => {
          order.push('fetch');
          return new Response(JSON.stringify({}), {
            headers: { 'content-type': 'application/json' },
          });
        },
      });

      await f('/test', { method: 'GET' });
      expect(order).toEqual([
        'm1-before',
        'm2-before',
        'fetch',
        'm2-after',
        'm1-after',
      ]);
    });

    it('authBearer middleware attaches token', async () => {
      let capturedHeaders: Headers | null = null;

      const f = createFetch({
        baseUrl: 'https://api.example.com',
        middleware: [authBearer(() => 'my-token')],
        fetch: async (req) => {
          capturedHeaders = (req as Request).headers;
          return new Response(JSON.stringify({}), {
            headers: { 'content-type': 'application/json' },
          });
        },
      });

      await f('/test', { method: 'GET' });
      expect(capturedHeaders!.get('authorization')).toBe('Bearer my-token');
    });

    it('authBearer skips when token is null', async () => {
      let capturedHeaders: Headers | null = null;

      const f = createFetch({
        baseUrl: 'https://api.example.com',
        middleware: [authBearer(() => null)],
        fetch: async (req) => {
          capturedHeaders = (req as Request).headers;
          return new Response(JSON.stringify({}), {
            headers: { 'content-type': 'application/json' },
          });
        },
      });

      await f('/test', { method: 'GET' });
      expect(capturedHeaders!.get('authorization')).toBeNull();
    });
  });

  // §4.C1 — the Idea 1 invariant says the returned object is a real
  // Response, so users must be able to mix .result() with native body
  // methods on the same response in any order. wrapResponse clones
  // immediately so the original body is preserved for native access.
  describe('mixed body consumption (§4.C1)', () => {
    it('.result() then .json() — both succeed', async () => {
      const f = createFetch({
        baseUrl: 'https://api.example.com',
        fetch: mockFetch({ key: 'value' }),
      });

      const response = await f('/test', { method: 'GET' });
      const result = await response.result();
      expect(result.ok).toBe(true);
      if (result.ok)
        expect(result.data).toEqual({ key: 'value' });

      // Native .json() still works on the original
      expect(await response.json()).toEqual({ key: 'value' });
    });

    it('.json() then .result() — both succeed', async () => {
      const f = createFetch({
        baseUrl: 'https://api.example.com',
        fetch: mockFetch({ key: 'value' }),
      });

      const response = await f('/test', { method: 'GET' });
      expect(await response.json()).toEqual({ key: 'value' });

      // .result() reads from the clone, independent of the original
      const result = await response.result();
      expect(result.ok).toBe(true);
      if (result.ok)
        expect(result.data).toEqual({ key: 'value' });
    });

    it('.result() then .text() — both succeed', async () => {
      const f = createFetch({
        baseUrl: 'https://api.example.com',
        fetch: mockFetch({ key: 'value' }),
      });

      const response = await f('/test', { method: 'GET' });
      const result = await response.result();
      expect(result.ok).toBe(true);

      // .text() returns the raw JSON string
      expect(await response.text()).toBe('{"key":"value"}');
    });

    it('.result() then .blob() — both succeed', async () => {
      const f = createFetch({
        baseUrl: 'https://api.example.com',
        fetch: mockFetch({ key: 'value' }),
      });

      const response = await f('/test', { method: 'GET' });
      const result = await response.result();
      expect(result.ok).toBe(true);

      const blob = await response.blob();
      expect(blob.size).toBeGreaterThan(0);
      expect(await blob.text()).toBe('{"key":"value"}');
    });

    it('.result() then .arrayBuffer() — both succeed', async () => {
      const f = createFetch({
        baseUrl: 'https://api.example.com',
        fetch: mockFetch({ key: 'value' }),
      });

      const response = await f('/test', { method: 'GET' });
      const result = await response.result();
      expect(result.ok).toBe(true);

      const buf = await response.arrayBuffer();
      expect(buf.byteLength).toBeGreaterThan(0);
    });

    it('parallel .result() and .json() — both succeed', async () => {
      const f = createFetch({
        baseUrl: 'https://api.example.com',
        fetch: mockFetch({ key: 'value' }),
      });

      const response = await f('/test', { method: 'GET' });
      const [result, json] = await Promise.all([
        response.result(),
        response.json(),
      ]);

      expect(result.ok).toBe(true);
      if (result.ok)
        expect(result.data).toEqual({ key: 'value' });
      expect(json).toEqual({ key: 'value' });
    });

    it('.result() can be called twice (idempotent)', async () => {
      const f = createFetch({
        baseUrl: 'https://api.example.com',
        fetch: mockFetch({ count: 1 }),
      });

      const response = await f('/test', { method: 'GET' });
      const r1 = await response.result();
      const r2 = await response.result();

      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      if (r1.ok && r2.ok) {
        expect(r1.data).toEqual({ count: 1 });
        expect(r2.data).toEqual({ count: 1 });
      }
    });

    it('HTTP error path: .result() then .text() on the same response', async () => {
      const f = createFetch({
        baseUrl: 'https://api.example.com',
        fetch: mockFetch({ code: 'NOT_FOUND' }, 404),
      });

      const response = await f('/missing', { method: 'GET' });
      const result = await response.result();
      expect(result.ok).toBe(false);

      // The original 404 response body is still readable natively
      expect(await response.text()).toBe('{"code":"NOT_FOUND"}');
    });

    it('.text() then .result() — error path', async () => {
      const f = createFetch({
        baseUrl: 'https://api.example.com',
        fetch: mockFetch({ code: 'NOT_FOUND' }, 404),
      });

      const response = await f('/missing', { method: 'GET' });
      expect(await response.text()).toBe('{"code":"NOT_FOUND"}');

      const result = await response.result();
      expect(result.ok).toBe(false);
      if (!result.ok && result.error.kind === 'http') {
        expect(result.error.status).toBe(404);
        expect(result.error.body).toEqual({ code: 'NOT_FOUND' });
      }
    });
  });

  // §4.B4 — f.with() instance forking
  describe('f.with() instance forking', () => {
    it('inherits baseUrl/routes/defaultHeaders from the parent', async () => {
      let parentHeaders: Headers | null = null;
      let childHeaders: Headers | null = null;

      const parent = createFetch({
        baseUrl: 'https://api.example.com',
        defaultHeaders: { 'X-Api-Key': 'parent-key' },

        fetch: async (req) => {
          parentHeaders = req.headers;
          return new Response(JSON.stringify({ from: 'parent-fetch' }), {
            headers: { 'content-type': 'application/json' },
          });
        },
      });

      const child = parent.with({});

      const childFetch = async (req: Request): Promise<Response> => {
        childHeaders = req.headers;
        return new Response(JSON.stringify({ from: 'child-fetch' }), {
          headers: { 'content-type': 'application/json' },
        });
      };
      const child2 = parent.with({ fetch: childFetch });

      // Inherits baseUrl + defaultHeaders
      await child('/test', { method: 'GET' });
      expect(parentHeaders!.get('x-api-key')).toBe('parent-key');

      // Override only fetch — defaultHeaders still inherited
      await child2('/test', { method: 'GET' });
      expect(childHeaders!.get('x-api-key')).toBe('parent-key');
    });

    it('overrides middleware without affecting the parent', async () => {
      const parentLog: string[] = [];
      const childLog: string[] = [];

      const parent = createFetch({
        baseUrl: 'https://api.example.com',
        middleware: [
          async (req, next) => {
            parentLog.push('parent-mw');
            return next(req);
          },
        ],
        fetch: async () =>
          new Response(JSON.stringify({}), {
            headers: { 'content-type': 'application/json' },
          }),
      });

      const child = parent.with({
        middleware: [
          async (req, next) => {
            childLog.push('child-mw');
            return next(req);
          },
        ],
      });

      await parent('/test', { method: 'GET' });
      await child('/test', { method: 'GET' });

      // Parent's middleware ran for parent only; child's ran for child only.
      expect(parentLog).toEqual(['parent-mw']);
      expect(childLog).toEqual(['child-mw']);

      // Calling parent again confirms the parent's middleware is intact.
      await parent('/test', { method: 'GET' });
      expect(parentLog).toEqual(['parent-mw', 'parent-mw']);
      expect(childLog).toEqual(['child-mw']);
    });
  });

  // §4.B3 — method shortcuts
  describe('method shortcuts', () => {
    it('f.get(path) is equivalent to f(path, { method: "GET" })', async () => {
      const captured: string[] = [];
      const f = createFetch({
        baseUrl: 'https://api.example.com',

        fetch: async (req) => {
          captured.push(req.method);
          return new Response(JSON.stringify({ ok: true }), {
            headers: { 'content-type': 'application/json' },
          });
        },
      });

      await f.get('/users');
      await f('/users', { method: 'GET' });

      expect(captured).toEqual(['GET', 'GET']);
    });

    it('all five method shortcuts forward the right HTTP verb', async () => {
      const captured: string[] = [];
      const f = createFetch({
        baseUrl: 'https://api.example.com',

        fetch: async (req) => {
          captured.push(req.method);
          return new Response(JSON.stringify({}), {
            headers: { 'content-type': 'application/json' },
          });
        },
      });

      await f.get('/x');
      await f.post('/x', { body: { a: 1 } });
      await f.put('/x', { body: { a: 1 } });
      await f.delete('/x');
      await f.patch('/x', { body: { a: 1 } });

      expect(captured).toEqual(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']);
    });

    it('shortcuts merge per-call options with the injected method', async () => {
      let capturedHeaders: Headers | null = null;
      const f = createFetch({
        baseUrl: 'https://api.example.com',

        fetch: async (req) => {
          capturedHeaders = req.headers;
          return new Response(JSON.stringify({}), {
            headers: { 'content-type': 'application/json' },
          });
        },
      });

      await f.post('/users', {
        body: { name: 'Alice' },
        headers: { 'X-Trace': 'shortcut' },
      });

      expect(capturedHeaders!.get('x-trace')).toBe('shortcut');
      expect(capturedHeaders!.get('content-type')).toBe('application/json');
    });

    it('shortcut on a typed route runs schema validation', async () => {
      const bodySchema = schema((data: unknown) => {
        const obj = data as Record<string, unknown>;
        if (!obj.email)
          throw new Error('email required');
        return obj as { email: string };
      });

      let fetchCalled = false;
      const f = createFetch({
        baseUrl: 'https://api.example.com',
        routes: {
          '/login': {
            POST: { body: bodySchema },
          },
        },

        fetch: async () => {
          fetchCalled = true;
          return new Response(JSON.stringify({ token: 'abc' }), {
            headers: { 'content-type': 'application/json' },
          });
        },
      });

      // Invalid body via shortcut → kind:validation, fetch never called
      // @ts-expect-error — intentionally missing required `email`
      const bad = await f.post('/login', { body: {} });
      expect(fetchCalled).toBe(false);
      const badResult = await bad.result();
      expect(badResult.ok).toBe(false);
      if (!badResult.ok && badResult.error.kind === 'validation') {
        expect(badResult.error.location).toBe('body');
      }
      else {
        throw new Error('expected kind:validation location:body');
      }
    });
  });
});

describe('extractErrorMessage', () => {
  it('returns cause.message for network errors with Error cause', () => {
    const error: FetcherError = {
      kind: 'network',
      cause: new Error('connection refused'),
    };
    expect(extractErrorMessage(error)).toBe('connection refused');
  });

  it('returns String(cause) for network errors with non-Error cause', () => {
    const error: FetcherError = {
      kind: 'network',
      cause: 'something went wrong',
    };
    expect(extractErrorMessage(error)).toBe('something went wrong');
  });

  it('joins issue messages for validation errors', () => {
    const error: FetcherError = {
      kind: 'validation',
      location: 'body',
      issues: [
        { message: 'email required' },
        { message: 'name must be string' },
      ],
    };
    expect(extractErrorMessage(error)).toBe('email required, name must be string');
  });

  it('returns body.message for HTTP errors', () => {
    const error: FetcherError = {
      kind: 'http',
      status: 404,
      body: { message: 'Resource not found' },
    };
    expect(extractErrorMessage(error)).toBe('Resource not found');
  });

  it('returns body.error.message for nested HTTP error messages', () => {
    const error: FetcherError = {
      kind: 'http',
      status: 422,
      body: { error: { message: 'Validation failed' } },
    };
    expect(extractErrorMessage(error)).toBe('Validation failed');
  });

  it('falls back to HTTP {status} when body has no message', () => {
    const error: FetcherError = {
      kind: 'http',
      status: 500,
      body: { code: 'INTERNAL' },
    };
    expect(extractErrorMessage(error)).toBe('HTTP 500');
  });
});

describe('.unwrap()', () => {
  it('returns data on success', async () => {
    const f = createFetch({
      baseUrl: 'https://api.test',
      fetch: mockFetch({ id: 1, name: 'Alice' }),
    });
    const data = await f.get('/users').unwrap();
    expect(data).toEqual({ id: 1, name: 'Alice' });
  });

  it('throws FetcherRequestError on HTTP error', async () => {
    const f = createFetch({
      baseUrl: 'https://api.test',
      fetch: mockFetch({ message: 'Not found' }, 404),
    });
    try {
      await f.get('/users/999').unwrap();
      expect.unreachable('should have thrown');
    }
    catch (err) {
      expect(err).toBeInstanceOf(FetcherRequestError);
      expect(err).toBeInstanceOf(Error);
      const e = err as FetcherRequestError;
      expect(e.status).toBe(404);
      expect(e.message).toBe('Not found');
      expect(e.fetcherError.kind).toBe('http');
    }
  });

  it('throws FetcherRequestError with status 500 on network error', async () => {
    const f = createFetch({
      baseUrl: 'https://api.test',
      fetch: async () => { throw new Error('Connection refused'); },
    });
    try {
      await f.get('/users').unwrap();
      expect.unreachable('should have thrown');
    }
    catch (err) {
      expect(err).toBeInstanceOf(FetcherRequestError);
      const e = err as FetcherRequestError;
      expect(e.status).toBe(500);
      expect(e.message).toBe('Connection refused');
      expect(e.fetcherError.kind).toBe('network');
    }
  });

  it('throws FetcherRequestError on validation error', async () => {
    const f = createFetch({
      baseUrl: 'https://api.test',
      fetch: mockFetch({ id: 'not-a-number' }),
      routes: {
        '/users': {
          GET: {
            response: schema((data) => {
              const obj = data as Record<string, unknown>;
              if (typeof obj.id !== 'number')
                throw new Error('id must be a number');
              return obj;
            }),
          },
        },
      },
    });
    try {
      await f.get('/users').unwrap();
      expect.unreachable('should have thrown');
    }
    catch (err) {
      expect(err).toBeInstanceOf(FetcherRequestError);
      const e = err as FetcherRequestError;
      expect(e.status).toBe(500);
      expect(e.fetcherError.kind).toBe('validation');
    }
  });

  it('preserves the full FetcherError in .fetcherError', async () => {
    const f = createFetch({
      baseUrl: 'https://api.test',
      fetch: mockFetch({ error: { message: 'Forbidden' } }, 403),
    });
    try {
      await f.get('/admin').unwrap();
      expect.unreachable('should have thrown');
    }
    catch (err) {
      const e = err as FetcherRequestError;
      expect(e.fetcherError).toEqual({
        kind: 'http',
        status: 403,
        body: { error: { message: 'Forbidden' } },
      });
    }
  });
});

describe('.query()', () => {
  it('returns { key, fn } object', () => {
    const f = createFetch({
      baseUrl: 'https://api.test',
      fetch: mockFetch([]),
    });
    const descriptor = f.get('/users').query();
    expect(descriptor).toHaveProperty('key');
    expect(descriptor).toHaveProperty('fn');
    expect(Array.isArray(descriptor.key)).toBe(true);
    expect(typeof descriptor.fn).toBe('function');
  });

  it('key includes method and path', () => {
    const f = createFetch({
      baseUrl: 'https://api.test',
      fetch: mockFetch([]),
    });
    const { key } = f.get('/users').query();
    expect(key).toEqual(['GET', '/users']);
  });

  it('key includes params when present', () => {
    const f = createFetch({
      baseUrl: 'https://api.test',
      fetch: mockFetch({}),
    });
    const { key } = f.get('/users/{id}', { params: { id: '42' } }).query();
    expect(key).toEqual(['GET', '/users/{id}', { id: '42' }]);
  });

  it('key includes query when present', () => {
    const f = createFetch({
      baseUrl: 'https://api.test',
      fetch: mockFetch([]),
    });
    const { key } = f.get('/users', { query: { page: 1, limit: 25 } }).query();
    expect(key).toEqual(['GET', '/users', { page: 1, limit: 25 }]);
  });

  it('key excludes undefined and null query values', () => {
    const f = createFetch({
      baseUrl: 'https://api.test',
      fetch: mockFetch([]),
    });
    const { key } = f.get('/users', {
      query: { page: 1, filter: undefined, sort: undefined },
    }).query();
    expect(key).toEqual(['GET', '/users', { page: 1 }]);
  });

  it('fn() returns data on success', async () => {
    const f = createFetch({
      baseUrl: 'https://api.test',
      fetch: mockFetch([{ id: 1 }]),
    });
    const { fn } = f.get('/users').query();
    const data = await fn();
    expect(data).toEqual([{ id: 1 }]);
  });

  it('fn() throws FetcherRequestError on failure', async () => {
    const f = createFetch({
      baseUrl: 'https://api.test',
      fetch: mockFetch({ message: 'Unauthorized' }, 401),
    });
    const { fn } = f.get('/users').query();
    try {
      await fn();
      expect.unreachable('should have thrown');
    }
    catch (err) {
      expect(err).toBeInstanceOf(FetcherRequestError);
      expect((err as FetcherRequestError).status).toBe(401);
    }
  });

  it('key includes method from shortcut', () => {
    const f = createFetch({
      baseUrl: 'https://api.test',
      fetch: mockFetch({}),
    });
    const { key } = f.post('/users', { body: {} }).query();
    expect(key[0]).toBe('POST');
    expect(key[1]).toBe('/users');
  });
});
