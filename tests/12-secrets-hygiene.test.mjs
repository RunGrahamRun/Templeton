// Category: "secrets never appear in browser code, logs or committed files"
//
// Twinstone's design already isolates credentials behind a single
// `secret(env, ...names)` helper in worker.js (Cloudflare Worker secret
// bindings, never literals). This test enforces that design stays intact:
//   1. No high-entropy / provider-shaped secret literal appears anywhere
//      in the tracked source tree (browser HTML, worker, README, core/).
//   2. /health and /diagnostics/connectivity never leak a raw secret
//      value to the browser — every secrets.* flag must be a boolean.
//   3. No .env/.dev.vars/wrangler secret file is tracked by git.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { repoRoot, withWorker, makeRequest, makeCtx, fullEnv } from './lib/harness.mjs';

const SCAN_FILES = [
  'worker.js',
  'twinstone.html',
  'twinstone_source_qualification_v2.html',
  'README.md',
  'core/README.md',
  'core/CORE_MIGRATION.md',
  'core/ies-mapping.json',
];

// Provider-shaped secret patterns. Kept intentionally specific (rather than
// a blanket "any 32+ char string") to avoid false positives on things like
// SHA-256 hashes, SRI integrity attributes, or UUIDs that legitimately
// appear in this codebase (e.g. the leaflet <script integrity="sha256-...">
// tag), while still catching real leaked credentials.
const SECRET_PATTERNS = [
  { name: 'Google API key', re: /AIza[0-9A-Za-z_-]{35}/ },
  { name: 'OpenAI-style secret key', re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'AWS access key ID', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'PEM private key header', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'hardcoded Bearer token literal', re: /Authorization['"]?\s*:\s*['"`]Bearer [A-Za-z0-9._-]{15,}['"`]/ },
];

test('no provider-shaped secret literal appears in any tracked source file', () => {
  const offenders = [];
  for (const file of SCAN_FILES) {
    const full = path.join(repoRoot, file);
    let text;
    try {
      text = readFileSync(full, 'utf8');
    } catch (_) {
      continue; // optional file not present in this checkout
    }
    for (const { name, re } of SECRET_PATTERNS) {
      const m = re.exec(text);
      if (m) {
        const line = text.slice(0, m.index).split('\n').length;
        offenders.push(`${file}:${line} looks like a ${name}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `Possible leaked secret(s) found:\n${offenders.join('\n')}`);
});

test('every secret() call site in worker.js reads from env, never a hardcoded fallback value', () => {
  const src = readFileSync(path.join(repoRoot, 'worker.js'), 'utf8');
  // secret(env, 'NAME_ONE', 'NAME_TWO', ...) — every argument after env must
  // be a quoted UPPER_SNAKE_CASE env-var name, never a literal-looking value.
  // (?<!function ) excludes the `function secret(env, ...names) {` definition
  // itself, which is a rest-parameter, not a call site.
  const re = /(?<!function )secret\(env,\s*([^)]*)\)/g;
  const offenders = [];
  let m;
  while ((m = re.exec(src))) {
    const args = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    for (const arg of args) {
      const isQuotedEnvName = /^['"][A-Z][A-Z0-9_]*['"]$/.test(arg);
      if (!isQuotedEnvName) {
        const line = src.slice(0, m.index).split('\n').length;
        offenders.push(`worker.js:${line} secret(env, ...) received a non env-var-name argument: ${arg}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('/health never returns raw secret values, only booleans, even when every secret is configured', async () => {
  await withWorker(async (worker) => {
    const env = fullEnv({ GFW_API_TOKEN: 'super-secret-gfw-token-value', FIRMS_MAP_KEY: 'super-secret-firms-key-value' });
    const res = await worker.fetch(makeRequest('/health'), env, makeCtx());
    const body = await res.json();
    for (const [name, value] of Object.entries(body.secrets)) {
      assert.equal(typeof value, 'boolean', `/health secrets.${name} must be a boolean, got ${typeof value}`);
    }
    const raw = JSON.stringify(body);
    assert.ok(!raw.includes('super-secret-gfw-token-value'), '/health response must never contain a raw secret value');
    assert.ok(!raw.includes('super-secret-firms-key-value'), '/health response must never contain a raw secret value');
  });
});

test('/diagnostics/connectivity never returns raw secret values, only credentialConfigured booleans', async () => {
  await withWorker(async (worker) => {
    const env = fullEnv({ GFW_API_TOKEN: 'super-secret-gfw-token-value' });
    const res = await worker.fetch(makeRequest('/diagnostics/connectivity'), env, makeCtx());
    const body = await res.json();
    const raw = JSON.stringify(body);
    assert.ok(!raw.includes('super-secret-gfw-token-value'), '/diagnostics/connectivity response must never contain a raw secret value');
  });
});

test('no secret/credential file is tracked by git', () => {
  let tracked;
  try {
    tracked = execFileSync('git', ['-C', repoRoot, 'ls-files'], { encoding: 'utf8' });
  } catch (_) {
    // Not inside a git repo yet (e.g. running the scaffold before `git init`
    // and the first commit) — nothing to check.
    return;
  }
  const files = tracked.split('\n').filter(Boolean);
  const forbidden = files.filter((f) =>
    /(^|\/)(\.env(\..*)?|\.dev\.vars(\..*)?|wrangler\.toml\.local|.*\.pem|.*\.key)$/i.test(f)
  );
  assert.deepEqual(forbidden, [], `Secret-shaped file(s) are tracked by git and must be removed + added to .gitignore:\n${forbidden.join('\n')}`);
});
