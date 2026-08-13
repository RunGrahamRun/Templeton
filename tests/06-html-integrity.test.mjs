// Category: "duplicate/missing HTML IDs and handlers"

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { repoRoot } from './lib/harness.mjs';

const HANDLER_ATTRS = ['onclick', 'onchange', 'oninput', 'onkeydown', 'onkeyup', 'onsubmit', 'onload', 'onerror'];

function loadDoc(file) {
  const html = readFileSync(path.join(repoRoot, file), 'utf8');
  return { html, doc: new JSDOM(html).window.document };
}

function extractInlineJs(html) {
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  let all = '';
  while ((m = re.exec(html))) all += m[1] + '\n';
  return all;
}

function findDuplicateIds(doc) {
  const ids = [...doc.querySelectorAll('[id]')].map((e) => e.id);
  const seen = new Set();
  const dupes = new Set();
  for (const id of ids) {
    if (seen.has(id)) dupes.add(id);
    seen.add(id);
  }
  return [...dupes];
}

function findMissingHandlerFunctions(doc, allJs) {
  const called = new Set();
  for (const attr of HANDLER_ATTRS) {
    for (const el of doc.querySelectorAll(`[${attr}]`)) {
      const code = el.getAttribute(attr) || '';
      const m = code.match(/^\s*([a-zA-Z_$][\w$]*)\s*\(/);
      if (m) called.add(m[1]);
    }
  }
  const missing = [];
  for (const fn of called) {
    const defined = new RegExp(
      `function\\s+${fn}\\s*\\(|(?:window\\.)?${fn}\\s*=\\s*(?:async\\s*)?function|(?:window\\.)?${fn}\\s*=\\s*\\(|(?:window\\.)?${fn}\\s*=\\s*async\\s*\\(`
    ).test(allJs);
    if (!defined) missing.push(fn);
  }
  return missing;
}

for (const file of ['twinstone.html', 'twinstone_source_qualification_v2.html']) {
  test(`${file}: no duplicate element ids`, () => {
    const { doc } = loadDoc(file);
    const dupes = findDuplicateIds(doc);
    assert.deepEqual(dupes, [], `duplicate id attribute(s) found in ${file}: ${dupes.join(', ')}`);
  });

  test(`${file}: every inline event-handler attribute calls a function that is actually defined`, () => {
    const { html, doc } = loadDoc(file);
    const allJs = extractInlineJs(html);
    const missing = findMissingHandlerFunctions(doc, allJs);
    assert.deepEqual(
      missing,
      [],
      `${file} has inline event-handler attribute(s) calling undefined function(s): ${missing.join(', ')} — these buttons/controls are dead in the UI`
    );
  });

  test(`${file}: every element referenced by an id= selector in inline JS actually exists in the document`, () => {
    const { html, doc } = loadDoc(file);
    const allJs = extractInlineJs(html);
    const ids = new Set([...doc.querySelectorAll('[id]')].map((e) => e.id));
    const referenced = new Set();
    const re = /(?:getElementById|document\.getElementById|[$]\()\(?['"`]([a-zA-Z_][\w-]*)['"`]\)/g;
    let m;
    while ((m = re.exec(allJs))) referenced.add(m[1]);
    const missing = [...referenced].filter((id) => !ids.has(id));
    assert.deepEqual(
      missing,
      [],
      `${file} JavaScript references element id(s) that don't exist in the DOM: ${missing.join(', ')}`
    );
  });
}
