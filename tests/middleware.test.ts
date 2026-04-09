/**
 * Tests for the §4.A5 middleware refactor: recursive dispatcher with
 * explicit `next(request)`, per-call `middleware` override, and error
 * propagation through `.result()`.
 */

import type { Middleware } from '../src/types.ts';
import { describe, expect, it } from 'bun:test';
import { createFetch } from '../src/fetcher.ts';
import { executeMiddleware } from '../src/middleware.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('executeMiddleware (recursive dispatcher)', () => {
  it('runs middlewares in order around finalFetch', async () => {
    const order: string[] = [];
    const mws: Middleware[] = [
      async (req, next) => {
        order.push('m1-before');
        const res = await next(req);
        order.push('m1-after');
        return res;
      },
      async (req, next) => {
        order.push('m2-before');
        const res = await next(req);
        order.push('m2-after');
        return res;
      },
    ];

    const finalFetch = async (_req: Request) => {
      order.push('fetch');
      return jsonResponse({});
    };

    await executeMiddleware(mws, new Request('https://x'), finalFetch);
    expect(order).toEqual(['m1-before', 'm2-before', 'fetch', 'm2-after', 'm1-after']);
  });

  it('replays downstream middleware when next() is called twice', async () => {
    const downstreamCalls: number[] = [];
    let attempt = 0;

    const retry: Middleware = async (req, next) => {
      let res = await next(req);
      if (!res.ok) {
        attempt++;
        res = await next(req); // second call must re-run downstream
      }
      return res;
    };

    const downstream: Middleware = async (req, next) => {
      downstreamCalls.push(downstreamCalls.length);
      return next(req);
    };

    let fetchCalls = 0;

    const finalFetch = async () => {
      fetchCalls++;
      return fetchCalls === 1
        ? new Response('fail', { status: 500 })
        : jsonResponse({ ok: true });
    };

    const res = await executeMiddleware(
      [retry, downstream],
      new Request('https://x'),
      finalFetch,
    );

    expect(attempt).toBe(1);
    expect(fetchCalls).toBe(2);
    // Critical regression: downstream middleware ran on BOTH attempts
    expect(downstreamCalls).toHaveLength(2);
    expect(res.ok).toBe(true);
  });

  it('passes a modified request when next(modifiedRequest) is called', async () => {
    const seen: string[] = [];

    const swap: Middleware = async (req, next) => {
      const swapped = new Request(req.url, {
        method: req.method,
        headers: { 'X-Swapped': 'yes' },
      });
      return next(swapped);
    };

    const inspect: Middleware = async (req, next) => {
      seen.push(req.headers.get('X-Swapped') ?? 'no');
      return next(req);
    };

    const finalFetch = async (req: Request) => {
      seen.push(`final:${req.headers.get('X-Swapped') ?? 'no'}`);
      return jsonResponse({});
    };

    await executeMiddleware(
      [swap, inspect],
      new Request('https://x', { headers: { 'X-Swapped': 'no' } }),
      finalFetch,
    );

    expect(seen).toEqual(['yes', 'final:yes']);
  });

  it('forwards the original request when next() is called with no argument', async () => {
    let downstreamReq: Request | null = null;

    const passthrough: Middleware = async (_req, next) => next(); // no arg

    const inspect: Middleware = async (req, next) => {
      downstreamReq = req;
      return next(req);
    };

    const finalFetch = async () => jsonResponse({});

    const original = new Request('https://x', { headers: { 'X-Trace': 'abc' } });
    await executeMiddleware([passthrough, inspect], original, finalFetch);

    expect(downstreamReq).not.toBeNull();
    expect(downstreamReq!.headers.get('X-Trace')).toBe('abc');
  });

  it('lets a middleware short-circuit by not calling next', async () => {
    let fetchCalled = false;

    const shortCircuit: Middleware = async () => jsonResponse({ short: true });

    const downstream: Middleware = async (req, next) => {
      fetchCalled = true;
      return next(req);
    };

    const res = await executeMiddleware(
      [shortCircuit, downstream],
      new Request('https://x'),

      async () => jsonResponse({ from: 'fetch' }),
    );

    expect(fetchCalled).toBe(false);
    expect(await res.json()).toEqual({ short: true });
  });
});

describe('per-call middleware override', () => {
  it('middleware: false skips the configured chain entirely', async () => {
    const log: string[] = [];
    const config: Middleware = async (req, next) => {
      log.push('config');
      return next(req);
    };

    const f = createFetch({
      baseUrl: 'https://api.example.com',
      middleware: [config],
      fetch: async () => jsonResponse({ ok: true }),
    });

    // Default: config middleware runs
    await f('/test', { method: 'GET' });
    expect(log).toEqual(['config']);

    // With middleware: false, config middleware is skipped
    log.length = 0;
    await f('/test', { method: 'GET', middleware: false });
    expect(log).toEqual([]);
  });

  it('middleware: [...] replaces the configured chain for that call', async () => {
    const log: string[] = [];
    const config: Middleware = async (req, next) => {
      log.push('config');
      return next(req);
    };
    const override: Middleware = async (req, next) => {
      log.push('override');
      return next(req);
    };

    const f = createFetch({
      baseUrl: 'https://api.example.com',
      middleware: [config],
      fetch: async () => jsonResponse({ ok: true }),
    });

    await f('/test', { method: 'GET', middleware: [override] });
    expect(log).toEqual(['override']);
  });
});

describe('middleware error propagation', () => {
  it('surfaces a middleware async reject as kind:network via .result()', async () => {
    const cause = new Error('middleware-rejected');
    const failing: Middleware = async () => {
      throw cause;
    };

    const f = createFetch({
      baseUrl: 'https://api.example.com',
      middleware: [failing],
      fetch: async () => jsonResponse({ ok: true }),
    });

    // The call itself never throws.
    const response = await f('/test', { method: 'GET' });
    const result = await response.result();
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'network') {
      expect(result.error.cause).toBe(cause);
    }
    else {
      throw new Error('expected kind:network error');
    }
  });

  it('surfaces a middleware sync throw as kind:network via .result()', async () => {
    const cause = new Error('middleware-threw-sync');
    const failing: Middleware = (() => {
      throw cause;
    }) as unknown as Middleware;

    const f = createFetch({
      baseUrl: 'https://api.example.com',
      middleware: [failing],
      fetch: async () => jsonResponse({ ok: true }),
    });

    const response = await f('/test', { method: 'GET' });
    const result = await response.result();
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'network') {
      expect(result.error.cause).toBe(cause);
    }
    else {
      throw new Error('expected kind:network error');
    }
  });
});
