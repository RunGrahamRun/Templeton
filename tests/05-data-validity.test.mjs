// Category: "JSON, Turtle/RDF and SHACL validity"

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import rdf from '@zazuko/env-node';
import SHACLValidator from 'rdf-validate-shacl';
import { repoRoot } from './lib/harness.mjs';

/** @zazuko/env-node only parses from a file/stream, not a raw string — write to a temp file first. */
async function datasetFromTurtleString(ttl) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tw-ttl-'));
  const file = path.join(dir, 'snippet.ttl');
  writeFileSync(file, ttl);
  try {
    return await rdf.dataset().import(rdf.fromFile(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function abs(p) {
  return path.join(repoRoot, p);
}

test('core-record-envelope.schema.json is itself a valid JSON Schema (2020-12) and accepts a conforming envelope', () => {
  const currentVersion = readFileSync(abs('worker.js'), 'utf8').match(/const VERSION\s*=\s*'([^']+)'/)?.[1];
  assert.ok(currentVersion, 'could not read current VERSION from worker.js');
  const schema = JSON.parse(readFileSync(abs('core/core-record-envelope.schema.json'), 'utf8'));
  const ajv = new Ajv2020({ strict: false });
  const validate = ajv.compile(schema); // throws if the schema itself is malformed

  const sample = {
    targetTopic: 'knowledge',
    readyForPublish: true,
    headers: {
      'Request-Id': 'x', 'Exec-Path': 'x', 'Content-Type': 'x',
      'Data-Source': 'x', 'Data-Producer': 'x', 'Security-Label': 'x', policyInformation: 'x',
    },
    key: 'k',
    data: 'd',
    metadata: {
      twinstoneVersion: currentVersion, profile: 'p', observationCount: 0, generatedAt: 'now',
      coreCompatibilityPhase: 'p', identityPolicy: 'p', shaclContract: 'p',
    },
  };
  const ok = validate(sample);
  assert.ok(ok, `a minimal conforming CORE envelope should validate: ${JSON.stringify(validate.errors)}`);

  const missingHeaders = { ...sample, headers: {} };
  assert.equal(validate(missingHeaders), false, 'an envelope missing required headers must fail validation');
});

test('every .ttl file in the repo parses as valid Turtle/RDF', async () => {
  const ttlFiles = ['ontology.ttl', 'core/ontology-styles.ttl', 'core/sample-knowledge.ttl', 'core/twinstone-shapes.ttl'];
  for (const file of ttlFiles) {
    const ds = await rdf.dataset().import(rdf.fromFile(abs(file)));
    assert.ok(ds.size > 0, `${file} parsed to zero triples — likely empty or malformed`);
  }
});

test('core/sample-knowledge.ttl conforms to the core/twinstone-shapes.ttl SHACL contract', async () => {
  const shapes = await rdf.dataset().import(rdf.fromFile(abs('core/twinstone-shapes.ttl')));
  const data = await rdf.dataset().import(rdf.fromFile(abs('core/sample-knowledge.ttl')));
  const validator = new SHACLValidator(shapes, { factory: rdf });
  const report = await validator.validate(data);
  if (!report.conforms) {
    const details = report.results
      .map((r) => `  - ${r.message.map((m) => m.value).join('; ') || '(no message)'} | focusNode=${r.focusNode?.value} | path=${r.path?.value}`)
      .join('\n');
    assert.fail(`sample-knowledge.ttl violates the SHACL shapes contract:\n${details}`);
  }
});

test('the SHACL contract actually rejects data that violates it (the validator is not a no-op)', async () => {
  const shapes = await rdf.dataset().import(rdf.fromFile(abs('core/twinstone-shapes.ttl')));
  // A ThermalAnomalyObservation missing every required property (identityKey,
  // identityScheme, observedAt, observedEntity, sourceName, sourceRecordId)
  // must be rejected — this guards against a shapes file that looks valid
  // Turtle but has silently lost its constraints (e.g. an empty targetClass).
  const bad = await datasetFromTurtleString(
    '@prefix tw: <https://twinstone.local/ontology#> .\ntw:bad-example a tw:ThermalAnomalyObservation .\n'
  );
  const validator = new SHACLValidator(shapes, { factory: rdf });
  const report = await validator.validate(bad);
  assert.equal(report.conforms, false, 'an observation missing all required SHACL properties should NOT conform');
});

test('core/twinstone-shapes.ttl requires InvestigationContext records to have contributesToCorroborationScore = false', async () => {
  const shapesTtl = readFileSync(abs('core/twinstone-shapes.ttl'), 'utf8');
  assert.match(
    shapesTtl,
    /InvestigationContext[\s\S]{0,400}?contributesToCorroborationScore[\s\S]{0,60}?sh:hasValue\s+false/,
    'expected a SHACL constraint pinning contributesToCorroborationScore to false for context record shapes'
  );
});
