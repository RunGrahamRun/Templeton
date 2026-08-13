// Category: "version consistency across HTML, Worker and diagnostics"
//
// worker.js, twinstone.html and twinstone_source_qualification_v2.html each
// declare their own `const VERSION = '...'` literal — there is no shared
// import between them (they ship to three different runtime contexts: a
// Cloudflare Worker and two standalone static HTML files). This test is
// the thing that actually keeps them in sync.
//
// It also guards against the pre-Git regression class where User-Agent
// headers embedded stale version literals instead of interpolating `${VERSION}`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { repoRoot } from './lib/harness.mjs';

function readVersionConst(file, pattern) {
  const src = readFileSync(path.join(repoRoot, file), 'utf8');
  const m = src.match(pattern);
  assert.ok(m, `could not find a VERSION constant in ${file}`);
  return m[1];
}

const WORKER_VERSION = () => readVersionConst('worker.js', /const VERSION\s*=\s*'([^']+)'/);
const HTML_VERSION = (file) => readVersionConst(file, /const VERSION\s*=\s*'([^']+)'/);

test('worker.js, twinstone.html and twinstone_source_qualification_v2.html declare the same VERSION', () => {
  const worker = WORKER_VERSION();
  const html = HTML_VERSION('twinstone.html');
  const diag = HTML_VERSION('twinstone_source_qualification_v2.html');
  assert.equal(html, worker, `twinstone.html VERSION ('${html}') must match worker.js VERSION ('${worker}')`);
  assert.equal(diag, worker, `twinstone_source_qualification_v2.html VERSION ('${diag}') must match worker.js VERSION ('${worker}')`);
});

test('twinstone.html <title> and visible header badge match VERSION', () => {
  const worker = WORKER_VERSION();
  const html = readFileSync(path.join(repoRoot, 'twinstone.html'), 'utf8');
  assert.match(html, new RegExp(`<title>\\s*Twinstone v${escapeRe(worker)}\\s*</title>`), `<title> must contain v${worker}`);

  assert.match(
    html,
    new RegExp(`Twinstone\\s*<span class=\"muted\">v${escapeRe(worker)}</span>`),
    `visible Twinstone header badge must contain v${worker}`
  );
});

test('diagnostic visible version badge matches VERSION', () => {
  const worker = WORKER_VERSION();
  const html = readFileSync(path.join(repoRoot, 'twinstone_source_qualification_v2.html'), 'utf8');
  assert.match(
    html,
    new RegExp(`<div class=\"version\">v${escapeRe(worker)} diagnostic</div>`),
    `visible diagnostic version badge must contain v${worker}`
  );
});

test('core/ies-mapping.json twinstoneVersion matches VERSION', () => {
  const worker = WORKER_VERSION();
  const ies = JSON.parse(readFileSync(path.join(repoRoot, 'core/ies-mapping.json'), 'utf8'));
  assert.equal(ies.twinstoneVersion, worker);
});


test('package.json and package-lock.json root versions match VERSION', () => {
  const worker = WORKER_VERSION();
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'));
  assert.equal(pkg.version, worker, 'package.json version must match worker.js VERSION');
  assert.equal(lock.version, worker, 'package-lock.json top-level version must match worker.js VERSION');
  assert.equal(lock.packages?.['']?.version, worker, 'package-lock.json root package version must match worker.js VERSION');
});

test('README.md top changelog heading matches VERSION', () => {
  const worker = WORKER_VERSION();
  const readme = readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  // First-level document title, e.g. "# Twinstone v1.0.0 — ..."
  const titleMatch = readme.match(/^#\s+Twinstone v([0-9.]+)/m);
  assert.ok(titleMatch, 'README.md must start with "# Twinstone vX.Y.Z ..."');
  assert.equal(titleMatch[1], worker, 'README.md title version must match worker.js VERSION');
  // First versioned changelog subsection, e.g. "### v1.0.0 — ..."
  const changelogMatch = readme.match(/^###\s+v([0-9.]+)/m);
  assert.ok(changelogMatch, 'README.md must contain at least one "### vX.Y.Z" changelog entry');
  assert.equal(
    changelogMatch[1],
    worker,
    `the first changelog entry in README.md ('${changelogMatch[1]}') must document the current VERSION ('${worker}') — add a new entry before bumping VERSION`
  );
});

test('no worker.js User-Agent header hardcodes a version literal instead of interpolating VERSION', () => {
  const src = readFileSync(path.join(repoRoot, 'worker.js'), 'utf8');
  const offenders = [];
  const re = /User-Agent['"]?\s*:\s*(['"`])((?:(?!\1).)*Twinstone[^$][^'"`]*)\1/gi;
  let m;
  while ((m = re.exec(src))) {
    const literal = m[2];
    // A correctly-interpolated header looks like `Twinstone/${VERSION} ...`
    // and never reaches this branch because the template literal contains
    // ${VERSION}, which the ((?!\1).) negative lookahead still captures as
    // literal text before the closing backtick — so instead we specifically
    // flag any hardcoded "Twinstone/<digit>" pattern.
    if (/Twinstone\S*\d/.test(literal) && !literal.includes('${VERSION}')) {
      const line = src.slice(0, m.index).split('\n').length;
      offenders.push(`line ${line}: ${literal.trim()}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Found hardcoded version literals in User-Agent headers instead of \`Twinstone/\${VERSION}\`:\n${offenders.join('\n')}`
  );
});

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
