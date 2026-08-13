# Templeton / Twinstone pipeline contract

This file is the brief for **any agent (GPT or otherwise) writing code in this
repo**. It describes exactly what `npm test` checks on every commit and PR
(see `.github/workflows/pipeline-checks.yml`), so that generated code passes
instead of fighting the pipeline. If you are an AI coding agent working in
this repo, read this file and `TWINSTONE_RULES.md` before
making changes.

Twinstone v1.0.0 is the first controlled Git baseline. Pre-Git version labels remain documented history rather than reconstructed commits.

Run the full suite locally with:

```
npm ci
npm test            # node scripts/run-tests.mjs
npm run test:verbose
```

Each numbered section below is one pipeline check category, what file(s) it
covers, and the exact rule your code must not break.

## 1. JavaScript syntax and runtime smoke tests

- `worker.js` must always be syntactically valid ESM (`export default {
  async fetch(request, env, ctx) {...} }`) and must import cleanly in plain
  Node with nothing but a `caches.default` shim — do not introduce
  Workers-only globals (`WebSocketPair`, Durable Object bindings, etc.) at
  **module scope**; only reference them inside the specific route handler
  that needs them (e.g. `/ws/ais`).
- Every inline `<script>` block in `twinstone.html` and
  `twinstone_source_qualification_v2.html` must parse standalone
  (`node --check`). Don't leave a dangling brace or an unterminated
  template literal.

## 2. Mocked Worker endpoints and feed adapters

- Every route handler in `worker.js`'s `fetch()` switch must return a
  `Response` (via `jsonResponse(...)` or otherwise) and must never throw
  for a *missing credential* — check `secret(env, ...)` and return a
  `status: 'credential-required'` payload with an empty `observations`
  array, matching the existing GFW/FIRMS/UCDP pattern.
- If you add a new feed adapter, add a matching test in
  `tests/02-worker-endpoints.test.mjs` with a fixture under
  `tests/fixtures/`, following the existing GFW/FIRMS examples.

## 3. Version consistency across HTML, Worker and diagnostics

There is **one canonical version string per runtime context** — they are
not imported from each other, so you must bump all of them together:

- `worker.js` — `const VERSION = '...'`
- `twinstone.html` — `<title>Twinstone vX.Y.Z</title>`, visible header version badge **and**
  `const VERSION='...'`
- `twinstone_source_qualification_v2.html` — `const VERSION='...'` and visible diagnostic version badge
- `core/ies-mapping.json` — `"twinstoneVersion": "..."`
- `README.md` — the `# Twinstone vX.Y.Z — ...` title **and** a new
  `### vX.Y.Z — ...` changelog entry (see §4)
- `package.json` and the root package entry in `package-lock.json` — repository release version

Also: never hardcode a version number inside a `User-Agent` header string.
Always interpolate the constant: `` `Twinstone/${VERSION} <adapter>` ``.
This rule is green in the v1.0.0 controlled baseline; any future literal version drift is a regression.

## 4. README changelog and current-version Mermaid

- Every version bump needs a new `### vX.Y.Z — <short description>`
  changelog entry under the most recent `## vX.x — ...` section, added
  **before** you bump `VERSION` elsewhere.
