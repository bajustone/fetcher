/**
 * Tests for the §4.A6 `retry` middleware.
 *
 * Uses deterministic mock fetches; no real timers or network calls.
 * Backoff is set to 0 in every test so the suite stays fast — the
 * exponential-backoff math is exercised separately at unit level via the
 * default-options test.
 */

import { describe, expect, it } from 'bun:test';
import { createFetch } from '../src/fetcher.ts';
import { retry } from '../src/middleware.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('retry middleware', () => {
  it('returns the first non-retryable response immediately', async () => {
    let calls = 0;
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      retry: { attempts: 5, backoff: 0 },

      fetch: async () => {
        calls++;
        return jsonResponse({ ok: true });
      },
    });

    const response = await f('/test', { method: 'GET' });
    const result = await response.result();
    expect(result.ok).toBe(true);
    expect(calls).toBe(1);
  });

  it('retries on a retryable status and returns a later success', async () => {
    let calls = 0;
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      retry: { attempts: 5, backoff: 0 },

      fetch: async () => {
        calls++;
        if (calls < 3)
          return new Response('try again', { status: 503 });
        return jsonResponse({ ok: true });
      },
    });

    const response = await f('/test', { method: 'GET' });
    const result = await response.result();
    expect(calls).toBe(3);
    expect(result.ok).toBe(true);
  });

  it('gives up after max attempts and returns the final response', async () => {
    let calls = 0;
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      retry: { attempts: 3, backoff: 0 },

      fetch: async () => {
        calls++;
        return new Response('still failing', { status: 503 });
      },
    });

    const response = await f('/test', { method: 'GET' });
    const result = await response.result();
    expect(calls).toBe(3);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'http') {
      expect(result.error.status).toBe(503);
    }
    else {
      throw new Error('expected kind:http after exhausted retries');
    }
  });

  it('does not retry on a non-retryable HTTP status', async () => {
    let calls = 0;
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      retry: { attempts: 5, backoff: 0 },

      fetch: async () => {
        calls++;
        return new Response('Bad Request', { status: 400 });
      },
    });

    const response = await f('/test', { method: 'GET' });
    const result = await response.result();
    expect(calls).toBe(1);
    expect(result.ok).toBe(false);
  });

  it('retries on a network rejection', async () => {
    let calls = 0;
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      retry: { attempts: 4, backoff: 0 },

      fetch: async () => {
        calls++;
        if (calls < 3)
          throw new Error('connection refused');
        return jsonResponse({ ok: true });
      },
    });

    const response = await f('/test', { method: 'GET' });
    const result = await response.result();
    expect(calls).toBe(3);
    expect(result.ok).toBe(true);
  });

  it('honors a numeric Retry-After header', async () => {
    let calls = 0;
    const timestamps: number[] = [];
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      retry: { attempts: 3, backoff: 0 },

      fetch: async () => {
        timestamps.push(Date.now());
        calls++;
        if (calls === 1) {
          return new Response('throttled', {
            status: 429,
            headers: { 'retry-after': '0.05' }, // 50 ms
          });
        }
        return jsonResponse({ ok: true });
      },
    });

    const response = await f('/test', { method: 'GET' });
    const result = await response.result();
    expect(result.ok).toBe(true);
    // The 50 ms Retry-After should have introduced a noticeable delay
    // between attempts 1 and 2 (much longer than the 0 ms backoff).
    expect(timestamps[1]! - timestamps[0]!).toBeGreaterThanOrEqual(40);
  });

  it('clones the request body between attempts (regression for stream bodies)', async () => {
    const bodies: string[] = [];
    let calls = 0;
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      retry: { attempts: 3, backoff: 0 },
      fetch: async (req) => {
        bodies.push(await req.text());
        calls++;
        if (calls < 3)
          return new Response('try again', { status: 503 });
        return jsonResponse({ ok: true });
      },
    });

    await f('/test', { method: 'POST', body: { hello: 'world' } });
    expect(bodies).toHaveLength(3);
    expect(bodies[0]).toBe('{"hello":"world"}');
    expect(bodies[1]).toBe('{"hello":"world"}');
    expect(bodies[2]).toBe('{"hello":"world"}');
  });

  it('aborts mid-retry when the user signal aborts', async () => {
    let calls = 0;
    const controller = new AbortController();
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      retry: { attempts: 5, backoff: 1_000 },

      fetch: async () => {
        calls++;
        // First attempt fails, kicks off backoff. The user aborts during
        // backoff, which should reject the sleep and surface as kind:network.
        if (calls === 1) {
          // Abort after a tick so we land in the sleep.
          setTimeout(() => controller.abort(new Error('user cancelled')), 10);
          return new Response('try again', { status: 503 });
        }
        return jsonResponse({ ok: true });
      },
    });

    const response = await f('/test', { method: 'GET', signal: controller.signal });
    const result = await response.result();
    // The retry loop bailed during backoff — we never got to attempt 2.
    expect(calls).toBe(1);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.kind).toBe('network');
  });

  it('per-call retry overrides FetchConfig.retry', async () => {
    let calls = 0;
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      retry: { attempts: 5, backoff: 0 },

      fetch: async () => {
        calls++;
        return new Response('still failing', { status: 503 });
      },
    });

    // Override to 1 attempt for this call only
    const response = await f('/test', { method: 'GET', retry: 1 });
    expect(calls).toBe(1);
    const result = await response.result();
    expect(result.ok).toBe(false);
  });

  it('explicit retry middleware in middleware: [...] also works', async () => {
    let calls = 0;
    const f = createFetch({
      baseUrl: 'https://api.example.com',

      fetch: async () => {
        calls++;
        if (calls < 2)
          return new Response('fail', { status: 502 });
        return jsonResponse({ ok: true });
      },
    });

    const response = await f('/test', {
      method: 'GET',
      middleware: [retry({ attempts: 3, backoff: 0 })],
    });
    const result = await response.result();
    expect(calls).toBe(2);
    expect(result.ok).toBe(true);
  });
});
