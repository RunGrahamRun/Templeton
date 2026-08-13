// Category: "temporal ageing/staleness behaviour"
//
// twinstone.html classifies every observation into current / ageing /
// stale / expired using a per-domain TEMPORAL_PROFILES table and the
// temporalInfo() function. This test extracts and runs the *actual*
// client-side function (see tests/lib/extract-client-js.mjs) rather than
// re-implementing the thresholds, so it fails for real if someone edits
// the ageing logic or the thresholds in a way that breaks the documented
// current/ageing/stale/expired contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { repoRoot } from './lib/harness.mjs';
import { extractInlineJs, extractFunctionSource, extractObjectConstSource, evalInSandbox } from './lib/extract-client-js.mjs';

function loadTemporalSandbox() {
  const html = readFileSync(path.join(repoRoot, 'twinstone.html'), 'utf8');
  const js = extractInlineJs(html);
  const fragments = [
    `const TW='https://twinstone.local/ontology#';`,
    `const IES='http://ies.data.gov.uk/ontology/ies4#';`,
    extractObjectConstSource(js, 'TEMPORAL_PROFILES'),
    extractFunctionSource(js, 'observationDomain'),
    extractFunctionSource(js, 'observationAgeSeconds'),
    extractFunctionSource(js, 'temporalInfo'),
  ];
  return evalInSandbox(fragments, ['TEMPORAL_PROFILES', 'observationDomain', 'observationAgeSeconds', 'temporalInfo']);
}

function makeObservation(type, ageSeconds, now) {
  return { '@type': type, observedAt: new Date(now - ageSeconds * 1000).toISOString() };
}

test('TEMPORAL_PROFILES defines thresholds for the thermal, reportedConflict and maritimeActivity domains', () => {
  const { TEMPORAL_PROFILES } = loadTemporalSandbox();
  for (const domain of ['thermal', 'reportedConflict', 'maritimeActivity', 'default']) {
    const p = TEMPORAL_PROFILES[domain];
    assert.ok(p, `missing TEMPORAL_PROFILES entry for "${domain}"`);
    assert.ok(p.currentMaxSec < p.ageingMaxSec, `${domain}: currentMaxSec must be < ageingMaxSec`);
    assert.ok(p.ageingMaxSec <= p.expireMaxSec, `${domain}: ageingMaxSec must be <= expireMaxSec`);
  }
});

test('temporalInfo classifies a fresh FIRMS thermal observation as "current"', () => {
  const { temporalInfo } = loadTemporalSandbox();
  const now = Date.parse('2026-08-13T00:00:00Z');
  const obs = makeObservation('https://twinstone.local/ontology#ThermalAnomalyObservation', 100, now);
  assert.equal(temporalInfo(obs, now).status, 'current');
});

test('temporalInfo classifies an observation just past currentMaxSec as "ageing", not "current" or "stale"', () => {
  const { TEMPORAL_PROFILES, temporalInfo } = loadTemporalSandbox();
  const now = Date.parse('2026-08-13T00:00:00Z');
  const threshold = TEMPORAL_PROFILES.thermal.currentMaxSec;
  const obs = makeObservation('https://twinstone.local/ontology#ThermalAnomalyObservation', threshold + 60, now);
  assert.equal(temporalInfo(obs, now).status, 'ageing');
});

test('temporalInfo classifies an observation past ageingMaxSec (but before expireMaxSec) as "stale"', () => {
  const { TEMPORAL_PROFILES, temporalInfo } = loadTemporalSandbox();
  const now = Date.parse('2026-08-13T00:00:00Z');
  const threshold = TEMPORAL_PROFILES.thermal.ageingMaxSec;
  const obs = makeObservation('https://twinstone.local/ontology#ThermalAnomalyObservation', threshold + 60, now);
  assert.equal(temporalInfo(obs, now).status, 'stale');
});

test('temporalInfo classifies an observation past expireMaxSec as "expired" (candidate for pruning)', () => {
  const { TEMPORAL_PROFILES, temporalInfo } = loadTemporalSandbox();
  const now = Date.parse('2026-08-13T00:00:00Z');
  const threshold = TEMPORAL_PROFILES.thermal.expireMaxSec;
  const obs = makeObservation('https://twinstone.local/ontology#ThermalAnomalyObservation', threshold + 60, now);
  assert.equal(temporalInfo(obs, now).status, 'expired');
});

test('maritimeActivity (GFW) uses a much longer freshness window than live position feeds like aircraft/vessels', () => {
  // GFW is an AIS-derived *activity-history* source, not a live position
  // feed — README documents this explicitly. A regression that collapses
  // maritimeActivity onto the short "default"/aircraft window would make
  // every GFW event look immediately stale.
  const { TEMPORAL_PROFILES } = loadTemporalSandbox();
  assert.ok(
    TEMPORAL_PROFILES.maritimeActivity.currentMaxSec > TEMPORAL_PROFILES.aircraft.currentMaxSec * 100,
    'maritimeActivity.currentMaxSec should be at least two orders of magnitude longer than aircraft.currentMaxSec'
  );
});

test('worker.js Gemini system prompt documents that stale observations must not be described as current', () => {
  const workerSrc = readFileSync(path.join(repoRoot, 'worker.js'), 'utf8');
  assert.match(
    workerSrc,
    /stale observations are last-known evidence only and must not be described as a current position or current state/i
  );
});
