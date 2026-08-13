# Claude instructions for Twinstone / Templeton

This repository contains the controlled Twinstone baseline and its assurance pipeline.

## Mandatory reading order

Before reviewing, editing, or proposing code changes, read these files in this order:

1. `AGENTS.md`
2. `TWINSTONE_RULES.md`
3. `CONTRACT.md`
4. The relevant tests under `tests/`

`TWINSTONE_RULES.md` is the repository-level source of truth for architectural and epistemic boundaries. `CONTRACT.md` translates those rules into concrete pipeline expectations. Do not weaken either file, or weaken a test, merely to make a change pass.

## Automatic PR-review role

When running from the automatic GitHub PR-review workflow:

- Review only. Do not edit files, commit, push, merge, or approve the PR.
- Run `npm ci` and `npm test` against the checked-out PR branch.
- Inspect the full PR diff against the base branch.
- Treat any deterministic test failure as **BLOCKING**.
- Treat a violation of `TWINSTONE_RULES.md` as **BLOCKING**, even if the current tests do not catch it.
- Identify missing tests for new or changed behavior.
- Do not infer that a provider/API behaves differently from the repository contract unless the PR contains evidence or documentation supporting that claim.

Classify findings as:

- **BLOCKING** — must be fixed before merge.
- **WARNING** — should be addressed or explicitly accepted in the PR.
- **INFO** — non-blocking observation or improvement.

Provide a concise top-level PR summary and use inline comments for specific code findings where possible.

## Core Twinstone assurance invariants

These are not optional style preferences. They are semantic boundaries:

- Observation != assessment.
- Derived estimate != direct observation.
- Reported/coded event != physical sensor observation.
- Context != corroborating evidence unless an explicit controlled rule changes that status.
- Cross-source spatial/temporal association != causation.
- More sources may increase evidence quality but do not prove common cause, attribution, intent, or actor.
- Missing/unavailable source != zero activity.
- Missing entity from a later poll != disappearance.
- Stale/last-known-good evidence != current evidence.
- Objective calculations, ranking inputs, distances, temporal classifications, change gates, associations, and corroboration scores remain deterministic.
- LLM output cannot alter deterministic scores or create corroborating source evidence.

Source-specific boundaries include:

- NASA FIRMS thermal anomaly != attack, strike, explosion, damage, actor, intent, or attribution.
- Sentinel / EO change != damage, cause, actor, strike, intent, or attribution.
- UCDP report != physical sensor proof; co-location with FIRMS/EO != common cause.
- GFW encounter != transshipment; apparent fishing != independently confirmed fishing; AIS gap != deliberate disabling or intent; GFW maritime activity != live vessel-position telemetry.
- SGP4 satellite position != direct position observation.

The complete and authoritative wording remains in `TWINSTONE_RULES.md`.

## Repository discipline

- `main` and release tags must remain green.
- Before merge, the full deterministic suite must pass.
- Version strings, README changelog, and the current-version Mermaid data-flow diagram move together.
- New feed adapters require source-appropriate freshness, provenance preservation, failure isolation, credential-safe behavior, and last-known-good/stale fallback where supported.
- Secrets remain server-side and never appear in browser code, logs, committed fixtures, or health/diagnostic responses.
- Telicent CORE / IES compatibility is a parallel engineering direction; do not claim the current demo runs on CORE.