- Keep the `## vX.Y.Z data flow` Mermaid `flowchart` diagram
  (```` ```mermaid ```` fence) up to date when you add/remove/rewire a feed.
  The diagram content itself doesn't need to embed the version number, but
  the heading immediately above the fence must name the current version.

## 5. JSON, Turtle/RDF and SHACL validity

- `core/core-record-envelope.schema.json` must remain a valid JSON Schema
  (2020-12 dialect) that `ajv` can compile.
- `ontology.ttl`, `core/ontology-styles.ttl`, `core/sample-knowledge.ttl`,
  `core/twinstone-shapes.ttl` must all parse as valid Turtle.
- `core/sample-knowledge.ttl` must **conform** to
  `core/twinstone-shapes.ttl` (run `npm test` — the SHACL check will show
  exactly which triples fail which constraint).
- If you add a new observation type, give it a SHACL shape in
  `core/twinstone-shapes.ttl` with at minimum: `identityKey`,
  `identityScheme` (= `"deterministic-v1"`), `observedAt` (`xsd:dateTime`),
  `observedEntity` (IRI), `sourceName`, `sourceRecordId`.
- If you add a new **context-only** (non-corroborating) source, its shape
  must require `tw:contributesToCorroborationScore` with `sh:hasValue
  false` — see §10.

## 6. Duplicate/missing HTML IDs and handlers

- Every `id="..."` in `twinstone.html` and
  `twinstone_source_qualification_v2.html` must be unique.
- Every inline `onclick=`/`onchange=`/`oninput=` handler must call a
  function that's actually defined somewhere in that file's inline
  `<script>`. Don't leave a wired-up button pointing at a renamed/removed
  function.
- Every `document.getElementById('...')` / `$('...')` lookup must
  reference an id that exists in that same file's DOM.

## 7. Last-known-good behaviour when a feed fails

Every credential-gated adapter follows this exact pattern — copy it for
new adapters:

1. Compute a `freshKey`/`staleKey` cache `Request` under
   `/__twinstone_cache/<feed>-v<N>/...`.
2. On cache hit for `freshKey`, return immediately (`cacheState:
   'fresh-cache'`).
3. On upstream success, write the payload to **both** `freshKey` (short
   TTL) and `staleKey` (long TTL) via `putJsonCache`, then return
   `status: 'live'`.
4. On upstream failure, check `staleKey`. If present, return the stale
   payload with `status: 'fallback'`, `cacheState: 'stale-cache'`,
   `upstreamStatus: 'degraded'` — **never an empty/thrown result when a
   last-known-good snapshot exists.**
5. Only if there's no stale snapshot either, return `status: 'degraded'`
   with empty `observations` — still a 200, never an unhandled throw.

## 8. Temporal ageing/staleness behaviour

- Any new observation domain needs an entry in `TEMPORAL_PROFILES`
  (`twinstone.html`) with `currentMaxSec < ageingMaxSec <= expireMaxSec`.
  Pick thresholds that match the feed's real update cadence — GFW
  maritime activity is an *activity-history* source (weeks), not a live
  position feed (minutes); don't collapse a slow-moving feed onto the
  `default`/`aircraft` window.
- `temporalInfo()` classification (`current`/`ageing`/`stale`/`expired`)
  must keep working for every domain — expired records get pruned by
  `pruneExpired()`, everything else stays visible but marked.
- The Gemini system prompt must keep stating that stale observations are
  "last-known evidence only" and must not be described as current.

## 9. Source provenance survives normalization

- `makeObservation()` always sets `provenance.source`,
  `provenance.sourceRecordId`, `provenance.ingestedAt`,
  `provenance.transport`. If an adapter adds more fields onto
  `.provenance` (e.g. `.method`, `.sourceUrl`, `.sourceDataProduct`,
  `.sourceDataVersion`), **`compactObservation()` must whitelist them
  too**, or they silently vanish before reaching the Gemini prompt. The
  pipeline (`tests/09-provenance-survival.test.mjs`) currently catches two
  real instances of this — `sourceDataProduct` (FIRMS) and
  `sourceDataVersion` (UCDP) are dropped. Fix by adding both fields to the
  `provenance: {...}` object inside `compactObservation()`.

## 10. Context sources don't accidentally contribute to corroboration

- Every context-only feed (`contextStatus(...)` results — IODA, NOAA
  SWPC, ReliefWeb, WHO) must keep `contributesToCorroborationScore: false`.
- The client-side corroboration-eligibility filter in
  `recomputeCorroborationWatchlist()` (`twinstone.html`) must stay limited
  to exactly `['thermal', 'earthObservationChange', 'reportedConflict']`.
  If you deliberately add a new evidentiary domain here, update it in the
  same commit as: the SHACL shape constraints, the corroboration section
  of `README.md`, and `tests/10-context-corroboration-isolation.test.mjs`'s
  `EVIDENTIARY_CORROBORATING_DOMAINS` list.

## 11. Semantic invariants

Never remove or water down the boundary language in worker.js's Gemini
`systemInstruction` array (inside `handleGeminiQuery`) or the per-adapter
`interpretation`/boundary strings. At minimum these must keep holding:

- GFW encounter ≠ transshipment (a vessel encounter alone doesn't prove
  transshipment, intent, or wrongdoing)
- FIRMS thermal anomaly ≠ attack/strike/damage
- Sentinel/EO change ≠ damage or cause (a detected pixel change is not
  evidence of a strike, actor, or intent)
- Missing feed / historical coverage ≠ zero real-world activity
- UCDP reported event ≠ physical sensor proof; co-location with a FIRMS/EO
  record is not proof of common cause
- Cross-source spatial/temporal association ≠ causation
- The deterministic corroboration score ≠ a threat/targeting rating

`tests/11-semantic-invariants.test.mjs` checks each of these by name. If
you rephrase one of these sentences, update the corresponding regex in
that test in the same commit — don't just delete the test.

## 12. Secrets never appear in browser code, logs or committed files

- All credentials are read via `secret(env, 'ENV_VAR_NAME', ...)` —
  **never** a literal fallback value, and never anything reachable from
  `twinstone.html` / `twinstone_source_qualification_v2.html`.
- `/health` and `/diagnostics/connectivity` may only report **booleans**
  (`configured`/`credentialConfigured`) for credential state — never the
  raw secret value.
- Never commit `.env`, `.dev.vars`, or a filled-in `wrangler.toml` with
  real secrets. Configure Worker secrets via `wrangler secret put
  <NAME>` or the Cloudflare dashboard, not in tracked files. See the
  "Common current Worker secrets/variables" list in `README.md` for the
  full set of expected secret names (`GEMINI_API_KEY`, `GFW_API_TOKEN`,
  `FIRMS_MAP_KEY`, `UCDP_ACCESS_TOKEN`, `RELIEFWEB_APPNAME`,
  `COPERNICUS_CLIENT_ID`/`COPERNICUS_CLIENT_SECRET`, etc.).

## Controlled baseline status

The v1.0.0 baseline is intended to be green before it becomes the initial Git tag. The pre-Git defects first exposed by this pipeline were fixed as part of baseline establishment:

1. User-Agent version literals now interpolate `${VERSION}`.
2. `compactObservation()` preserves FIRMS `provenance.sourceDataProduct` and UCDP `provenance.sourceDataVersion` into the Gemini evidence package.

A known failing check is no longer an acceptable steady state on `main`. If a migration genuinely requires a temporarily failing branch, document it in the PR and restore green before merge.
