// Category: "last-known-good behaviour when a feed fails"
//
// Every credential-gated worker.js feed adapter follows the same pattern:
// on a successful upstream fetch it writes the result into both a
// short-TTL "fresh" cache entry and a long-TTL "stale" entry; on a failed
// upstream fetch it falls back to the stale entry (if one exists) rather
// than returning an empty/broken payload. This test drives that pattern
// for real, using the same in-memory mock Cache API across two sequential
// requests: first a successful fetch (which warms the cache), then a
// failing fetch against the *same* mock cache instance (which must fall
// back to last-known-good).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  repoRoot,
  withWorker,
  makeMockCache,
  makeMockFetch,
  jsonRoute,
  textRoute,
  makeRequest,
  makeCtx,
  fullEnv,
  UKRAINE_BBOX_QS,
} from './lib/harness.mjs';

const gfwFixture = JSON.parse(readFileSync(path.join(repoRoot, 'tests/fixtures/gfw-events.json'), 'utf8'));
const firmsCsv = readFileSync(path.join(repoRoot, 'tests/fixtures/firms.csv'), 'utf8');

test('/maritime (GFW): falls back to last-known-good when the upstream API starts failing', async () => {
  const cache = makeMockCache();

  // Request 1: upstream succeeds, warms the fresh+stale cache.
  const okFetch = makeMockFetch({ routes: [jsonRoute('gateway.api.globalfishingwatch.org/v3/events', gfwFixture)] });
  await withWorker(
    async (worker) => {
      const res = await worker.fetch(makeRequest(`/maritime?profile=channel&${UKRAINE_BBOX_QS}`), fullEnv(), makeCtx());
      const body = await res.json();
      assert.equal(body.status, 'live');
      assert.equal(body.observations.length, 2);
    },
    { cache, fetchImpl: okFetch }
  );

  // Simulate the short-TTL "fresh" cache entry ageing out (30 min for GFW)
  // while the long-TTL "stale" entry (24h) is still valid, so request 2
  // actually re-hits the (now failing) upstream instead of just replaying
  // the still-fresh cache.
  cache._expireMatching('/fresh');

  // Request 2: same cache instance, but the upstream now fails outright.
  const failingFetch = makeMockFetch({ failHosts: ['gateway.api.globalfishingwatch.org'] });
  await withWorker(
    async (worker) => {
      const res = await worker.fetch(makeRequest(`/maritime?profile=channel&${UKRAINE_BBOX_QS}`), fullEnv(), makeCtx());
      assert.equal(res.status, 200, 'a degraded feed must still return 200, not propagate the upstream failure as a 500');
      const body = await res.json();
      assert.equal(body.status, 'fallback', 'expected the GFW adapter to report status "fallback" when serving stale data after an upstream failure');
      assert.equal(body.cacheState, 'stale-cache');
      assert.equal(body.observations.length, 2, 'last-known-good observations must still be returned, not an empty array');
      assert.match(body.error || '', /Global Fishing Watch/);
    },
    { cache, fetchImpl: failingFetch }
  );
});

test('/maritime (GFW): with no prior successful fetch and a failing upstream, degrades to an empty (not throwing) response', async () => {
  const cache = makeMockCache();
  const failingFetch = makeMockFetch({ failHosts: ['gateway.api.globalfishingwatch.org'] });
  await withWorker(
    async (worker) => {
      const res = await worker.fetch(makeRequest(`/maritime?profile=channel&${UKRAINE_BBOX_QS}`), fullEnv(), makeCtx());
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.status, 'degraded');
      assert.deepEqual(body.observations, [], 'with no last-known-good available, observations must be an empty array, not undefined/null');
    },
    { cache, fetchImpl: failingFetch }
  );
});

test('/snapshot?profile=ukraine (FIRMS thermal): falls back to last-known-good when NASA FIRMS starts failing', async () => {
  const cache = makeMockCache();

  const okFetch = makeMockFetch({ routes: [textRoute('firms.modaps.eosdis.nasa.gov', firmsCsv, 200, 'text/csv')] });
  await withWorker(
    async (worker) => {
      const res = await worker.fetch(makeRequest(`/snapshot?profile=ukraine&${UKRAINE_BBOX_QS}`), fullEnv(), makeCtx());
      const body = await res.json();
      assert.equal(body.health.thermal.status, 'live');
      assert.equal(body.health.thermal.count, 1);
    },
    { cache, fetchImpl: okFetch }
  );

  cache._expireMatching('/fresh');

  const failingFetch = makeMockFetch({ failHosts: ['firms.modaps.eosdis.nasa.gov'] });
  await withWorker(
    async (worker) => {
      const res = await worker.fetch(makeRequest(`/snapshot?profile=ukraine&${UKRAINE_BBOX_QS}`), fullEnv(), makeCtx());
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.health.thermal.status, 'fallback');
      assert.equal(body.health.thermal.cacheState, 'stale-cache');
      assert.equal(body.health.thermal.count, 1, 'last-known-good thermal cluster count must be preserved');
    },
    { cache, fetchImpl: failingFetch }
  );
});
