// Category: "context sources don't accidentally contribute to corroboration"
//
// Twinstone treats "context" feeds (NOAA SWPC, IODA, ReliefWeb, WHO DON)
// as strictly informational: they must never silently start counting
// toward the deterministic corroboration score. Two independent
// enforcement points exist and both are checked here:
//   1. Server-side: every contextStatus()-built payload is stamped
//      contributesToCorroborationScore:false (worker.js), verified end to
//      end via a live /context call.
//   2. Client-side: the corroboration-watchlist eligibility filter in
//      twinstone.html only accepts a fixed, named allowlist of evidentiary
//      domains — this test extracts that literal allowlist from the real
//      source (not a re-implementation) and asserts no context domain has
//      been added to it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { repoRoot, withWorker, makeMockFetch, jsonRoute, makeRequest, makeCtx, fullEnv } from './lib/harness.mjs';

const swpcKIndex = JSON.parse(readFileSync(path.join(repoRoot, 'tests/fixtures/swpc-k-index.json'), 'utf8'));

const CONTEXT_ONLY_DOMAINS = ['aircraft', 'vessels', 'maritimeActivity', 'weather', 'earthquakes', 'satellites', 'investigationContext'];
const EVIDENTIARY_CORROBORATING_DOMAINS = ['thermal', 'earthObservationChange', 'reportedConflict'];

test('/context: every context feed block reports contributesToCorroborationScore = false', async () => {
  const fetchImpl = makeMockFetch({
    routes: [jsonRoute('services.swpc.noaa.gov/products/noaa-planetary-k-index.json', swpcKIndex)],
  });
  await withWorker(
    async (worker) => {
      const res = await worker.fetch(makeRequest('/context?profile=channel'), fullEnv(), makeCtx());
      const body = await res.json();
      const contextBlocks = Object.entries(body.sources || {}).filter(([, v]) => v && typeof v === 'object' && 'contributesToCorroborationScore' in v);
      assert.ok(contextBlocks.length > 0, 'expected at least one context feed block with contributesToCorroborationScore under body.sources in the /context response');
      for (const [name, block] of contextBlocks) {
        assert.equal(block.contributesToCorroborationScore, false, `context feed "${name}" must not contribute to the corroboration score`);
      }
    },
    { fetchImpl }
  );
});

test('the client-side corroboration-eligibility domain allowlist is exactly the three evidentiary domains, no context domains included', () => {
  const html = readFileSync(path.join(repoRoot, 'twinstone.html'), 'utf8');
  const m = html.match(/\.filter\(o=>(\[[^\]]*\])\.includes\(observationDomain\(o\)\)/);
  assert.ok(m, 'could not find the corroboration-eligibility domain filter in twinstone.html (recomputeCorroborationWatchlist)');
  const eligibleDomains = JSON.parse(m[1].replace(/'/g, '"'));

  for (const domain of EVIDENTIARY_CORROBORATING_DOMAINS) {
    assert.ok(eligibleDomains.includes(domain), `expected "${domain}" to remain in the corroboration-eligible domain list`);
  }
  for (const domain of CONTEXT_ONLY_DOMAINS) {
    assert.ok(
      !eligibleDomains.includes(domain),
      `context/non-corroborating domain "${domain}" must NOT appear in the corroboration-eligibility filter — ` +
        `this is exactly the class of change that would let a context or non-evidentiary feed silently inflate the corroboration score`
    );
  }
  assert.deepEqual(
    [...eligibleDomains].sort(),
    [...EVIDENTIARY_CORROBORATING_DOMAINS].sort(),
    'the corroboration-eligible domain set has changed — if this is intentional, update EVIDENTIARY_CORROBORATING_DOMAINS in this test ' +
      'AND the "Evidence and semantic boundaries" section of README.md AND core/twinstone-shapes.ttl together'
  );
});

test('Global Fishing Watch maritime activity (algorithmic AIS-derived, not live position) is excluded from corroboration eligibility', () => {
  const html = readFileSync(path.join(repoRoot, 'twinstone.html'), 'utf8');
  const m = html.match(/\.filter\(o=>(\[[^\]]*\])\.includes\(observationDomain\(o\)\)/);
  const eligibleDomains = JSON.parse(m[1].replace(/'/g, '"'));
  assert.ok(
    !eligibleDomains.includes('maritimeActivity'),
    'GFW maritimeActivity must stay excluded from the deterministic corroboration score per README\'s documented semantics'
  );
});
