# Twinstone architectural rules and epistemic boundaries

**Status: active — source of truth for repository-level design and assurance rules.**

This file defines the standing constraints for Twinstone. `CONTRACT.md` translates these principles into testable pipeline checks. If code, tests, documentation and this file disagree, stop and reconcile them explicitly; do not silently weaken this file to make a test pass.

## 1. Purpose and assurance model

Twinstone is an OSINT fusion and assurance proof of concept. It combines independently sourced public information while preserving what each source actually says, where it came from, how fresh it is, and whether a value is observed, reported, derived or assessed.

Objective operations that can be computed deterministically — counts, ranking inputs, distances, temporal classification, spatial/temporal association, change-screening gates and corroboration scores — remain deterministic. The LLM may explain, summarize and assess the evidence package supplied to it, but it must not silently replace or alter deterministic results.

## 2. Runtime and trust boundaries

- The demonstration runtime is a static browser UI plus a Cloudflare Worker. Do not introduce a local server, Python runtime, Docker dependency or Telicent CORE dependency into the demo path without an explicit architectural decision.
- Secrets and provider credentials remain server-side in the Worker. Browser code receives only data and credential-state booleans, never raw secrets.
- Feed adapters are isolated. Failure, timeout or missing credentials in one source must not take down unrelated sources.
- The core operational snapshot, background enrichment and context plane remain separable. Slow non-critical context/enrichment must not make the application appear frozen or block a usable core picture.
- Browser-direct acquisition is used only for routes deliberately qualified for the demo environment; server-side fallback/caching remains explicit.

## 3. Evidence classes must stay distinct

Twinstone must not collapse these categories into one generic “fact”:

- **Source observation** — a record received from a physical/telemetry/data source with source semantics preserved.
- **Reported/coded event** — a source-authored or source-coded report such as UCDP; not a physical sensor observation.
- **Derived estimate** — a deterministic calculation from source data, such as SGP4 satellite position or an EO change region.
- **Cross-source association / evidence chain** — a deterministic relationship among evidence records; not causal proof.
- **Context** — information useful to interpretation but excluded from corroboration unless an explicit future rule promotes a defined use case.
- **Assessment / notebook material** — analyst or LLM-authored work product; never an independent source observation simply because it is stored beside evidence.

## 4. Provenance and identity are non-negotiable

- Every normalized observation retains source name, source record identifier, ingestion time and transport. Adapter-specific provenance such as method, source URL, source data product, source data version and source data epoch must survive every normalization/reduction step when present.
- Evidence passed to Gemini must retain the provenance needed to understand which provider/product/version generated it. Compression for prompt size must not erase evidential lineage.
- Stable knowledge identities are deterministic under `https://twinstone.local/id/`; runtime IDs may be retained separately for traceability.
- Persistent entities should survive refreshes and later source enrichment. A new observation does not create a new real-world entity merely because it arrived in a new poll.
- Source precision must be preserved. Do not invent time-of-day, location precision, confidence or attribution the source does not provide. In particular, date-only UCDP events remain date-granular.

## 5. Temporal resilience and absence

- Missing from the next poll does **not** mean an entity or event disappeared from the real world.
- A failed/unavailable feed does **not** mean zero activity.
- Credential-gated/remote adapters retain last-known-good data where designed, with explicit current/ageing/stale/fallback state.
- Stale data is last-known evidence only and must never be described as current.
- Freshness thresholds are source/domain-specific and must reflect the source cadence; activity-history feeds must not be given live-position semantics.
- No-data Sentinel imagery is not evidence of no change; invalid/insufficient common coverage must not produce a change observation.

## 6. Source-specific epistemic boundaries

These meanings must remain explicit in code, UI copy, ontology/SHACL where relevant, tests and LLM instructions:

