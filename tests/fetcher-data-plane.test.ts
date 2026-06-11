/**
 * Regression tests for the v1.0 data-plane hardening, derived from the
 * empirical findings of the pre-1.0 audit. Each describe block maps to a
 * confirmed finding: URL construction, query serialization, body
 * serialization, response classification, and the never-throws contract.
 */

import type { FetchFn, Schema } from '../src/types.ts';
import { describe, expect, it } from 'bun:test';
import { createFetch } from '../src/fetcher.ts';

/** Captures the outgoing Request and returns a canned JSON response. */
function captureFetch(
  capture: { request?: Request; bodyText?: string },
  body: unknown = {},
  status = 200,
  headers: Record<string, string> = { 'content-type': 'application/json' },
): FetchFn {
  return async (req) => {
    capture.request = req;
    if (req.body !== null)
      capture.bodyText = await req.clone().text();
    return new Response(JSON.stringify(body), { status, headers });
  };
}

/** Minimal Standard Schema with transform-style output rewriting. */
function schema<T>(fn: (data: unknown) => { value: T } | { issues: Array<{ message: string; path?: PropertyKey[] }> }): Schema<T> {
  return { '~standard': { version: 1, vendor: 'fetcher-test', validate: fn } } as Schema<T>;
}

describe('URL construction', () => {
  it('joins baseUrl with trailing slash + path with leading slash without //', async () => {
    const cap: { request?: Request } = {};
    const f = createFetch({ baseUrl: 'https://api.example.com/', fetch: captureFetch(cap) });
    await f('/users', { method: 'GET' });
    expect(cap.request!.url).toBe('https://api.example.com/users');
  });

  it('joins baseUrl without slash + path without slash without corrupting the host', async () => {
    const cap: { request?: Request } = {};
    const f = createFetch({ baseUrl: 'https://api.example.com', fetch: captureFetch(cap) });
    await f('users', { method: 'GET' });
    expect(cap.request!.url).toBe('https://api.example.com/users');
  });

  it('preserves a path prefix on the baseUrl', async () => {
    const cap: { request?: Request } = {};
    const f = createFetch({ baseUrl: 'https://api.example.com/v1/', fetch: captureFetch(cap) });
    await f('/users', { method: 'GET' });
    expect(cap.request!.url).toBe('https://api.example.com/v1/users');
  });

  it('an absolute URL path wins over baseUrl instead of concatenating', async () => {
    const cap: { request?: Request } = {};
    const f = createFetch({ baseUrl: 'https://api.example.com', fetch: captureFetch(cap) });
    await f('https://other.example.org/healthz', { method: 'GET' });
    expect(cap.request!.url).toBe('https://other.example.org/healthz');
  });

  it('omitting params entirely is a validation error, not a literal {id} request', async () => {
    const f = createFetch({ baseUrl: 'https://api.example.com', fetch: captureFetch({}) });
    // @ts-expect-error — params are required at the type level for {id}
    // templates since v1; this asserts the RUNTIME guard for JS callers.
    const result = await f('/users/{id}', { method: 'GET' }).result();
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'validation') {
      expect(result.error.location).toBe('params');
      expect(result.error.issues[0]!.message).toContain('id');
    }
  });

  it('numeric path params are accepted and encoded', async () => {
    const cap: { request?: Request } = {};
    const f = createFetch({ baseUrl: 'https://api.example.com', fetch: captureFetch(cap) });
    await f('/users/{id}', { method: 'GET', params: { id: 42 } });
    expect(cap.request!.url).toBe('https://api.example.com/users/42');
  });
});

describe('query serialization', () => {
  it('arrays serialize as repeated keys (form/explode=true)', async () => {
    const cap: { request?: Request } = {};
    const f = createFetch({ baseUrl: 'https://api.example.com', fetch: captureFetch(cap) });
    await f('/items', { method: 'GET', query: { ids: [1, 2, 3] } });
    expect(new URL(cap.request!.url).search).toBe('?ids=1&ids=2&ids=3');
  });

  it('Date values serialize as ISO 8601', async () => {
    const cap: { request?: Request } = {};
    const f = createFetch({ baseUrl: 'https://api.example.com', fetch: captureFetch(cap) });
    const when = new Date('2026-01-02T03:04:05.000Z');
    await f('/items', { method: 'GET', query: { since: when } });
    expect(new URL(cap.request!.url).searchParams.get('since')).toBe('2026-01-02T03:04:05.000Z');
  });

  it('a path that already has a query string merges with & (no second ?)', async () => {
    const cap: { request?: Request } = {};
    const f = createFetch({ baseUrl: 'https://api.example.com', fetch: captureFetch(cap) });
    await f('/search?limit=5', { method: 'GET', query: { q: 'x y' } });
    expect(cap.request!.url).toBe('https://api.example.com/search?limit=5&q=x+y');
  });

  it('plain-object query values are a validation error, not [object Object]', async () => {
    const f = createFetch({ baseUrl: 'https://api.example.com', fetch: captureFetch({}) });
    const result = await f('/items', { method: 'GET', query: { filter: { a: 1 } as never } }).result();
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'validation') {
      expect(result.error.location).toBe('query');
      expect(result.error.issues[0]!.code).toBe('unserializable_value');
    }
  });

  it('querySerializer overrides the built-in serialization', async () => {
    const cap: { request?: Request } = {};
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      querySerializer: q => `custom=${Object.keys(q).join(',')}`,
      fetch: captureFetch(cap),
    });
    await f('/items', { method: 'GET', query: { a: 1, b: 2 } });
    // The serializer's string is appended verbatim (no re-encoding).
    expect(new URL(cap.request!.url).search).toBe('?custom=a,b');
  });
});

