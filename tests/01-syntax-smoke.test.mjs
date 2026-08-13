// Category: "JavaScript syntax and runtime smoke tests"
//
// Two layers:
//   1. Static syntax validity for worker.js and every inline <script> block
//      in the HTML files (via `node --check`, no execution).
//   2. A real runtime smoke test: import worker.js in Node and call its
//      fetch handler for a route that needs no upstream network access
//      (/health), proving the module loads and executes without throwing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { repoRoot, workerPath, withWorker, makeRequest, makeCtx, emptyEnv } from './lib/harness.mjs';

function checkSyntax(code, label) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tw-syntax-'));
  const file = path.join(dir, 'snippet.mjs');
  writeFileSync(file, code);
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    assert.fail(`${label} has a JavaScript syntax error:\n${error.stderr?.toString() || error.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function extractInlineScripts(html) {
  const scripts = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const body = m[1].trim();
    if (body) scripts.push(body);
  }
  return scripts;
}

test('worker.js has valid JavaScript syntax', () => {
  checkSyntax(readFileSync(workerPath, 'utf8'), 'worker.js');
});

test('twinstone.html inline <script> blocks parse without syntax errors', () => {
  const html = readFileSync(path.join(repoRoot, 'twinstone.html'), 'utf8');
  const scripts = extractInlineScripts(html);
  assert.ok(scripts.length > 0, 'expected at least one inline <script> block in twinstone.html');
  scripts.forEach((code, i) => checkSyntax(code, `twinstone.html inline script #${i + 1}`));
});

test('twinstone_source_qualification_v2.html inline <script> blocks parse without syntax errors', () => {
  const html = readFileSync(path.join(repoRoot, 'twinstone_source_qualification_v2.html'), 'utf8');
  const scripts = extractInlineScripts(html);
  assert.ok(scripts.length > 0, 'expected at least one inline <script> block in twinstone_source_qualification_v2.html');
  scripts.forEach((code, i) => checkSyntax(code, `twinstone_source_qualification_v2.html inline script #${i + 1}`));
});

test('runtime smoke: worker.js imports cleanly and /health responds without throwing', async () => {
  await withWorker(async (worker) => {
    const res = await worker.fetch(makeRequest('/health'), emptyEnv(), makeCtx());
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(typeof body.version, 'string');
  });
});

test('runtime smoke: unknown route returns the route index rather than throwing', async () => {
  await withWorker(async (worker) => {
    const res = await worker.fetch(makeRequest('/does-not-exist'), emptyEnv(), makeCtx());
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.routes) && body.routes.includes('/health'));
  });
});

test('runtime smoke: OPTIONS preflight never throws', async () => {
  await withWorker(async (worker) => {
    const res = await worker.fetch(makeRequest('/snapshot', { method: 'OPTIONS' }), emptyEnv(), makeCtx());
    assert.equal(res.status, 200);
  });
});
