// Category: "source provenance survives normalization"
//
// Every observation worker.js emits carries a `provenance` block
// (source, sourceRecordId, ingestedAt, transport — from makeObservation —
// plus adapter-specific extras such as GFW's provenance.sourceUrl/method,
// FIRMS's provenance.sourceDataProduct, or UCDP's provenance.sourceDataVersion
// and provenance.sourceUrl). Before an observation reaches the Gemini
// prompt it is passed through compactObservation(), which only forwards a
// fixed provenance field whitelist. This test drives that real code path
// end-to-end via POST /query with a mocked Gemini upstream, and inspects
// the exact JSON body worker.js sent to Gemini — i.e. it tests
// normalization survival for real, not a re-implementation of the rule.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withWorker, makeMockFetch, makeRequest, makeCtx, fullEnv } from './lib/harness.mjs';

function firmsLikeObservation() {
  return {
    '@id': 'urn:twinstone:observation:test-firms-1',
    '@type': 'https://twinstone.local/ontology#ThermalAnomalyObservation',
    entity: { '@id': 'urn:twinstone:thermal-cluster:test', '@type': 'https://twinstone.local/ontology#ThermalAnomalyCluster', label: 'test cluster' },
    observedAt: new Date().toISOString(),
    location: { lat: 50.9, lon: 30.5 },
    kinematics: {},
    attributes: { cause: 'unknown' },
    derived: {},
    provenance: {
      source: 'NASA FIRMS VIIRS NOAA-20 NRT',
      sourceRecordId: 'test-firms-1',
      ingestedAt: new Date().toISOString(),
      transport: 'worker-https',
      method: 'NASA FIRMS area CSV + deterministic 1.5 km / 90 min clustering after low-confidence filtering',
      sourceDataProduct: 'VIIRS_NOAA20_NRT',
    },
  };
}

function ucdpLikeObservation() {
  return {
    '@id': 'urn:twinstone:observation:test-ucdp-1',
    '@type': 'https://twinstone.local/ontology#ReportedConflictEvent',
    entity: { '@id': 'urn:twinstone:event:test', '@type': 'https://twinstone.local/ontology#ReportedConflictEvent', label: 'test event' },
    observedAt: new Date().toISOString(),
    location: { lat: 50.4, lon: 30.5 },
    kinematics: {},
    attributes: { cause: 'unknown' },
    derived: {},
    provenance: {
      source: 'UCDP Candidate Events',
      sourceRecordId: 'test-ucdp-1',
      ingestedAt: new Date().toISOString(),
      transport: 'worker-https',
      method: 'UCDP GED API paginated retrieval',
      sourceDataVersion: '26.1',
      sourceUrl: 'https://ucdpapi.pcr.uu.se/api/gedevents/26.1',
    },
  };
}

async function captureGeminiPrompt(observations) {
  let capturedBody = null;
  const fetchImpl = makeMockFetch({
    routes: [
      {
        test: (url) => url.includes('generativelanguage.googleapis.com'),
        handler: async (url, init) => {
          capturedBody = JSON.parse(init.body);
          return new Response(
            JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        },
      },
    ],
  });
  await withWorker(
    async (worker) => {
      const res = await worker.fetch(
        makeRequest('/query', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ question: 'Summarize the picture.', observations }),
        }),
        fullEnv(),
        makeCtx()
      );
      assert.equal(res.status, 200, `POST /query should succeed with a mocked Gemini upstream (got ${res.status})`);
    },
    { fetchImpl }
  );
  assert.ok(capturedBody, 'the mocked Gemini endpoint was never called — cannot inspect the compacted prompt');
  const promptText = capturedBody.contents[0].parts[0].text;
  return JSON.parse(promptText);
}

test('core provenance fields (source, sourceRecordId, ingestedAt, transport) survive normalization into the Gemini prompt', async () => {
  const prompt = await captureGeminiPrompt([firmsLikeObservation()]);
  const compacted = prompt.observations.find((o) => o.id === 'urn:twinstone:observation:test-firms-1');
  assert.ok(compacted, 'the FIRMS-like observation was dropped entirely during normalization');
  assert.equal(compacted.provenance.source, 'NASA FIRMS VIIRS NOAA-20 NRT');
  assert.equal(compacted.provenance.sourceRecordId, 'test-firms-1');
  assert.equal(compacted.provenance.transport, 'worker-https');
  assert.ok(compacted.provenance.ingestedAt, 'provenance.ingestedAt must survive');
});

test('FIRMS-specific provenance.sourceDataProduct survives normalization into the Gemini prompt', async () => {
  const prompt = await captureGeminiPrompt([firmsLikeObservation()]);
  const compacted = prompt.observations.find((o) => o.id === 'urn:twinstone:observation:test-firms-1');
  assert.equal(
    compacted.provenance.sourceDataProduct,
    'VIIRS_NOAA20_NRT',
    'compactObservation() in worker.js drops provenance.sourceDataProduct (it is not in the field whitelist) — ' +
      'a FIRMS-derived observation reaching Gemini loses which VIIRS product it came from. ' +
      'Add sourceDataProduct to the provenance whitelist in compactObservation().'
  );
});

test('UCDP-specific provenance.sourceDataVersion survives normalization into the Gemini prompt', async () => {
  const prompt = await captureGeminiPrompt([ucdpLikeObservation()]);
  const compacted = prompt.observations.find((o) => o.id === 'urn:twinstone:observation:test-ucdp-1');
  assert.equal(
    compacted.provenance.sourceDataVersion,
    '26.1',
    'compactObservation() in worker.js drops provenance.sourceDataVersion (it is not in the field whitelist) — ' +
      'a UCDP-derived observation reaching Gemini loses which GED API version produced it. ' +
      'Add sourceDataVersion to the provenance whitelist in compactObservation().'
  );
});

test('adapter-added provenance.method and provenance.sourceUrl survive normalization', async () => {
  const prompt = await captureGeminiPrompt([ucdpLikeObservation()]);
  const compacted = prompt.observations.find((o) => o.id === 'urn:twinstone:observation:test-ucdp-1');
  assert.equal(compacted.provenance.method, 'UCDP GED API paginated retrieval');
  assert.equal(compacted.provenance.sourceUrl, 'https://ucdpapi.pcr.uu.se/api/gedevents/26.1');
});
