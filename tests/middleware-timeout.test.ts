/**
 * Tests for the §4.A6 `timeout` middleware.
 *
 * Uses fetches that resolve via setTimeout so the timeout can race against
 * a deterministic delay.
 */

import { describe, expect, it } from 'bun:test';
import { createFetch } from '../src/fetcher.ts';
import { timeout } from '../src/middleware.ts';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });
}

/** Returns a fetch that resolves after `delayMs`, but aborts if the request signal fires. */
function delayedFetch(delayMs: number, body: unknown = { ok: true }): (req: Request) => Promise<Response> {
  return (req: Request) =>
    new Promise((resolve, reject) => {
      const toError = (v: unknown): Error => v instanceof Error ? v : new Error(String(v));
      const timer = setTimeout(() => resolve(jsonResponse(body)), delayMs);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(toError(req.signal.reason));
      };
      if (req.signal.aborted)
        onAbort();
      else
        req.signal.addEventListener('abort', onAbort, { once: true });
    });
}

describe('timeout middleware', () => {
  it('lets a fast response through unchanged', async () => {
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      timeout: 1_000,
      fetch: delayedFetch(10),
    });

    const response = await f('/test', { method: 'GET' });
    const result = await response.result();
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.data).toEqual({ ok: true });
  });

  it('aborts a slow request and surfaces as kind:network', async () => {
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      timeout: 30,
      fetch: delayedFetch(500),
    });

    const response = await f('/test', { method: 'GET' });
    const result = await response.result();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('network');
      // The cause is whatever AbortSignal.timeout aborted with —
      // typically a TimeoutError or AbortError.
      const cause = result.error.kind === 'network' ? result.error.cause : null;
      expect(cause).toBeDefined();
    }
  });

  it('per-call timeout overrides FetchConfig.timeout', async () => {
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      timeout: 5_000, // generous default
      fetch: delayedFetch(200),
    });

    // Tighten the timeout for this call only.
    const response = await f('/test', { method: 'GET', timeout: 30 });
    const result = await response.result();
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.kind).toBe('network');
  });

  it('user-supplied AbortSignal still aborts the request', async () => {
    const controller = new AbortController();
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      timeout: 5_000,
      fetch: delayedFetch(500),
    });

    setTimeout(() => controller.abort(new Error('user-cancelled')), 20);
    const response = await f('/test', { method: 'GET', signal: controller.signal });
    const result = await response.result();
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.kind).toBe('network');
  });

  it('explicit timeout middleware in middleware: [...] also works', async () => {
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      fetch: delayedFetch(500),
    });

    const response = await f('/test', {
      method: 'GET',
      middleware: [timeout(30)],
    });
    const result = await response.result();
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.kind).toBe('network');
  });

  it('combines with retry: each attempt gets a fresh timeout', async () => {
    let calls = 0;
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      retry: { attempts: 3, backoff: 0 },
      timeout: 50,
      fetch: (req) => {
        calls++;
        // First two attempts hang past the timeout; third resolves quickly.
        const delay = calls < 3 ? 200 : 5;
        return delayedFetch(delay)(req);
      },
    });

    const response = await f('/test', { method: 'GET' });
    const result = await response.result();
    expect(calls).toBe(3);
    expect(result.ok).toBe(true);
  });
});