describe('body serialization', () => {
  it('Uint8Array bodies pass through untouched (no JSON.stringify, no JSON content-type)', async () => {
    const cap: { request?: Request; bodyText?: string } = {};
    const f = createFetch({ baseUrl: 'https://api.example.com', fetch: captureFetch(cap) });
    const bytes = new Uint8Array([1, 2, 3, 255]);
    await f('/upload', { method: 'POST', body: bytes });
    const sent = new Uint8Array(await cap.request!.clone().arrayBuffer());
    expect(Array.from(sent)).toEqual([1, 2, 3, 255]);
    expect(cap.request!.headers.get('content-type') ?? '').not.toContain('application/json');
  });

  it('ReadableStream bodies pass through (with duplex half)', async () => {
    const cap: { request?: Request; bodyText?: string } = {};
    const f = createFetch({ baseUrl: 'https://api.example.com', fetch: captureFetch(cap) });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('streamed!'));
        controller.close();
      },
    });
    await f('/upload', { method: 'POST', body: stream });
    expect(cap.bodyText).toBe('streamed!');
  });

  it('validated body OUTPUT goes on the wire (transforms/defaults apply)', async () => {
    const cap: { request?: Request; bodyText?: string } = {};
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      routes: {
        '/users': {
          POST: {
            // Schema fills a default and normalizes the email.
            body: schema((data) => {
              const o: Record<string, unknown> = { role: 'member', ...(data as Record<string, unknown>) };
              o.email = String(o.email).toLowerCase();
              return { value: o };
            }),
          },
        },
      },
      fetch: captureFetch(cap),
    });
    await f('/users', { method: 'POST', body: { email: 'A@B.COM' } as Record<string, unknown> });
    expect(JSON.parse(cap.bodyText!)).toEqual({ email: 'a@b.com', role: 'member' });
  });

  it('a declared body schema runs even when the body is omitted', async () => {
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      routes: {
        '/users': {
          POST: {
            body: schema((data) => {
              if (data === undefined)
                return { issues: [{ message: 'body is required' }] };
              return { value: data };
            }),
          },
        },
      },
      fetch: captureFetch({}),
    });
    // @ts-expect-error — the declared body is required at the type level
    // too; this asserts the RUNTIME validation for JS callers.
    const result = await f('/users', { method: 'POST' }).result();
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'validation')
      expect(result.error.location).toBe('body');
  });

  it('lowercase method strings hit the same route (and its validation)', async () => {
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      routes: {
        '/users': {
          POST: { body: schema(() => ({ issues: [{ message: 'always rejects' }] })) },
        },
      },
      fetch: captureFetch({}),
    });
    const result = await f('/users', { method: 'post' as 'POST', body: {} }).result();
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.kind).toBe('validation');
  });
});

