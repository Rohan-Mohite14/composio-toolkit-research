# Composio toolkit research

A 100-app integration research case study for the AI Product Ops take-home. View the [single-page case study](https://rohan-mohite14.github.io/composio-toolkit-research/) or open `index.html` locally. It includes all assignment rows, their source links, a searchable matrix, and the accuracy audit. The page embeds machine-readable results and offers a JSON download.

## What the page shows

**Live page:** https://rohan-mohite14.github.io/composio-toolkit-research/

- **Findings:** 49 of 100 apps document a free live route, 34 have only a trial or sandbox, and 17 document neither. OAuth 2.0 is supported by 76 and API keys by 57. Paid access is the most common live gate (72 apps).
- **App matrix:** all 100 apps with a one-line description, auth, access, API surface and MCP, buildability, main blocker and source links. Search it or filter by category and access route.
- **Agent:** how the run worked, which models it used and where it failed. 98 apps passed two passes. Podio and Paygent Connect NMI show the first pass only.
- **Verification:** 40 held-out claims on ten apps. Fully correct claims went from 24/40 (60%) on the first pass to 31/40 (78%) on the second. Grading was done by an AI assistant, and independent human review is pending.

## Rebuild the published artifact

Requires Python 3.10 or later.

```sh
python3 compile-case-study.py
```

The build joins the manifest, the exported agent run (`data/agent-run.json`) and the held-out audit (`data/heldout-audit.json`), checks that all 100 IDs are covered, and recomputes every count and score. To refresh the export, run `python3 export-run.py PATH_TO_SQLITE RUN_NAME`.

## Run the research agent

Use Node.js 22.13+ and sign in to the Codex CLI with `codex login`. Set `CODEX_BIN` if needed. Optional Composio discovery uses the project's own SDK and an API key stored in your environment or an untracked `.env`.

```sh
npm install --no-save --no-package-lock @composio/core @modelcontextprotocol/sdk undici@6
node research.mjs check
node research.mjs run --mode composio --ids all --workers 4 --run full
node research.mjs report --run full --output runs/full
```

Reuse the same run name to resume SQLite checkpoints. Change `--ids all` to a comma-separated subset for a smoke test or `--mode codex` to use Codex without SDK discovery. The runner makes public-doc research requests, validates structured output, records a first pass, then runs a second pass that challenges identity, access and operation claims. It retries transient failures and includes stage-specific diagnostics in the report. Catalog matches are reuse leads. They do not establish vendor API entitlements.

For a fetched OpenAPI spec, run `python3 inventory-spec.py FILE --source URL` to count operations and export operation-level security. YAML requires PyYAML. For Google Discovery documents add `--resource projects.locations.notebooks` or the applicable exact subtree.

## Evidence and limits

- `data/agent-run.json` holds both passes for each app, with the model used and logged failures. Rows without a valid second pass show the first pass and are named on the page.
- `data/heldout-audit.json` holds 40 claim checks on ten apps outside the pilot and earlier audit, graded by an AI assistant against vendor pages. Independent human review is pending.
- `data/audit.json` and `data/pilot-briefs.json` come from earlier tuning. They are not accuracy estimates.
- Default model is `gpt-6-luna` at low effort. Override it with `CODEX_MODEL`. If the plan limit is hit, the runner waits 15 minutes and retries.
- No vendor account was opened and no authenticated vendor operation was executed.
