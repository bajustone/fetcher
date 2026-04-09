/**
 * Tests for the §4.B5 `bearerWithRefresh` middleware.
 *
 * Covers: happy path 401-refresh-retry; refresh-endpoint exclusion;
 * concurrent 401 dedup; refresh failure surfacing; body cloning across
 * the retry; and the matcher variants (string / RegExp / function).
 */

import { describe, expect, it } from 'bun:test';
import { createFetch } from '../src/fetcher.ts';
import { bearerWithRefresh } from '../src/middleware.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('bearerWithRefresh', () => {
  it('attaches the current token on the first attempt', async () => {
    const captured: { auth: string | null } = { auth: null };
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      middleware: [
        bearerWithRefresh({
          getToken: () => 'token-1',

          refresh: async () => 'should-not-refresh',
          refreshEndpoint: '/auth/refresh',
        }),
      ],

      fetch: async (req) => {
        captured.auth = req.headers.get('authorization');
        return jsonResponse({ ok: true });
      },
    });

    const response = await f('/users', { method: 'GET' });
    const result = await response.result();
    expect(result.ok).toBe(true);
    expect(captured.auth).toBe('Bearer token-1');
  });

  it('refreshes and retries on 401', async () => {
    let calls = 0;
    let currentToken = 'old-token';
    const tokensSeen: string[] = [];

    const f = createFetch({
      baseUrl: 'https://api.example.com',
      middleware: [
        bearerWithRefresh({
          getToken: () => currentToken,

          refresh: async () => {
            currentToken = 'new-token';
            return 'new-token';
          },
          refreshEndpoint: '/auth/refresh',
        }),
      ],

      fetch: async (req) => {
        calls++;
        tokensSeen.push(req.headers.get('authorization') ?? '');
        if (calls === 1)
          return new Response('expired', { status: 401 });
        return jsonResponse({ ok: true });
      },
    });

    const response = await f('/users', { method: 'GET' });
    const result = await response.result();
    expect(calls).toBe(2);
    expect(tokensSeen).toEqual(['Bearer old-token', 'Bearer new-token']);
    expect(result.ok).toBe(true);
  });

  it('does not loop on the refresh endpoint itself (string matcher)', async () => {
    let refreshCalled = false;
    let calls = 0;
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      middleware: [
        bearerWithRefresh({
          getToken: () => 'whatever',

          refresh: async () => {
            refreshCalled = true;
            return 'refreshed';
          },
          refreshEndpoint: '/auth/refresh',
        }),
      ],

      fetch: async () => {
        calls++;
        // The refresh endpoint itself returns 401 — this MUST NOT
        // trigger the refresh loop, otherwise we deadlock.
        return new Response('cannot refresh', { status: 401 });
      },
    });

    const response = await f('/auth/refresh', { method: 'POST' });
    expect(calls).toBe(1); // single attempt, no loop
    expect(refreshCalled).toBe(false); // refresh() never invoked
    const result = await response.result();
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'http')
      expect(result.error.status).toBe(401);
  });

  it('refresh-endpoint matcher: RegExp', async () => {
    let calls = 0;
    let refreshCalled = false;
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      middleware: [
        bearerWithRefresh({
          getToken: () => 'token',

          refresh: async () => {
            refreshCalled = true;
            return 'new';
          },
          refreshEndpoint: /\/oauth\/token$/,
        }),
      ],

      fetch: async () => {
        calls++;
        return new Response('expired', { status: 401 });
      },
    });

    await f('/oauth/token', { method: 'POST' });
    expect(calls).toBe(1);
    expect(refreshCalled).toBe(false);
  });

  it('refresh-endpoint matcher: string[] (login + refresh + logout)', async () => {
    let calls = 0;
    let refreshCalled = false;
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      middleware: [
        bearerWithRefresh({
          getToken: () => 'token',
          refresh: async () => {
            refreshCalled = true;
            return 'new';
          },
          refreshEndpoint: ['/auth/login', '/auth/refresh', '/auth/logout'],
        }),
      ],
      fetch: async () => {
        calls++;
        return new Response('expired', { status: 401 });
      },
    });

    // All three endpoints should bypass the refresh loop
    await f('/auth/login', { method: 'POST' });
    await f('/auth/refresh', { method: 'POST' });
    await f('/auth/logout', { method: 'POST' });
    expect(calls).toBe(3); // one call each, no retry loop
    expect(refreshCalled).toBe(false);
  });

  it('refresh-endpoint matcher: function', async () => {
    let calls = 0;
    let refreshCalled = false;
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      middleware: [
        bearerWithRefresh({
          getToken: () => 'token',

          refresh: async () => {
            refreshCalled = true;
            return 'new';
          },
          refreshEndpoint: req => req.method === 'POST' && req.url.includes('refresh'),
        }),
      ],

      fetch: async () => {
        calls++;
        return new Response('expired', { status: 401 });
      },
    });

    await f('/api/v2/refresh-token', { method: 'POST' });
    expect(calls).toBe(1);
    expect(refreshCalled).toBe(false);
  });

  it('dedupes concurrent 401s into a single refresh call', async () => {
    let refreshCalls = 0;
    let currentToken = 'old';

    // Refresh takes a deliberate delay so concurrent requests overlap
    const refreshDelay = 30;
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      middleware: [
        bearerWithRefresh({
          getToken: () => currentToken,
          refresh: () =>
            new Promise(resolve => setTimeout(() => {
              refreshCalls++;
              currentToken = 'new';
              resolve('new');
            }, refreshDelay)),
          refreshEndpoint: '/auth/refresh',
        }),
      ],

      fetch: async (req) => {
        const auth = req.headers.get('authorization');
        if (auth === 'Bearer old')
          return new Response('expired', { status: 401 });
        return jsonResponse({ ok: true });
      },
    });

    // Fire three concurrent calls; all hit 401 with the old token, all
    // should funnel through one refresh.
    const results = await Promise.all([
      f('/a', { method: 'GET' }),
      f('/b', { method: 'GET' }),
      f('/c', { method: 'GET' }),
    ]);

    for (const res of results) {
      const r = await res.result();
      expect(r.ok).toBe(true);
    }
    expect(refreshCalls).toBe(1);
  });

  it('clones the request body across the refresh-retry', async () => {
    let calls = 0;
    const bodies: string[] = [];
    let currentToken = 'old';

    const f = createFetch({
      baseUrl: 'https://api.example.com',
      middleware: [
        bearerWithRefresh({
          getToken: () => currentToken,

          refresh: async () => {
            currentToken = 'new';
            return 'new';
          },
          refreshEndpoint: '/auth/refresh',
        }),
      ],
      fetch: async (req) => {
        calls++;
        bodies.push(await req.text());
        if (calls === 1)
          return new Response('expired', { status: 401 });
        return jsonResponse({ ok: true });
      },
    });

    await f('/users', { method: 'POST', body: { name: 'Alice' } });
    expect(bodies).toEqual([
      '{"name":"Alice"}',
      '{"name":"Alice"}',
    ]);
  });

  it('surfaces refresh() rejection as kind:network via .result()', async () => {
    const refreshErr = new Error('refresh service down');
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      middleware: [
        bearerWithRefresh({
          getToken: () => 'old',

          refresh: async () => {
            throw refreshErr;
          },
          refreshEndpoint: '/auth/refresh',
        }),
      ],

      fetch: async () => new Response('expired', { status: 401 }),
    });

    const response = await f('/users', { method: 'GET' });
    const result = await response.result();
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'network')
      expect(result.error.cause).toBe(refreshErr);
    else
      throw new Error('expected kind:network with refresh cause');
  });

  it('returns the second 401 directly without looping again', async () => {
    let calls = 0;
    let refreshCalls = 0;
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      middleware: [
        bearerWithRefresh({
          getToken: () => 'old',

          refresh: async () => {
            refreshCalls++;
            return 'new';
          },
          refreshEndpoint: '/auth/refresh',
        }),
      ],

      fetch: async () => {
        calls++;
        // Server keeps rejecting even with the new token.
        return new Response('still expired', { status: 401 });
      },
    });

    const response = await f('/users', { method: 'GET' });
    expect(calls).toBe(2); // initial + one retry
    expect(refreshCalls).toBe(1); // refresh called exactly once
    const result = await response.result();
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'http')
      expect(result.error.status).toBe(401);
  });
});
