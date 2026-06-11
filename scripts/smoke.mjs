/**
 * Cross-runtime conformance smoke test. Runs the BUILT dist (`bun run
 * build` first) against a real local HTTP server on every supported
 * runtime and asserts the behaviors the README promises: result
 * discrimination, retry idempotency gating, timeout/abort error kinds,
 * schema validation, and URL/query serialization.
 *
 * Usage:
 *   node scripts/smoke.mjs        (after `bun run build` — exercises dist/)
 *   deno run -A scripts/smoke.mjs (exercises dist/ under Deno)
 *   bun scripts/smoke.mjs         (exercises dist/ under Bun)
 *
 * Exits non-zero on the first failed assertion.
 */

const { createFetch, timeout } = await import('../dist/index.js');
const { object, string, integer } = await import('../dist/schema/index.js');

const failures = [];
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok    ${name}`);
  }
  else {
    failures.push(name);
    console.error(`  FAIL  ${name} ${detail}`);
  }
}

// --- tiny portable HTTP server (node:http works on Node; Deno/Bun get it
// via their node-compat layers, all currently supported versions).
const { createServer } = await import('node:http');
let hits = 0;
const server = createServer((req, res) => {
  hits++;
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/pets/42') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 42, name: 'Rex' }));
  }
  else if (url.pathname === '/echo-query') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ search: url.search }));
  }
  else if (url.pathname === '/flaky-post') {
    res.statusCode = 500;
    res.end('boom');
  }
  else if (url.pathname === '/slow') {
    setTimeout(() => res.end('{}'), 3_000);
  }
  else if (url.pathname === '/problem') {
    res.statusCode = 403;
    res.setHeader('content-type', 'application/problem+json');
    res.end(JSON.stringify({ title: 'Out of credit' }));
  }
  else {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

try {
  // 1. Typed GET with schema validation.
  const f = createFetch({
    baseUrl: `${base}/`, // trailing slash on purpose — join must normalize
    routes: {
      '/pets/{petId}': {
        GET: { response: object({ id: integer(), name: string() }) },
      },
    },
  });
  const r1 = await f.get('/pets/{petId}', { params: { petId: 42 } }).result();
  check('GET + schema validates', r1.ok && r1.data.name === 'Rex', JSON.stringify(r1));

  // 2. Query serialization: arrays as repeated keys, merged correctly.
  const r2 = await f.get('/echo-query', { query: { ids: [1, 2], q: 'a b' } }).result();
  check('query arrays repeat keys', r2.ok && r2.data.search === '?ids=1&ids=2&q=a+b', JSON.stringify(r2));

  // 3. Retry does NOT replay POSTs by default.
  const before = hits;
  const r3 = await f('/flaky-post', { method: 'POST', body: { a: 1 }, retry: { attempts: 3, backoff: 0 } }).result();
  check('POST not retried by default', hits - before === 1 && !r3.ok && r3.error.kind === 'http', `hits=${hits - before}`);

  // 4. Timeout surfaces kind:'timeout'.
  const r4 = await f('/slow', { method: 'GET', middleware: [timeout(100)] }).result();
  check('timeout → kind timeout', !r4.ok && r4.error.kind === 'timeout', JSON.stringify(r4.ok ? {} : r4.error.kind));

  // 5. User abort surfaces kind:'aborted'.
  const ctrl = new AbortController();
  const p5 = f('/slow', { method: 'GET', signal: ctrl.signal }).result();
  setTimeout(() => ctrl.abort('cancelled'), 50);
  const r5 = await p5;
  check('abort → kind aborted', !r5.ok && r5.error.kind === 'aborted', JSON.stringify(r5.ok ? {} : r5.error.kind));

  // 6. problem+json parses as JSON with status preserved.
  const r6 = await f('/problem', { method: 'GET' }).result();
  check('problem+json parsed, status kept', !r6.ok && r6.error.kind === 'http' && r6.error.status === 403 && r6.error.body.title === 'Out of credit');

  // 7. .query() laziness: descriptor alone fires nothing.
  const preQuery = hits;
  f.get('/pets/{petId}', { params: { petId: 42 } }).query();
  await new Promise(resolve => setTimeout(resolve, 50));
  check('.query() fires no request', hits === preQuery);
}
finally {
  server.close();
}

if (failures.length > 0) {
  console.error(`\nsmoke: ${failures.length} failure(s) on ${globalThis.Deno ? 'deno' : globalThis.Bun ? 'bun' : `node ${process.version}`}`);
  process.exit(1);
}
console.log(`\nsmoke: all checks passed on ${globalThis.Deno ? 'deno' : globalThis.Bun ? 'bun' : `node ${process.version}`}`);
process.exit(0);
