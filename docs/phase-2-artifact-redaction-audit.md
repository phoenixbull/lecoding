# Phase 2 Artifact and Redaction Audit

Updated: 2026-08-28

## Closed contract

- Docker stdout and stderr are captured incrementally with an 8 MiB hard limit
  per stream. The collector never retains more bytes than configured and removes
  an incomplete trailing UTF-8 code point.
- RunEngine redacts immediately after `perform` and before the tool-call ledger,
  Run snapshot, or next model turn. Each durable/model stream is at most 16 KiB.
- Oversized retained content is written to a private local Artifact directory by
  SHA-256. PostgreSQL stores metadata only: owning Run/project, kind, hash,
  storage key, byte size, and creation time.
- Exact retries reuse deterministic Artifact identity. Existing bytes and all
  reads are hash-verified; metadata changes fail closed.
- `RunView` contains only Artifact references. The versioned API requires viewer
  membership for the owning Run, confirms metadata Run/project equality, and
  returns one uniform 404 for missing or cross-Run identities. SDK and Web use
  that scoped route, and Web assigns content only through `textContent`.
- The production redactor removes configured API keys/tokens/secrets/passwords,
  the database URI/password, common bearer values, and provider-shaped `sk-`
  values. Known deployment credentials in original Run inputs, steering/answers,
  edited approvals, or model tool arguments are rejected before persistence.
- Cleanup runs at Worker startup and daily with the V3 seven-day cutoff. It
  deletes bytes before metadata and reports deletion/failure counts plus residual
  storage keys without content.

## Explicit bounds

The Artifact contains the complete redacted output retained by the Docker runtime,
up to 8 MiB per stream. Bytes beyond that runtime hard limit are deliberately
discarded and the stream remains marked truncated. This is the resource-exhaustion
boundary; it is not represented as lossless unlimited logging.

## Verification

- Artifact/redaction focused behavior: 11/11 tests passed across RunEngine,
  PostgreSQL/local storage, retention, Docker capture, Worker redaction, API, and SDK.
- Full repository result after adding credential-persistence coverage: 302 passed,
  one opt-in live-model skip, and two known daemon-backed Docker timeouts across
  65 files. HTTP integration passed 8/8 with loopback-listen permission; all six
  daemon-independent Docker contract tests, including byte capture, passed.
- `pnpm typecheck`: 12/12 workspace tasks passed.

The only isolation evidence still parked is the previously accepted target-Linux
Phase 0 run; it does not weaken the Artifact persistence or authorization claims
above.
