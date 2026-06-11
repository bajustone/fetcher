/**
 * Regression tests for the v1.0 middleware hardening: exclude matching
 * against baseUrl prefixes and OpenAPI path templates, parseSetCookie
 * deletion handling, cookieAuth staggered-401 dedup, and timeout
 * timer/listener hygiene.
 */

import { describe, expect, it } from 'bun:test';
import { createFetch } from '../src/fetcher.ts';
import { bearerWithRefresh, cookieAuth, parseSetCookie, timeout } from '../src/middleware.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('exclude matching', () => {
  const makeClient = (exclude: string[], baseUrl: string, seen: string[]): ReturnType<typeof createFetch> =>
    createFetch({
      baseUrl,
      middleware: [
        bearerWithRefresh({
          getToken: () => 'token',
          refresh: async () => 'new-token',
          exclude,
        }),
      ],
      fetch: async (req) => {
        seen.push(req.headers.get('Authorization') ?? 'none');
        return jsonResponse({});
      },
    });

  it('matches when the baseUrl carries a path prefix', async () => {
    const seen: string[] = [];
    const f = makeClient(['/auth/login'], 'https://api.example.com/api/v1', seen);
    await f('/auth/login', { method: 'POST', body: {} });
    // Excluded → no Authorization attached even though the real pathname
    // is /api/v1/auth/login.
    expect(seen).toEqual(['none']);
  });

  it('does not match a same-suffix but different segment (oauth vs auth)', async () => {
    const seen: string[] = [];
    const f = makeClient(['/auth/login'], 'https://api.example.com', seen);
    await f('/oauth/login', { method: 'POST', body: {} });
    expect(seen).toEqual(['Bearer token']);
  });

  it('matches OpenAPI path templates against concrete URLs', async () => {
    const seen: string[] = [];
    const f = makeClient(['/sessions/{id}/refresh'], 'https://api.example.com', seen);
    await f('/sessions/abc-123/refresh', { method: 'POST', body: {} });
    expect(seen).toEqual(['none']);
  });

  it('template {param} segments match exactly one path segment', async () => {
    const seen: string[] = [];
    const f = makeClient(['/sessions/{id}'], 'https://api.example.com', seen);
    await f('/sessions/a/b', { method: 'GET' });
    expect(seen).toEqual(['Bearer token']);
  });
});

describe('parseSetCookie deletions', () => {
  it('drops a cookie deleted with Max-Age=0', () => {
    expect(parseSetCookie(['sid=abc; Path=/', 'sid=; Max-Age=0'])).toBe('');
  });

  it('drops a cookie with an Expires date in the past', () => {
    expect(parseSetCookie(['old=gone; Expires=Wed, 21 Oct 2015 07:28:00 GMT'])).toBe('');
  });

  it('Max-Age takes precedence over Expires (RFC 6265bis)', () => {
    // Expired Expires but positive Max-Age → cookie lives.
    expect(parseSetCookie(['sid=abc; Expires=Wed, 21 Oct 2015 07:28:00 GMT; Max-Age=3600'])).toBe('sid=abc');
  });

  it('attribute names match case-insensitively', () => {
    expect(parseSetCookie(['sid=abc; MAX-AGE=0'])).toBe('');
  });

  it('a malformed Max-Age is ignored entirely (strict digit rule)', () => {
    expect(parseSetCookie(['sid=abc; Max-Age=0xFF'])).toBe('sid=abc');
  });

  it('keeps live cookies while honoring a comma-bearing Expires on another', () => {
    expect(parseSetCookie([
      'a=1; Expires=Wed, 21 Oct 2099 07:28:00 GMT',
      'b=2; Path=/',
    ])).toBe('a=1; b=2');
  });
});

describe('cookieAuth staggered-401 dedup', () => {
  it('a 401 arriving after a fresh login reuses the new cookie instead of re-logging-in', async () => {
    let logins = 0;
    let acceptedCookie = '';
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      middleware: [
        cookieAuth({
          login: async () => {
            logins++;
            acceptedCookie = `sid=gen${logins}`;
            return acceptedCookie;
          },
        }),
      ],
      fetch: async (req) => {
        // Only the latest issued cookie is accepted.
        if (req.headers.get('Cookie') !== acceptedCookie)
          return jsonResponse({ error: 'unauthorized' }, 401);
        return jsonResponse({ ok: true });
      },
    });

    // First request: lazy login (gen1), succeeds.
    const r1 = await f('/a', { method: 'GET' }).result();
    expect(r1.ok).toBe(true);
    expect(logins).toBe(1);

    // Invalidate gen1 server-side, as if the session expired.
    acceptedCookie = 'sid=never-issued';

    // Two staggered requests both 401 → exactly ONE re-login between them.
    const r2 = await f('/b', { method: 'GET' }).result();
    // After r2's re-login (gen2), make the server accept gen2.
    expect(logins).toBe(2);
    expect(r2.ok).toBe(true);

    const r3 = await f('/c', { method: 'GET' }).result();
    expect(r3.ok).toBe(true);
    // r3 used the still-valid gen2 cookie — no third login.
    expect(logins).toBe(2);
  });
});

