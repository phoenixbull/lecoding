# Golden Acceptance Evidence — 2026-08-27

The category-balanced acceptance suite selects 12 of the deterministic 20-task
catalog: three bug fixes, three features, two security tasks, two documentation
tasks, and two performance tasks. All three attempts used fresh Git fixtures and the
configured OpenAI Chat Completions-compatible model. Model commands and
independent verification ran inside `lecoding-sandbox:phase0` with network
disabled and the established Phase 0 resource/isolation limits.

## Results

| Task | Category | Attempt 1 | Attempt 2 | Attempt 3 (post-hardening) |
| --- | --- | --- | --- | --- |
| `ts-fix-boundary` | bugfix | protocol failure | passed | passed |
| `js-fix-async-race` | bugfix | passed | passed | passed |
| `python-fix-parser` | bugfix | passed | passed | passed |
| `ts-add-required-field` | feature | passed | passed | passed |
| `python-add-validation` | feature | passed | passed | passed |
| `ui-empty-state` | feature | passed | passed | passed |
| `security-path-traversal` | security | passed | passed | passed |
| `schema-unique-call-id` | security | passed | passed | passed |
| `docs-quickstart` | docs | passed | passed | passed |
| `docs-error-reference` | docs | passed | protocol failure | passed |
| `performance-deduplicate` | performance | passed | passed | passed |
| `performance-bounded-log` | performance | protocol failure | passed | passed |

Attempt 1 passed 10/12 (83.33%); attempt 2 passed 11/12 (91.67%). Across
both attempts, all 12 selected tasks passed at least once and 21/24 task
observations passed (87.5%). Combined observations used 164,005 input tokens,
20,082 output tokens, and 304.734 seconds. The `$0.028581` combined cost is a
list-price equivalent using the same explicit `$0.14/$0.28` per-million-token
snapshot as the earlier five-task baseline, not an account charge.

After the gateway added one pre-action replay for syntactically malformed HTTP
or tool JSON, attempt 3 passed 12/12 (100%) in 101.084 seconds. It used 86,125
input tokens and 9,689 output tokens; its `$0.014772` cost uses the same explicit
price snapshot and is not an account charge.

The retained structured reports are:

- [`golden-acceptance-2026-08-27.json`](golden-acceptance-2026-08-27.json)
- [`golden-acceptance-2026-08-27-attempt-2.json`](golden-acceptance-2026-08-27-attempt-2.json)
- [`golden-acceptance-2026-08-27-attempt-3.json`](golden-acceptance-2026-08-27-attempt-3.json)

## Reliability finding

No independent verification command failed. The three failed observations ended
before verification: two model responses supplied invalid JSON for
`execute_command` arguments, and one HTTP 200 response body was not valid JSON.
The affected task changed between attempts, so this is retained as compatible-
provider protocol reliability evidence rather than classified as a deterministic
task capability failure. Production remains fail closed; this report does not
weaken tool argument parsing or invent a repaired command.

The hardened gateway replays the identical provider request at most once and
only before a parsed turn can expose an action. A second malformed response
still fails closed, while valid JSON with an invalid command schema is rejected
without retry. Attempt 3 proves that hardened end-to-end path completed 12/12;
the retained report has no retry-count field, so it does not establish whether
that particular live run actually needed the replay.

## Reproduction

```bash
set -a; source .env.local; set +a
RUN_LIVE_GOLDEN=1 \
LECODING_GOLDEN_SUITE=acceptance \
LECODING_MODEL_INPUT_USD_PER_MILLION=0.14 \
LECODING_MODEL_OUTPUT_USD_PER_MILLION=0.28 \
LECODING_GOLDEN_REPORT=docs/evidence/golden-acceptance-2026-08-27.json \
pnpm exec vitest run packages/golden-evals/test/live-agent-model-baseline.test.ts
```

This remains Docker Desktop development evidence, not target-Linux isolation
evidence. Recheck the explicit pricing snapshot before cost comparisons.
