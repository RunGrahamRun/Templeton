# Instructions for AI coding agents (GPT, Claude, etc.) working in this repo

Read these two files before writing or editing any code here, in this order:

1. **`TWINSTONE_RULES.md`** — Twinstone's active architectural rules and epistemic
   boundaries. Treat it as the repository-level source of truth; do not weaken it just to make a test pass.
2. **`CONTRACT.md`** — the concrete, testable pipeline contract. Every rule
   in it is enforced by `npm test` (see `.github/workflows/pipeline-checks.yml`,
   which runs on every push and PR).

## Before you open a PR / before the operator pushes your commit

```
npm ci
npm test
```

Fix everything `npm test` reports before merge. A feature branch may be temporarily red while work is in progress, but `main` and release tags must remain green.

## What NOT to do

- Don't bump `VERSION` in one file without bumping it everywhere (`CONTRACT.md` §3).
- Don't add a new feed adapter without a last-known-good/stale-cache fallback (`CONTRACT.md` §7).
- Don't add a new context-only source without pinning `contributesToCorroborationScore: false` (`CONTRACT.md` §10).
- Don't reword or delete the semantic-boundary strings in the Gemini system prompt without updating the matching test (`CONTRACT.md` §11).
- Don't put a credential anywhere reachable from the browser, or as a literal fallback inside `secret(env, ...)` (`CONTRACT.md` §12).

## Where things live

| What | File |
|---|---|
| Cloudflare Worker (feed adapters, `/health`, `/diagnostics/*`, `/query`) | `worker.js` |
| Main browser app | `twinstone.html` |
| Diagnostics/source-qualification page | `twinstone_source_qualification_v2.html` |
| RDF ontology | `ontology.ttl` |
| SHACL contract, JSON schema, CORE/IES mapping | `core/` |
| Pipeline test suite | `tests/` |
| Pipeline contract (read this) | `CONTRACT.md` |
| Twinstone's own architectural rules (read this) | `TWINSTONE_RULES.md` |
