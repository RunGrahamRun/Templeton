<!--
NOTE: Automated Claude assurance review is not currently enabled.

The GitHub Actions integration was evaluated in August 2026 but removed because the available Claude Code automation path wasn't suitable for a zero-cost automated workflow.

This document is retained for future use if a suitable no-cost or locally hosted review mechanism becomes available. CLAUDE.md remains the repository-level assurance guidance.
-->
# Claude automation setup for Templeton

## What this adds

- `.github/workflows/claude-review.yml` — automatic Claude review on every non-draft PR open/update/reopen/ready-for-review event.
- `CLAUDE.md` — persistent repository instructions for Claude.
- The canonical architectural/epistemic source remains `TWINSTONE_RULES.md`.

## Authentication

The workflow as supplied expects a GitHub Actions repository secret named:

`ANTHROPIC_API_KEY`

Add it in GitHub repository **Settings -> Secrets and variables -> Actions -> New repository secret**.

For Anthropic's supported alternatives, the Claude Code Action also supports `CLAUDE_CODE_OAUTH_TOKEN` and workload-identity/cloud-provider authentication. If you choose OAuth instead of an API key, change the workflow input from:

`anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}`

to:

`claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}`

and create that secret instead.

## GitHub app

Install/authorize the official Claude GitHub App for the Templeton repository. Anthropic's current quickstart is to run Claude Code and use `/install-github-app`; manual setup is also supported.

## Suggested first PR

Use the first automated review to reconcile documentation drift that remains after baseline establishment:

- `CONTRACT.md` still says `TWINSTONE_RULES.md` exists "once it exists".
- Its local test command comment still mentions the superseded Unix glob runner instead of `node scripts/run-tests.mjs`.
- Its provenance section still describes the FIRMS/UCDP provenance loss as a current failing condition, although v1.0.0 fixed it.

Make those documentation/contract corrections on a feature branch, keep semantic behavior unchanged, run all tests, and open a PR. Claude should then review the PR automatically.
