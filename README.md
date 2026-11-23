# Composio toolkit research

A 100-app integration research case study for the AI Product Ops take-home. View the [single-page case study](https://rohan-mohite14.github.io/composio-toolkit-research/) or open `index.html` locally. It includes all assignment rows, their source links, a searchable matrix, and the accuracy audit. The page embeds machine-readable results and offers a JSON download.

## Rebuild the published artifact

Requires Python 3.10 or later.

```sh
python3 compile-case-study.py
```

The build joins the fixed assignment manifest, frozen AI desk-research baseline, fresh page retrieval metadata, explicit source-review outcomes and five detailed pilot briefs. It validates complete ID coverage and recomputes the category counts and score from the data. Its inputs and output are checked in. A page retrieval establishes source availability. Audit records represent specific substantive checks.

## Run the research agent

Use Node.js 22.13+ and sign in to the Codex CLI with `codex login`. Set `CODEX_BIN` if needed. Optional Composio discovery uses the project's own SDK and an API key stored in your environment or an untracked `.env`.

```sh
npm install --no-save --no-package-lock @composio/core @modelcontextprotocol/sdk undici@6
node research.mjs check
node research.mjs run --mode composio --ids all --workers 2 --run full
node research.mjs report --run full --output runs/full
```

Reuse the same run name to resume SQLite checkpoints. Change `--ids all` to a comma-separated subset for a smoke test or `--mode codex` to use Codex without SDK discovery. The runner makes public-doc research requests, validates structured output, records a first pass, then runs a second pass that challenges identity, access and operation claims. It retries transient failures and includes stage-specific diagnostics in the report. Catalog matches are reuse leads. They do not establish vendor API entitlements.

For a fetched OpenAPI spec, run `python3 inventory-spec.py FILE --source URL` to count operations and export operation-level security. YAML requires PyYAML. For Google Discovery documents add `--resource projects.locations.notebooks` or the applicable exact subtree.

## Evidence and limits

- The published 100-app matrix reused the earlier AI research baseline and reopened vendor evidence in batches. In the November 24 live attempt, the authenticated Composio catalog lookup passed and the runner denied Codex CLI app server initialization. The fresh CLI run stopped at preflight with zero new briefs. See `data/live-run.json`.
- `data/audit.json` holds 20 decision-critical checks across ten apps, their first-pass and reviewed judgments, sources, and the reviewed edits. This measures corrections on the checked sample. Held-out accuracy and independent human sign-off are pending.
- `data/pilot-briefs.json` holds the earlier five expanded briefs with operation examples and claim-level evidence. The other apps use the assignment matrix level of detail.
- The assignment concerns documented feasibility. No vendor account was opened and no authenticated vendor operation was executed for the published matrix.
