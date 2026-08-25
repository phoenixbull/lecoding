# Golden Baseline Evidence — 2026-08-25

This Phase 0 observation used the configured OpenAI Chat Completions-compatible
provider and model `deepseek-v4-flash-0731`. Every model-issued command and every
independent verification command ran in the `lecoding-sandbox:phase0` Docker image
with network disabled, a read-only root filesystem, uid/gid 10001, dropped Linux
capabilities, and bounded CPU, memory, processes, files, and temporary storage.

## Result

| Task | Category | Outcome | Input tokens | Output tokens | Duration |
| --- | --- | --- | ---: | ---: | ---: |
| `ts-fix-boundary` | bugfix | passed | 13,625 | 1,739 | 19.979 s |
| `python-add-validation` | feature | passed | 4,976 | 789 | 9.599 s |
| `security-path-traversal` | security | passed | 18,473 | 4,452 | 36.237 s |
| `docs-quickstart` | docs | passed | 10,772 | 822 | 12.301 s |
| `performance-deduplicate` | performance | passed | 11,065 | 1,271 | 14.923 s |
| **Total** | five categories | **5/5 passed** | **58,911** | **9,073** | **93.039 s** |

The structured source report is
[`golden-baseline-2026-08-25.json`](./golden-baseline-2026-08-25.json).

## Cost interpretation

The report's `$0.010788` is a pay-as-you-go list-price equivalent, calculated from
the 2026-06-25 official DeepSeek-V4-Flash snapshot of `$0.14` per million input
tokens and `$0.28` per million output tokens. The configured endpoint uses a
personal Token Plan, so this estimate is not the actual subscription charge or
account deduction. Cached-input discounts were not claimed because the compatible
response did not provide independently billable cache-hit usage.

Pricing source: [Baidu AI Cloud Qianfan pricing](https://intl.cloud.baidu.com/en/doc/qianfan/s/Jm8r1826a-intl-en).

## Reproduction

Build the pinned local image tag, source the ignored provider configuration, and
run the opt-in live test with an explicit pricing snapshot:

```bash
docker build -f docker/sandbox.Dockerfile -t lecoding-sandbox:phase0 .
set -a; source .env.local; set +a
RUN_LIVE_GOLDEN=1 \
LECODING_MODEL_INPUT_USD_PER_MILLION=0.14 \
LECODING_MODEL_OUTPUT_USD_PER_MILLION=0.28 \
LECODING_GOLDEN_REPORT=docs/evidence/golden-baseline-2026-08-25.json \
pnpm vitest run packages/golden-evals/test/live-agent-model-baseline.test.ts
```

This is macOS Docker Desktop development evidence, not target-Linux isolation
evidence. The pricing snapshot must be reviewed before a later baseline overwrites
or compares cost figures.
