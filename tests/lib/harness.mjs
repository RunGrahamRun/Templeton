// Shared test harness for exercising the real worker.js Cloudflare Worker
// inside plain Node.js, with no build step and no Wrangler/Miniflare
// dependency. This works because worker.js only needs three things that
// aren't already Node globals: a `caches` object (Cache API), `fetch`
// (Node has this natively, we override it per-test), and an execution
// context with `waitUntil`. Everything else (Request/Response/Headers/URL/
// crypto) is a standard Node global as of Node 20+.
//
// IMPORTANT: worker.js is imported fresh (a new dynamic import with a
// cache-busting query string) for every test file that needs isolated
// module-level state (e.g. the in-memory OpenSky/CDSE token caches), since
// ES module imports are cached by URL across the whole test run otherwise.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(__dirname, '..', '..');
export const workerPath = path.join(repoRoot, 'worker.js');

/**
 * A minimal in-memory implementation of the Cloudflare Cache API surface
 * that worker.js actually uses: cache.match(request) and cache.put(request,
 * response). Good enough to exercise fresh/stale cache-key logic and
 * last-known-good fallback behaviour.
 */
export function makeMockCache() {
  const store = new Map();
  const keyFor = (req) => (typeof req === 'string' ? req : req.url);
  return {
    async match(req) {
      const entry = store.get(keyFor(req));
      if (!entry) return undefined;
      return new Response(entry.body, { status: 200, headers: entry.headers });
    },
    async put(req, res) {
      const body = await res.clone().text();
      const headers = {};
      for (const [k, v] of res.headers.entries()) headers[k] = v;
      store.set(keyFor(req), { body, headers });
    },
    async delete(req) {
      return store.delete(keyFor(req));
    },
    // test-only helpers, not part of the real Cache API
    _has(req) {
      return store.has(keyFor(req));
    },
    _clear() {
      store.clear();
    },
    /**
     * Simulates enough wall-clock time passing for entries matching
     * `urlSubstring` to fall out of the cache (e.g. the short-TTL "fresh"
     * entry expiring while the long-TTL "stale" entry is still valid).
     * worker.js's cache keys always end in `/fresh` or `/stale`, so passing
     * '/fresh' here reproduces "fresh expired, stale still present" without
     * needing to fake Date.now() globally.
     */
    _expireMatching(urlSubstring) {
      for (const key of [...store.keys()]) {
        if (key.includes(urlSubstring)) store.delete(key);
      }
    },
  };
}

/**
 * Builds a routable fetch mock. `routes` is an array of
 * { test: (url) => boolean, handler: (url, init) => Response | Promise<Response> }
 * evaluated in order; the first match wins. Anything unmatched falls back to
 * a generic 200 `{}` JSON response so probes that merely check reachability
 * (e.g. the 22-source /diagnostics/connectivity sweep) don't throw.
 *
 * Pass `routes: []` for "everything is a generic 200" behaviour, or set
 * `failHosts: [...]` substrings to force a network-style rejection for
 * specific upstream hosts (used to simulate feed failure / last-known-good
 * tests).
 */
export function makeMockFetch({ routes = [], failHosts = [] } = {}) {
  const calls = [];
  const fn = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, init });
    if (failHosts.some((h) => url.includes(h))) {
      throw new Error(`mock network failure for ${url}`);
    }
    for (const route of routes) {
      if (route.test(url)) {
        return route.handler(url, init);
      }
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  fn.calls = calls;
  return fn;
}

export function jsonRoute(match, body, status = 200) {
  return {
    test: (url) => (typeof match === 'string' ? url.includes(match) : match.test(url)),
    handler: () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  };
}

export function textRoute(match, body, status = 200, contentType = 'text/csv') {
  return {
    test: (url) => (typeof match === 'string' ? url.includes(match) : match.test(url)),
    handler: () => new Response(body, { status, headers: { 'content-type': contentType } }),
  };
}

/** Baseline set of secrets so credential-gated adapters exercise their live path. */
export function fullEnv(overrides = {}) {
  return {
    GEMINI_API_KEY: 'test-gemini-key',
    GFW_API_TOKEN: 'test-gfw-token',
    FIRMS_MAP_KEY: 'test-firms-key',
    UCDP_ACCESS_TOKEN: 'test-ucdp-token',
    RELIEFWEB_APPNAME: 'test-appname',
    COPERNICUS_CLIENT_ID: 'test-cdse-id',
    COPERNICUS_CLIENT_SECRET: 'test-cdse-secret',
    ...overrides,
  };
}

/** No secrets configured at all — every credential-gated adapter must degrade gracefully. */
export function emptyEnv() {
  return {};
}

/**
 * Imports worker.js fresh, installs the given mock cache/fetch as globals
 * for the duration of the call, and returns { worker, restore }.
 * Callers MUST call restore() (or use `await withWorker(...)`) so mocks
 * don't leak between test files.
 */
export async function importWorker() {
  const mod = await import(`${pathToFileUrl(workerPath)}?t=${Date.now()}-${Math.random()}`);
  return mod.default;
}

function pathToFileUrl(p) {
  return `file://${p}`;
}

/**
 * Runs `fn(worker, { cache, fetchCalls })` with mock caches/fetch installed,
 * then restores the real globals afterwards even if fn throws.
 */
export async function withWorker(fn, { cache = makeMockCache(), fetchImpl = makeMockFetch() } = {}) {
  const realCaches = globalThis.caches;
  const realFetch = globalThis.fetch;
  globalThis.caches = { default: cache };
  globalThis.fetch = fetchImpl;
  try {
    const worker = await importWorker();
    return await fn(worker, { cache, fetchCalls: fetchImpl.calls || [] });
  } finally {
    globalThis.caches = realCaches;
    globalThis.fetch = realFetch;
  }
}

/**
 * Query-string fragment selecting the worker's own Ukraine bounding box
 * (matches the `ukraine` constant inside workerConnectivityDiagnostics in
 * worker.js). Test fixtures use Ukraine-area coordinates, so requests that
 * need those fixture observations to survive the adapter's inBBox() filter
 * must pass this — the default parseBBox() fallback is the English Channel.
 */
export const UKRAINE_BBOX_QS = 'south=44&west=22&north=53&east=41';

export function makeRequest(pathAndQuery, init = {}) {
  return new Request(`https://worker.test${pathAndQuery}`, init);
}

export function makeCtx() {
  const tasks = [];
  return { waitUntil: (p) => tasks.push(p), _tasks: tasks };
}
