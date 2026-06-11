# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.x     | ✅ Active — security fixes and bug fixes |
| 0.x     | ⚠️ Critical security fixes only, for 6 months after the 1.0.0 release |

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/bajustone/fetcher/security/advisories/new)
— do **not** open a public issue for security problems. You should receive a
response within 7 days. If the report is accepted, a fix and advisory will be
coordinated with you before disclosure.

## Security guarantees and their boundaries

These are the security-relevant behaviors the library relies on or provides.
Knowing where each one comes from (the runtime vs. this library) matters when
you audit your own application.

### Credential headers and redirects

`fetcher` delegates redirect handling entirely to the runtime's native
`fetch` — it never implements its own redirect following, and never re-adds
headers after a redirect. Per the WHATWG fetch specification, the runtime
strips `Authorization` (and `Cookie` / `Proxy-Authorization`) when a redirect
crosses origins (scheme + host + port).

This protection is only as good as the runtime. Known floors:

- **Node.js** ≥ 18.4 strips `Authorization`; the `Cookie` header was only
  stripped from undici 5.26.2 (CVE-2023-45143) and `Proxy-Authorization`
  from 5.28.3/6.6.1 (CVE-2024-24758). Use a current Node release.
- **Deno** ≥ 2.1.2 (CVE-2025-21620 fixed `Authorization` stripping).
- **Bun** is spec-compliant (verified in its own test suite).
- **Browsers**: Chrome ≥ 119, Firefox ≥ 111, Safari ≥ 16.1.

⚠️ The spec-mandated stripping covers `Authorization` and `Cookie`. **Custom
credential headers** (e.g. `X-API-Key` injected via `getHeaders` or
`defaultHeaders`) are *not* stripped by any runtime and will follow
cross-origin redirects. Don't point a credentialed client at servers that
redirect to origins you don't control.

### Retry semantics

- `retry()` never retries non-idempotent methods (`POST`/`PATCH`) unless you
  opt in explicitly — a network-failed POST may already have been applied
  server-side (RFC 9110 §9.2.2).
- Server-sent `Retry-After` headers are capped (`maxRetryAfter`, default
  `maxBackoff` = 30 s) so a hostile server cannot stall your process.
- Requests aborted by your `AbortSignal` are never retried.

### Untrusted OpenAPI documents

`fromOpenAPI` / `fromJSONSchema` compile `pattern` keywords from the spec
with `new RegExp(...)` and run them against response data. JavaScript has no
linear-time regex engine, so **a malicious or careless third-party spec can
ship a catastrophically backtracking regex (ReDoS)**. Treat OpenAPI documents
as code: only build validators from specs you trust. The bundled format
helpers (`email`, `uuid`, `datetime`, …) use linear-time regexes.

### Cookie handling

`cookieAuth` / `parseSetCookie` are for **server-side runtimes only**
(browsers neither expose `Set-Cookie` to JavaScript nor allow setting
`Cookie`). The cookie string lives in process memory only — it is never
persisted, logged, or echoed into error messages by the library. Cookies
deleted by the server (`Max-Age=0` or a past `Expires`) are honored.

### Error-object hygiene

`FetcherError` carries the parsed response body, the failure cause, and
validation issues — it never carries request headers, so an error that
reaches your logs cannot leak an `Authorization` header or cookie by itself.
Note that *URLs* (including any query-string secrets you put there) can
appear in transport-level causes produced by the runtime; avoid secrets in
query strings.

### Supply chain

Releases are published to JSR and npm exclusively from GitHub Actions with
OIDC (tokenless), generating signed provenance attestations on both
registries. Verify with `npm audit signatures` or the Provenance section on
jsr.io. The package has zero runtime dependencies.