- **NASA FIRMS:** a thermal anomaly/active-fire-like satellite detection does not establish an attack, strike, explosion, damage, actor, intent or attribution. Cause remains unknown unless independent evidence supports a stronger statement.
- **Sentinel / EO:** catalogue availability does not interpret pixels. A deterministic before/after change indicates sensor values changed after validity gates; it does not establish damage, cause, object identity, actor, strike, intent or attribution.
- **UCDP:** a reported/coded conflict event is not a physical sensor observation. Spatial/temporal co-location with FIRMS or EO evidence does not prove common cause.
- **Cross-source association:** proximity in space/time is association, not causation.
- **Three-source evidence chain:** additional independent evidence may strengthen an evidence-quality assessment but still does not prove common cause, damage, actor, intent or attribution.
- **Global Fishing Watch:** maritime activity is AIS-derived activity history, not live vessel-position telemetry. Apparent fishing is not independently confirmed fishing; an encounter does not by itself establish transshipment; loitering does not establish encounter/transshipment/intent; a port visit is AIS-derived rather than port-authority confirmation; an AIS gap does not establish deliberate disabling, cause or intent. Provider caveats and quality status must be retained.
- **Satellite position:** SGP4 output is a propagated estimate based on orbital elements and source epoch, not a direct position observation.

## 7. Corroboration and scoring

- Only explicitly approved evidentiary domains may contribute to deterministic corroboration. The current allowlist is `thermal`, `earthObservationChange`, and `reportedConflict`.
- Context feeds, weather, earthquakes, aircraft, vessel-position data, GFW maritime activity, satellites, notebook content and LLM output do not silently increase the corroboration score.
- Repeated observations from one evidence class do not become independent corroboration merely through volume.
- The deterministic score is an analyst-attention/evidence-quality aid. It is **not** a probability of truth, threat rating, target ranking, military-significance score, intent assessment, attribution or prediction of future activity.
- Changes to corroboration eligibility require code, tests, README, ontology/SHACL and this rules file to change together.

## 8. LLM boundary

- Gemini sees Twinstone as an evidence consumer, not a source of ground truth.
- Deterministic evidence selection/reduction should occur before the LLM where an objective operation exists.
- LLM prose must respect freshness, provenance, missing-source gaps and all source-specific interpretation boundaries.
- LLM output cannot create a new corroborating observation, change a deterministic score or convert context/assessment into source evidence.
- A model failure must degrade cleanly; it must not erase or invalidate the fused picture.

## 9. CORE / IES compatibility

- Twinstone is **not running on Telicent CORE** in the current demo. Do not claim otherwise.
- CORE readiness is a parallel engineering path, not a runtime dependency.
- Reuse IES4 classes only where the mapping is confirmed. Do not guess a superclass simply to make an export look more complete.
- Twinstone extensions remain explicit where a domain mapping is pending.
- Candidate CORE records remain blocked from publication until deployment policy supplies appropriate `Security-Label` and `policyInformation`; public-source origin does not define organisational access control.
- `https://twinstone.local/id/` is a PoC namespace and must be replaced by an organisation-controlled resolvable namespace before production publication without abandoning deterministic identity.

## 10. Analyst workflow and presentation

- Geography answers **where the analyst is looking**; workspace answers **what the analyst is doing**. Do not conflate profile/AOI selection with Operational, Investigation, Context or Notebook workspaces.
- Operational should remain map-first; Investigation evidence-first; Context separate from physical evidence; Notebook analyst-authored.
- Map symbology must preserve data-type distinctions and freshness independently. A GFW maritime-activity symbol must not masquerade as a live vessel-position marker.
- UI simplification must not hide source health, provenance, stale/fallback status or evidence gaps in a way that changes meaning.

## 11. Release and repository discipline

- Twinstone v1.0.0 is the first controlled Git baseline. Earlier version labels are preserved as **pre-Git development history**, not reconstructed as synthetic Git commits.
- `main` should represent a green controlled state. Before push/merge, run `npm ci` and `npm test`; new failures must be fixed or explicitly blocked from merge.
- Version strings across runtime artefacts and package metadata move together. README changelog and the current-version Mermaid data-flow diagram are updated in the same change.
- New feed adapters require credential-safe behaviour, provenance preservation, source-appropriate freshness, failure isolation and last-known-good/stale-cache handling where the source supports it.
- Tests should execute real Twinstone code paths with mocked upstreams wherever practical; do not create a parallel reimplementation that can pass while production code is broken.
- Do not weaken a semantic test merely to make a change pass. If an architectural rule intentionally changes, update this file first, explain the decision, then update code, tests, ontology/SHACL and documentation together.
