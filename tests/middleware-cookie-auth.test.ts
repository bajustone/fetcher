/**
 * Tests for the `cookieAuth` middleware and the `parseSetCookie` util.
 *
 * Mirrors the bearer-refresh suite where semantics overlap (single
 * in-flight, body cloning, exclude matchers, refresh-failure surfacing)
 * and adds cookie-specific coverage: lazy initial login, proactive
 * `refreshAfterMs`, and `parseSetCookie` parsing rules.
 */

import { describe, expect, it } from 'bun:test';
import { createFetch } from '../src/fetcher.ts';
import { cookieAuth, parseSetCookie } from '../src/middleware.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('parseSetCookie', () => {
  it('returns "" for null/undefined/empty input', () => {
    expect(parseSetCookie(null)).toBe('');
    expect(parseSetCookie(undefined)).toBe('');
    expect(parseSetCookie('')).toBe('');
    expect(parseSetCookie([])).toBe('');
    expect(parseSetCookie(new Headers())).toBe('');
  });

  it('strips attributes and keeps only name=value', () => {
    expect(
      parseSetCookie('sid=abc123; Path=/; HttpOnly; Secure; SameSite=Lax'),
    ).toBe('sid=abc123');
  });

  it('joins multiple cookies from a string[] with "; "', () => {
    expect(
      parseSetCookie([
        'sid=abc; Path=/; HttpOnly',
        'csrf=xyz; Path=/',
      ]),
    ).toBe('sid=abc; csrf=xyz');
  });

  it('handles cookies whose attributes contain commas (Expires)', () => {
    // The whole string IS one Set-Cookie header — comma in Expires
    // must NOT be interpreted as a separator.
    expect(
      parseSetCookie('sid=abc; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/'),
    ).toBe('sid=abc');
  });

  it('last-write-wins for duplicate cookie names', () => {
    expect(
      parseSetCookie([
        'sid=first; Path=/',
        'sid=second; Path=/',
      ]),
    ).toBe('sid=second');
  });

  it('skips entries without a name=value pair', () => {
    expect(
      parseSetCookie([
        '',
        '   ',
        'no-equals-sign',
        'sid=ok',
        '=value-with-no-name',
      ]),
    ).toBe('sid=ok');
  });

  it('reads from Headers via getSetCookie() when available', () => {
    const headers = new Headers();
    headers.append('set-cookie', 'sid=abc; Path=/; HttpOnly');
    headers.append('set-cookie', 'csrf=xyz; Path=/');
    // Bun + modern undici implement getSetCookie(); we don't assert on
    // legacy fallback here.
    if (typeof (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie === 'function') {
      expect(parseSetCookie(headers)).toBe('sid=abc; csrf=xyz');
    }
  });

  it('preserves values that contain "=" (e.g. base64)', () => {
    // Only the FIRST `=` separates name from value; the rest belong to
    // the value. Common in base64-encoded tokens.
    expect(parseSetCookie('token=YWJjPT09; Path=/')).toBe('token=YWJjPT09');
  });
});