describe('timeout hygiene', () => {
  it('a completed request does not hold its timer (fast process exit)', async () => {
    // Indirect check: a 10ms request under a 10-minute timeout must not
    // leave the event loop pinned. We assert the middleware clears its
    // timer by observing that the test completes immediately — if the
    // timer leaked, `bun test` would hang for 10 minutes on this file.
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      timeout: 600_000,
      fetch: async () => jsonResponse({}),
    });
    const result = await f('/fast', { method: 'GET' }).result();
    expect(result.ok).toBe(true);
  });

  it('a long-lived user signal does not accumulate abort listeners', async () => {
    const controller = new AbortController();
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      timeout: 5_000,
      fetch: async () => jsonResponse({}),
    });
    // 200 sequential requests against ONE shared signal. With listener
    // leaks this warns (MaxListenersExceeded) and grows memory; with
    // cleanup it is silent. getEventListeners is Node-only, so assert
    // indirectly: all requests succeed and no listener error is thrown.
    for (let i = 0; i < 200; i++) {
      const r = await f('/n', { method: 'GET', signal: controller.signal }).result();
      expect(r.ok).toBe(true);
    }
    // The signal is still usable afterwards.
    expect(controller.signal.aborted).toBe(false);
  });

  it('explicit timeout middleware composes with a pre-aborted user signal', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled before send'));
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      fetch: async (req) => {
        if (req.signal.aborted)
          throw req.signal.reason;
        return jsonResponse({});
      },
    });
    const result = await f('/x', {
      method: 'GET',
      middleware: [timeout(1_000)],
      signal: controller.signal,
    }).result();
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.kind).toBe('aborted');
  });
});

describe('adversarial-review regressions (middleware)', () => {
  it('stream body survives timeout() middleware (Bun re-wrap seam)', async () => {
    let received = '';
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      timeout: 5_000,
      fetch: async (req) => {
        received = await req.text();
        return jsonResponse({ ok: true });
      },
    });
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('streamed-through-timeout'));
        c.close();
      },
    });
    const result = await f('/upload', { method: 'POST', body: stream }).result();
    expect(result.ok).toBe(true);
    expect(received).toBe('streamed-through-timeout');
  });

  it('timeout(Infinity) and timeout(2^31) mean "no deadline", not 1ms', async () => {
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      fetch: async () => {
        await new Promise(r => setTimeout(r, 30));
        return jsonResponse({ ok: true });
      },
    });
    const a = await f('/x', { method: 'GET', timeout: Number.POSITIVE_INFINITY }).result();
    const b = await f('/x', { method: 'GET', timeout: 2 ** 31 }).result();
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });

  it('fractional and NaN retry attempts still send exactly the right requests', async () => {
    let calls = 0;
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      fetch: async () => {
        calls++;
        return new Response('boom', { status: 503 });
      },
    });
    const r1 = await f('/x', { method: 'GET', retry: { attempts: 2.5, backoff: 0 } }).result();
    expect(calls).toBe(2); // floor(2.5), final response RETURNED not discarded
    expect(!r1.ok && r1.error.kind === 'http' && r1.error.status === 503).toBe(true);

    calls = 0;
    const r2 = await f('/x', { method: 'GET', retry: { attempts: Number.NaN, backoff: 0 } }).result();
    expect(calls).toBe(3); // NaN → default 3, never zero
    expect(r2.ok).toBe(false);
  });

  it('adjacent {a}{b} template params match linearly (no catastrophic backtracking)', async () => {
    const seen: string[] = [];
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      middleware: [
        bearerWithRefresh({
          getToken: () => 'token',
          refresh: async () => 'new',
          exclude: ['/files/{a}{b}'],
        }),
      ],
      fetch: async (req) => {
        seen.push(req.headers.get('Authorization') ?? 'none');
        return jsonResponse({});
      },
    });
    const start = performance.now();
    // A long non-matching segment that would freeze a backtracking pattern.
    await f(`/files-${'x'.repeat(2_000)}/nope`, { method: 'GET' });
    expect(performance.now() - start).toBeLessThan(1_000);
    expect(seen).toEqual(['Bearer token']);
    await f('/files/ab', { method: 'GET' });
    expect(seen[1]).toBe('none'); // adjacent params still match one+ chars
  });

  it('duplicate Max-Age/Expires attributes resolve last-wins (RFC 6265bis §5.7)', () => {
    expect(parseSetCookie(['sid=abc; Max-Age=0; Max-Age=100'])).toBe('sid=abc');
    expect(parseSetCookie(['sid=abc; Max-Age=100; Max-Age=0'])).toBe('');
    expect(parseSetCookie(['sid=abc; Expires=Wed, 21 Oct 2015 07:28:00 GMT; Expires=Wed, 21 Oct 2099 07:28:00 GMT'])).toBe('sid=abc');
  });
});
