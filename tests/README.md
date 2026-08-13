# Pipeline test suite

Twelve files, one per pipeline-check category. The v1.0.0 controlled baseline defines 68 test cases in total (including the six dynamically generated HTML-integrity cases). Run everything with:

```
npm ci
npm test            # node scripts/run-tests.mjs
npm run test:verbose
```

No network access is used anywhere in this suite — every upstream feed call
is intercepted by the mock fetch router in `tests/lib/harness.mjs`. `worker.js`
is imported and executed for real (not re-implemented) via a minimal
in-memory Cloudflare Cache API shim; `twinstone.html`'s client-side logic
(temporal ageing, the corroboration-eligibility filter) is likewise extracted
from the real inline `<script>` source and executed in an isolated `vm`
context rather than re-implemented — see `tests/lib/extract-client-js.mjs`.

| File | Category |
|---|---|
| `01-syntax-smoke.test.mjs` | JavaScript syntax and runtime smoke tests |
| `02-worker-endpoints.test.mjs` | Mocked Worker endpoints and feed adapters |
| `03-version-consistency.test.mjs` | Version consistency across HTML, Worker and diagnostics |
| `04-readme-changelog-mermaid.test.mjs` | README changelog and current-version Mermaid present |
| `05-data-validity.test.mjs` | JSON, Turtle/RDF and SHACL validity |
| `06-html-integrity.test.mjs` | Duplicate/missing HTML IDs and handlers |
| `07-last-known-good.test.mjs` | Last-known-good behaviour when a feed fails |
| `08-temporal-ageing.test.mjs` | Temporal ageing/staleness behaviour |
| `09-provenance-survival.test.mjs` | Source provenance survives normalization |
| `10-context-corroboration-isolation.test.mjs` | Context sources don't accidentally contribute to corroboration |
| `11-semantic-invariants.test.mjs` | Semantic invariants (GFW encounter ≠ transshipment, FIRMS anomaly ≠ attack, Sentinel change ≠ damage, missing feed ≠ zero activity, etc.) |
| `12-secrets-hygiene.test.mjs` | Secrets never appear in browser code, logs or committed files |

The v1.0.0 controlled baseline is intended to pass every check. The suite was originally built against the pre-Git v1.10.3 code and exposed real defects; those defects are now baseline regression tests rather than accepted failures.