describe('response classification', () => {
  const fetchWith = (body: string, status: number, contentType?: string): FetchFn =>
    async () => new Response(body, {
      status,
      headers: contentType ? { 'content-type': contentType } : {},
    });

  it('application/problem+json parses as JSON on the error side', async () => {
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      fetch: fetchWith('{"title":"Out of credit","status":403}', 403, 'application/problem+json'),
    });
    const result = await f('/pay', { method: 'GET' }).result();
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'http') {
      expect(result.error.status).toBe(403);
      expect(result.error.body).toEqual({ title: 'Out of credit', status: 403 });
    }
  });

  it('vnd.api+json parses as JSON on the success side', async () => {
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      fetch: fetchWith('{"data":[]}', 200, 'application/vnd.api+json'),
    });
    const result = await f('/items', { method: 'GET' }).result();
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.data).toEqual({ data: [] });
  });

  it('a 502 HTML page mislabeled as JSON keeps its status (body = raw text)', async () => {
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      fetch: fetchWith('<html>Bad Gateway</html>', 502, 'application/json'),
    });
    const result = await f('/items', { method: 'GET' }).result();
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'http') {
      expect(result.error.status).toBe(502);
      expect(result.error.body).toBe('<html>Bad Gateway</html>');
    }
  });

  it('an empty 404 with JSON content-type keeps its status', async () => {
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      fetch: fetchWith('', 404, 'application/json'),
    });
    const result = await f('/missing', { method: 'GET' }).result();
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'http') {
      expect(result.error.status).toBe(404);
      expect(result.error.body).toBeUndefined();
    }
  });

  it('an errorResponse schema mismatch carries the HTTP status on the validation error', async () => {
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      routes: {
        '/items': {
          GET: { errorResponse: schema(() => ({ issues: [{ message: 'shape mismatch' }] })) },
        },
      },
      fetch: fetchWith('{"weird":true}', 422, 'application/json'),
    });
    const result = await f('/items', { method: 'GET' }).result();
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'validation') {
      expect(result.error.location).toBe('response');
      expect(result.error.status).toBe(422);
    }
  });

  it('204 No Content resolves ok with undefined data (HEAD-style flows work)', async () => {
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      fetch: async () => new Response(null, { status: 204 }),
    });
    const result = await f('/items/1', { method: 'DELETE' }).result();
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.data).toBeUndefined();
  });

  it('invalid JSON on a 2xx is a response validation error with the status, not kind network', async () => {
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      fetch: fetchWith('{broken', 200, 'application/json'),
    });
    const result = await f('/items', { method: 'GET' }).result();
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'validation') {
      expect(result.error.location).toBe('response');
      expect(result.error.status).toBe(200);
      expect(result.error.issues[0]!.code).toBe('invalid_json');
    }
  });

  it('a non-JSON 2xx with a declared schema is validated, not silently bypassed', async () => {
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      routes: {
        '/items': {
          GET: {
            response: schema((data) => {
              if (typeof data !== 'object' || data === null)
                return { issues: [{ message: 'expected an object body' }] };
              return { value: data };
            }),
          },
        },
      },
      fetch: fetchWith('plain text, not the declared object', 200, 'text/plain'),
    });
    const result = await f('/items', { method: 'GET' }).result();
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'validation') {
      expect(result.error.location).toBe('response');
      expect(result.error.status).toBe(200);
    }
  });

  it('HEAD shortcut works against a bodiless response', async () => {
    const cap: { request?: Request } = {};
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      fetch: async (req) => {
        cap.request = req;
        return new Response(null, { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    const result = await f.head('/items').result();
    expect(cap.request!.method).toBe('HEAD');
    expect(result.ok).toBe(true);
  });
});

describe('never-throws contract', () => {
  it('invalid header values surface as a structured error, not a throw', async () => {
    const f = createFetch({ baseUrl: 'https://api.example.com', fetch: captureFetch({}) });
    const result = await f('/items', {
      method: 'GET',
      headers: { 'X-Bad': 'line1\r\nInjected: true' },
    }).result();
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.kind).toBe('network');
  });

  it('an unparseable URL surfaces as a structured error, not a throw', async () => {
    const f = createFetch({ baseUrl: '', fetch: captureFetch({}) });
    const result = await f('/relative-without-base', { method: 'GET' }).result();
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.kind).toBe('network');
  });
});

describe('adversarial-review regressions (core)', () => {
  it('a user-supplied AbortSignal.timeout() classifies as kind:\'timeout\', not \'aborted\'', async () => {
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      fetch: req => new Promise((_resolve, reject) => {
        req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true });
      }),
    });
    const result = await f('/slow', { method: 'GET', signal: AbortSignal.timeout(30) }).result();
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.kind).toBe('timeout');
  });

  it('a throwing querySerializer surfaces as a structured error, never a rejection', async () => {
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      querySerializer: () => {
        throw new Error('serializer exploded');
      },
      fetch: captureFetch({}),
    });
    const result = await f('/items', { method: 'GET', query: { a: 1 } }).result();
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'network')
      expect((result.error.cause as Error).message).toBe('serializer exploded');
  });

  it('body: null sends no body (0.x behavior) and default-GET calls succeed', async () => {
    const cap: { request?: Request } = {};
    const f = createFetch({ baseUrl: 'https://api.example.com', fetch: captureFetch(cap) });
    const result = await f('/items', { method: 'GET', body: null }).result();
    expect(result.ok).toBe(true);
    expect(cap.request!.body).toBeNull();
    expect(cap.request!.headers.get('content-type')).toBeNull();
  });
});
