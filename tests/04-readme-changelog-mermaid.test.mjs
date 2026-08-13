// Category: "README changelog and current-version Mermaid present"

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { repoRoot } from './lib/harness.mjs';

const README_PATH = path.join(repoRoot, 'README.md');

function readme() {
  return readFileSync(README_PATH, 'utf8');
}

test('README.md contains a changelog with a versioned entry for the current release', () => {
  const md = readme();
  assert.match(md, /^##\s+v[\d.]+/m, 'README.md must contain at least one "## vX.x" changelog section heading');
  assert.match(md, /^###\s+v[\d.]+/m, 'README.md must contain at least one "### vX.Y.Z" changelog entry heading');
});

test('README.md contains at least one fenced ```mermaid diagram', () => {
  const md = readme();
  const fence = md.match(/```mermaid\n([\s\S]*?)```/);
  assert.ok(fence, 'README.md must contain a ```mermaid fenced code block');
  assert.ok(fence[1].trim().length > 0, 'the mermaid fence must not be empty');
  assert.match(
    fence[1],
    /\b(flowchart|graph|sequenceDiagram|stateDiagram|classDiagram)\b/,
    'the mermaid block must open with a recognised diagram directive'
  );
});

test('the Mermaid diagram sits under a heading naming the current VERSION', () => {
  const worker = readFileSync(path.join(repoRoot, 'worker.js'), 'utf8');
  const version = worker.match(/const VERSION\s*=\s*'([^']+)'/)?.[1];
  assert.ok(version, 'could not read VERSION from worker.js');

  const md = readme();
  const fenceIndex = md.indexOf('```mermaid');
  assert.ok(fenceIndex >= 0, 'no mermaid fence found');
  const before = md.slice(0, fenceIndex);
  // Nearest heading line above the fence.
  const headings = [...before.matchAll(/^#{1,6}\s+.*$/gm)];
  assert.ok(headings.length > 0, 'no heading found above the mermaid fence');
  const nearestHeading = headings[headings.length - 1][0];
  assert.match(
    nearestHeading,
    new RegExp(`v${version.replace(/\./g, '\\.')}`),
    `the heading immediately preceding the data-flow diagram ("${nearestHeading}") should name the current version (v${version}) — update it when VERSION changes even though the mermaid syntax itself has no version string`
  );
});

test('README.md documents the evidence/semantic-boundaries and temporal/freshness sections', () => {
  const md = readme();
  assert.match(md, /^##\s+Evidence and semantic boundaries/mi);
  assert.match(md, /^##\s+Temporal\/freshness model/mi);
  assert.match(md, /^##\s+Corroboration scoring/mi);
});
