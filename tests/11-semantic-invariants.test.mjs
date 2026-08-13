// Category: semantic invariants — "GFW encounter ≠ transshipment",
// "FIRMS anomaly ≠ attack", "Sentinel change ≠ damage",
// "missing feed ≠ zero activity"
//
// These boundaries are enforced in two places and both are checked:
//   1. worker.js's Gemini systemInstruction array — sent to the LLM on
//      every /query call, so it applies even to a modified/forked client.
//      This is the tamper-resistant layer and is treated as authoritative.
//   2. Inline per-observation interpretation strings generated at fetch
//      time (gfwInterpretationBoundary, the FIRMS cluster interpretation,
//      the UCDP interpretation) — these travel with the data itself.
//
// Each check below is a substring/regex match against the real worker.js
// source, named after the specific invariant it protects, so a future
// rewording that keeps the *meaning* intact should still pass, while
// deleting or gutting a boundary fails loudly with a clear message about
// which named invariant broke.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { repoRoot } from './lib/harness.mjs';

const workerSrc = readFileSync(path.join(repoRoot, 'worker.js'), 'utf8');
const htmlSrc = readFileSync(path.join(repoRoot, 'twinstone.html'), 'utf8');
const rulesSrc = readFileSync(path.join(repoRoot, 'TWINSTONE_RULES.md'), 'utf8');

function assertWorkerContains(pattern, invariantName) {
  assert.match(
    workerSrc,
    pattern,
    `Semantic invariant "${invariantName}" appears to be missing from worker.js. ` +
      `This boundary is sent to the LLM on every /query call and/or attached to the observation itself — ` +
      `it must not be silently dropped or reworded away.`
  );
}

test('invariant: GFW encounter ≠ transshipment (and related maritime-activity boundaries)', () => {
  assertWorkerContains(/does not by itself establish transshipment/i, 'GFW encounter ≠ transshipment');
  assertWorkerContains(/encounter does not establish transshipment/i, 'GFW encounter ≠ transshipment (Gemini system prompt)');
  assertWorkerContains(/apparent fishing is not independently confirmed fishing/i, 'GFW apparent fishing ≠ confirmed fishing');
});

test('invariant: FIRMS anomaly ≠ attack/strike/damage', () => {
  assertWorkerContains(
    /do not describe a firms cluster as an attack, explosion, strike, damage site or military event/i,
    'FIRMS anomaly ≠ attack'
  );
  assertWorkerContains(
    /does not establish a strike, explosion, damage, actor, intent or attribution/i,
    'FIRMS anomaly ≠ attack (per-observation interpretation)'
  );
});

test('invariant: Sentinel/EO change ≠ damage or cause', () => {
  assertWorkerContains(
    /they do not identify the cause, object type, actor, intent, strike, damage mechanism, unit, or attribution/i,
    'Sentinel change ≠ damage'
  );
  assertWorkerContains(
    /never infer damage, strikes, unit locations, intent, or military activity from catalogue metadata or imagery availability alone/i,
    'Sentinel catalogue metadata ≠ ground-truth interpretation'
  );
});

test('invariant: missing feed/historical coverage ≠ zero real-world activity', () => {
  assertWorkerContains(
    /never interpret missing historical source coverage as zero real-world activity/i,
    'missing feed ≠ zero activity'
  );
  assertWorkerContains(/a lack of observations does not prove a lack of real-world activity/i, 'missing feed ≠ zero activity (restated)');
});

test('invariant: UCDP reported events are not physical sensor proof / not causally linked to co-located anomalies', () => {
  assertWorkerContains(
    /not physical sensor observations/i,
    'UCDP reported event ≠ physical sensor observation'
  );
  assertWorkerContains(
    /may be associated in space\/time but is not thereby proven to have the same cause/i,
    'UCDP co-location ≠ common cause'
  );
});

test('invariant: cross-source spatial/temporal association ≠ causation', () => {
  assertWorkerContains(/they are not causal evidence/i, 'association ≠ causation');
});

test('invariant: a three-source evidence chain still does not prove common cause/attribution', () => {
  assertWorkerContains(
    /still does not prove common cause, strike, damage, actor, intent or attribution/i,
    'three-source chain ≠ proof of cause'
  );
});

test('invariant: the deterministic corroboration score is not a threat/targeting rating', () => {
  assertWorkerContains(
    /it is not a target, threat, military-significance, intent, attribution, or future-activity ranking/i,
    'corroboration score ≠ threat rating'
  );
});

test('these invariants are also present as UI-facing copy in twinstone.html (defense in depth, not the tamper-resistant layer)', () => {
  assert.match(htmlSrc, /context does not automatically increase twinstone corroboration scores or establish cause/i);
  assert.match(
    htmlSrc,
    /not source observations and are never promoted to corroborating evidence/i,
    'notebook/analyst-authored material must be documented as never counting as corroborating evidence'
  );
});


test('TWINSTONE_RULES.md is active and preserves the repository-level assurance model', () => {
  assert.doesNotMatch(rulesSrc, /not yet supplied/i, 'TWINSTONE_RULES.md must not remain a placeholder');
  assert.match(rulesSrc, /Objective operations.*remain deterministic/is, 'rules must keep objective operations deterministic');
  assert.match(rulesSrc, /LLM.*must not silently replace or alter deterministic results/is, 'rules must keep the LLM subordinate to deterministic results');
  assert.match(rulesSrc, /Missing from the next poll does \*\*not\*\* mean/is, 'rules must preserve missing != disappeared');
  assert.match(rulesSrc, /current allowlist is `thermal`, `earthObservationChange`, and `reportedConflict`/i, 'rules must name the corroboration allowlist');
  assert.match(rulesSrc, /Twinstone is \*\*not running on Telicent CORE\*\*/i, 'rules must not overclaim CORE runtime status');
  assert.match(rulesSrc, /v1\.0\.0 is the first controlled Git baseline/i, 'rules must document the controlled-baseline reset');
});
