// Category: "mocked Worker endpoints and feed adapters"
//
// Exercises the real fetch handler in worker.js end-to-end for its main
// routes, with all upstream network calls intercepted by a mock fetch
// router (tests/lib/harness.mjs). No real network access ever happens in
// this suite. Covers both the "no credentials configured" degrade path and
// the "credentials configured, upstream returns fixture data" happy path
// for the three named feeds (GFW, FIRMS) plus a context feed (NOAA SWPC).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  repoRoot,
  withWorker,
  makeMockFetch,
  jsonRoute,
  textRoute,
  makeRequest,
  makeCtx,
  fullEnv,
  emptyEnv,
  UKRAINE_BBOX_QS,
} from './lib/harness.mjs';

const gfwFixture = JSON.parse(readFileSync(path.join(repoRoot, 'tests/fixtures/gfw-events.json'), 'utf8'));
const firmsCsv = readFileSync(path.join(repoRoot, 'tests/fixtures/firms.csv'), 'utf8');
const swpcKIndex = JSON.parse(readFileSync(path.join(repoRoot, 'tests/fixtures/swpc-k-index.json'), 'utf8'));

test('/health lists every credential-gated feed as unconfigured when no secrets are set', async () => {
  await withWorker(async (worker) => {
    const res = await worker.fetch(makeRequest('/health'), emptyEnv(), makeCtx());
    const body = await res.json();
    assert.equal(body.secrets.globalFishingWatch, false);
    assert.equal(body.secrets.firms, false);
    assert.equal(body.secrets.ucdp, false);
    assert.equal(body.secrets.copernicusImagery, false);
    // Secret values themselves must never be echoed back.
    assert.equal(JSON.stringify(body).includes('test-gfw-token'), false);
  });
});

test('/health flags every credential-gated feed as configured (booleans only) when secrets are set', async () => {
  await withWorker(async (worker) => {
    const res = await worker.fetch(makeRequest('/health'), fullEnv(), makeCtx());
    const body = await res.json();
    assert.equal(body.secrets.globalFishingWatch, true);
    assert.equal(body.secrets.firms, true);
    assert.equal(body.secrets.ucdp, true);
    // Still never echoes the raw secret value.
    assert.equal(JSON.stringify(body).includes('test-gfw-token'), false);
  });
});

test('/maritime without GFW_API_TOKEN degrades gracefully (credential-required, not a throw)', async () => {
  await withWorker(async (worker) => {
    const res = await worker.fetch(makeRequest('/maritime?profile=channel'), emptyEnv(), makeCtx());
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'credential-required');
    assert.deepEqual(body.observations, []);
  });
});

test('/maritime with GFW_API_TOKEN and a mocked Events API response returns parsed observations', async () => {
  const fetchImpl = makeMockFetch({
    routes: [jsonRoute('gateway.api.globalfishingwatch.org/v3/events', gfwFixture)],
  });
  await withWorker(async (worker) => {
    const res = await worker.fetch(makeRequest(`/maritime?profile=channel&${UKRAINE_BBOX_QS}`), fullEnv(), makeCtx());
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'live');
    assert.equal(body.observations.length, 2);
    const encounter = body.observations.find((o) => o.attributes.maritimeActivityType === 'ENCOUNTER');
    assert.ok(encounter, 'expected an encounter observation');
    assert.equal(encounter['@type'], 'https://twinstone.local/ontology#MaritimeActivityObservation');
    assert.equal(encounter.attributes.cause, 'unknown');
    assert.equal(encounter.attributes.intent, 'unknown');
    assert.match(encounter.attributes.interpretation, /does not by itself establish transshipment/i);
  }, { fetchImpl });
});

test('/snapshot?profile=ukraine with FIRMS_MAP_KEY and a mocked CSV response returns thermal clusters', async () => {
  const fetchImpl = makeMockFetch({
    routes: [textRoute('firms.modaps.eosdis.nasa.gov', firmsCsv, 200, 'text/csv')],
  });
  await withWorker(async (worker) => {
    const res = await worker.fetch(makeRequest(`/snapshot?profile=ukraine&${UKRAINE_BBOX_QS}`), fullEnv(), makeCtx());
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.health.thermal.status, 'live');
    // Two nominal-confidence detections should cluster into 1 observation;
    // the low-confidence pixel must be filtered out before clustering.
    assert.equal(body.health.thermal.count, 1);
    const thermal = body.observations.find((o) => o['@type'].endsWith('ThermalAnomalyObservation'));
    assert.ok(thermal);
    assert.match(thermal.attributes.interpretation, /does not establish a strike, explosion, damage/i);
  }, { fetchImpl });
});

test('/context returns NOAA SWPC as a non-corroborating context source', async () => {
  const fetchImpl = makeMockFetch({
    routes: [jsonRoute('services.swpc.noaa.gov/products/noaa-planetary-k-index.json', swpcKIndex)],
  });
  await withWorker(async (worker) => {
    const res = await worker.fetch(makeRequest('/context?profile=channel'), fullEnv(), makeCtx());
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.sources?.spaceWeather, 'expected a sources.spaceWeather context block in /context response');
    assert.equal(body.sources.spaceWeather.contributesToCorroborationScore, false);
  }, { fetchImpl });
});

test('/diagnostics/connectivity runs all 22 probes against mocked hosts without throwing', async () => {
  await withWorker(async (worker) => {
    const res = await worker.fetch(makeRequest('/diagnostics/connectivity'), fullEnv(), makeCtx());
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.tests));
    assert.equal(body.tests.length, 22);
    const workerSrc = readFileSync(path.join(repoRoot, 'worker.js'), 'utf8');
    const versionMatch = workerSrc.match(/const VERSION\s*=\s*'([^']+)'/);
    assert.ok(versionMatch, 'could not find VERSION constant in worker.js');
    assert.equal(body.version, versionMatch[1]);
  });
});

test('/query (Gemini) with no observations and no GEMINI_API_KEY fails cleanly, not with an unhandled throw', async () => {
  await withWorker(async (worker) => {
    const res = await worker.fetch(
      makeRequest('/query', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: 'What is happening?', observations: [] }),
      }),
      emptyEnv(),
      makeCtx()
    );
    // Must not be an "Unhandled Worker error" (that would indicate an
    // uncaught exception rather than a modeled error response).
    const body = await res.json();
    assert.notEqual(body.error, 'Unhandled Worker error');
  });
});