describe('cookieAuth', () => {
  it('lazily logs in on the first request and attaches Cookie', async () => {
    let loginCalls = 0;
    const captured: { cookie: string | null } = { cookie: null };
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      middleware: [
        cookieAuth({
          login: async () => {
            loginCalls++;
            return 'sid=initial';
          },
          exclude: ['/auth/login'],
        }),
      ],
      fetch: async (req) => {
        captured.cookie = req.headers.get('cookie');
        return jsonResponse({ ok: true });
      },
    });

    // No login at construction time.
    expect(loginCalls).toBe(0);

    const response = await f('/users', { method: 'GET' });
    const result = await response.result();
    expect(result.ok).toBe(true);
    expect(loginCalls).toBe(1);
    expect(captured.cookie).toBe('sid=initial');
  });

  it('caches the cookie across requests (no extra logins)', async () => {
    let loginCalls = 0;
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      middleware: [
        cookieAuth({
          login: async () => {
            loginCalls++;
            return 'sid=v1';
          },
          exclude: ['/auth/login'],
        }),
      ],
      fetch: async () => jsonResponse({ ok: true }),
    });

    await f('/a', { method: 'GET' });
    await f('/b', { method: 'GET' });
    await f('/c', { method: 'GET' });
    expect(loginCalls).toBe(1);
  });

  it('does not attach Cookie or trigger login on excluded paths', async () => {
    let loginCalls = 0;
    const captured: Record<string, string | null> = {};
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      middleware: [
        cookieAuth({
          login: async () => {
            loginCalls++;
            return 'sid=abc';
          },
          exclude: ['/auth/login', '/auth/logout'],
        }),
      ],
      fetch: async (req) => {
        const path = new URL(req.url).pathname;
        captured[path] = req.headers.get('cookie');
        return jsonResponse({ ok: true });
      },
    });

    await f('/auth/login', { method: 'POST', body: {} });
    await f('/auth/logout', { method: 'POST' });
    expect(captured['/auth/login']).toBeNull();
    expect(captured['/auth/logout']).toBeNull();
    expect(loginCalls).toBe(0);

    // Authenticated request triggers login exactly once.
    await f('/users', { method: 'GET' });
    expect(captured['/users']).toBe('sid=abc');
    expect(loginCalls).toBe(1);
  });

  it('does not loop on the login endpoint itself when it returns 401', async () => {
    // If login is excluded (as it must be), a 401 from /auth/login surfaces
    // straight back to the caller — it never re-enters the refresh loop.
    let loginInvocations = 0;
    let calls = 0;
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      middleware: [
        cookieAuth({
          login: async () => {
            loginInvocations++;
            return 'sid=will-not-be-used';
          },
          exclude: ['/auth/login'],
        }),
      ],
      fetch: async (req) => {
        calls++;
        if (new URL(req.url).pathname === '/auth/login')
          return new Response('bad creds', { status: 401 });
        return jsonResponse({ ok: true });
      },
    });

    const response = await f('/auth/login', { method: 'POST', body: {} });
    expect(calls).toBe(1);
    expect(loginInvocations).toBe(0);
    const result = await response.result();
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'http')
      expect(result.error.status).toBe(401);
  });

  it('on 401, re-logs in and retries the request once', async () => {
    let loginCalls = 0;
    let cookieValue = 'sid=v1';
    let calls = 0;
    const cookies: string[] = [];

    const f = createFetch({
      baseUrl: 'https://api.example.com',
      middleware: [
        cookieAuth({
          login: async () => {
            loginCalls++;
            cookieValue = `sid=v${loginCalls + 1}`;
            return cookieValue;
          },
          exclude: ['/auth/login'],
        }),
      ],
      fetch: async (req) => {
        calls++;
        cookies.push(req.headers.get('cookie') ?? '');
        // First request after initial login: server says expired.
        // Second request after re-login: success.
        if (calls === 2)
          return new Response('expired', { status: 401 });
        return jsonResponse({ ok: true });
      },
    });

    // Initial login → call 1 (success)
    await f('/a', { method: 'GET' });
    // Server invalidates: call 2 (401) → relogin → call 3 (success)
    const r = await f('/b', { method: 'GET' });
    const result = await r.result();
    expect(result.ok).toBe(true);
    expect(calls).toBe(3);
    expect(loginCalls).toBe(2);
    expect(cookies[0]).toBe('sid=v2'); // first login produced v2
    expect(cookies[1]).toBe('sid=v2'); // second request, pre-401, still v2
    expect(cookies[2]).toBe('sid=v3'); // retry uses fresh cookie
  });

  it('returns the second 401 directly without looping again', async () => {
    let loginCalls = 0;
    let calls = 0;
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      middleware: [
        cookieAuth({
          login: async () => {
            loginCalls++;
            return 'sid=fresh';
          },
          exclude: ['/auth/login'],
        }),
      ],
      fetch: async () => {
        calls++;
        // Server keeps rejecting even with a fresh cookie.
        return new Response('still expired', { status: 401 });
      },
    });

    const response = await f('/users', { method: 'GET' });
    expect(calls).toBe(2); // initial + one retry
    expect(loginCalls).toBe(2); // initial login + one re-login
    const result = await response.result();
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'http')
      expect(result.error.status).toBe(401);
  });

  it('dedupes concurrent initial logins into one call', async () => {
    let loginCalls = 0;
    const loginDelay = 30;
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      middleware: [
        cookieAuth({
          login: () =>
            new Promise(resolve => setTimeout(() => {
              loginCalls++;
              resolve('sid=once');
            }, loginDelay)),
          exclude: ['/auth/login'],
        }),
      ],
      fetch: async () => jsonResponse({ ok: true }),
    });

    const results = await Promise.all([
      f('/a', { method: 'GET' }),
      f('/b', { method: 'GET' }),
      f('/c', { method: 'GET' }),
    ]);
    for (const res of results) {
      const r = await res.result();
      expect(r.ok).toBe(true);
    }
    expect(loginCalls).toBe(1);
  });

  it('dedupes concurrent 401s into a single re-login', async () => {
    let loginCalls = 0;

    const f = createFetch({
      baseUrl: 'https://api.example.com',
      middleware: [
        cookieAuth({
          // First login returns a stale cookie that the server will reject;
          // every subsequent login returns a fresh one.
          login: () =>
            new Promise(resolve => setTimeout(() => {
              loginCalls++;
              resolve(loginCalls === 1 ? 'sid=stale' : 'sid=fresh');
            }, 30)),
          exclude: ['/auth/login'],
        }),
      ],
      fetch: async (req) => {
        const c = req.headers.get('cookie');
        if (c === 'sid=stale')
          return new Response('expired', { status: 401 });
        return jsonResponse({ ok: true });
      },
    });

    // Three concurrent requests share the initial login (returns stale),
    // all hit 401, all share a single re-login (returns fresh), and all
    // succeed on retry.
    const results = await Promise.all([
      f('/a', { method: 'GET' }),
      f('/b', { method: 'GET' }),
      f('/c', { method: 'GET' }),
    ]);
    for (const res of results) {
      const r = await res.result();
      expect(r.ok).toBe(true);
    }
    // 1 = initial login (stale), 2 = post-401 re-login (fresh).
    expect(loginCalls).toBe(2);
  });

  it('clones the request body across the 401 retry', async () => {
    let loginCalls = 0;
    const bodies: string[] = [];

    const f = createFetch({
      baseUrl: 'https://api.example.com',
      middleware: [
        cookieAuth({
          login: async () => {
            loginCalls++;
            return loginCalls === 1 ? 'sid=stale' : 'sid=fresh';
          },
          exclude: ['/auth/login'],
        }),
      ],
      fetch: async (req) => {
        bodies.push(await req.text());
        if (req.headers.get('cookie') === 'sid=stale')
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

  it('surfaces login() rejection on 401 as kind:network via .result()', async () => {
    const loginErr = new Error('credentials revoked');
    let loginCalls = 0;

    const f = createFetch({
      baseUrl: 'https://api.example.com',
      middleware: [
        cookieAuth({
          login: async () => {
            loginCalls++;
            if (loginCalls === 1)
              return 'sid=stale';
            throw loginErr;
          },
          exclude: ['/auth/login'],
        }),
      ],
      fetch: async () => new Response('expired', { status: 401 }),
    });

    const response = await f('/users', { method: 'GET' });
    const result = await response.result();
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'network')
      expect(result.error.cause).toBe(loginErr);
    else
      throw new Error('expected kind:network with login cause');
  });

  it('refreshAfterMs: triggers proactive re-login after the window elapses', async () => {
    let loginCalls = 0;
    const cookiesSeen: string[] = [];
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      middleware: [
        cookieAuth({
          login: async () => {
            loginCalls++;
            return `sid=v${loginCalls}`;
          },
          refreshAfterMs: 50,
          exclude: ['/auth/login'],
        }),
      ],
      fetch: async (req) => {
        cookiesSeen.push(req.headers.get('cookie') ?? '');
        return jsonResponse({ ok: true });
      },
    });

    await f('/a', { method: 'GET' });
    // Within the window — no re-login.
    await f('/b', { method: 'GET' });
    expect(loginCalls).toBe(1);

    // Wait past the window.
    await new Promise(r => setTimeout(r, 70));
    await f('/c', { method: 'GET' });
    expect(loginCalls).toBe(2);
    expect(cookiesSeen).toEqual(['sid=v1', 'sid=v1', 'sid=v2']);
  });

  it('refreshAfterMs: reactive 401 refresh remains active alongside it', async () => {
    let loginCalls = 0;
    let calls = 0;
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      middleware: [
        cookieAuth({
          login: async () => {
            loginCalls++;
            return `sid=v${loginCalls}`;
          },
          // Long window — should not fire during this test. The 401 path
          // must still drive a re-login.
          refreshAfterMs: 60_000,
          exclude: ['/auth/login'],
        }),
      ],
      fetch: async () => {
        calls++;
        if (calls === 1)
          return jsonResponse({ ok: true }); // initial OK
        if (calls === 2)
          return new Response('revoked', { status: 401 });
        return jsonResponse({ ok: true }); // retry succeeds
      },
    });

    await f('/a', { method: 'GET' });
    const r = await f('/b', { method: 'GET' });
    const result = await r.result();
    expect(result.ok).toBe(true);
    expect(calls).toBe(3);
    expect(loginCalls).toBe(2); // initial + one reactive
  });

  it('exclude as RegExp', async () => {
    let loginCalls = 0;
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      middleware: [
        cookieAuth({
          login: async () => {
            loginCalls++;
            return 'sid=x';
          },
          exclude: /\/auth\//,
        }),
      ],
      fetch: async () => new Response('expired', { status: 401 }),
    });

    await f('/auth/login', { method: 'POST', body: {} });
    await f('/auth/logout', { method: 'POST' });
    expect(loginCalls).toBe(0);
  });

  it('exclude as predicate function', async () => {
    let loginCalls = 0;
    const f = createFetch({
      baseUrl: 'https://api.example.com',
      middleware: [
        cookieAuth({
          login: async () => {
            loginCalls++;
            return 'sid=x';
          },
          exclude: req => req.method === 'POST' && req.url.includes('/auth/'),
        }),
      ],
      fetch: async () => jsonResponse({ ok: true }),
    });

    await f('/auth/login', { method: 'POST', body: {} });
    expect(loginCalls).toBe(0);
    await f('/users', { method: 'GET' });
    expect(loginCalls).toBe(1);
  });
});
