# PostgreSQL Worker Smoke Evidence — 2026-08-27

The production Worker composition root was exercised against the real PostgreSQL
service configured in the ignored root `.env.local` file. The reusable command
loads that file without printing its values:

```bash
pnpm smoke:postgres
```

## Result

The command exited successfully and reported:

- PostgreSQL Pool and dedicated LISTEN connection readiness;
- one trusted project registration;
- complete Worker startup and graceful shutdown;
- all seven Worker-owned durable tables, including
  `run_engine_steering_messages`;
- the pg-boss schema migration and both durable recovery queues,
  `lecoding-run-recovery` and `lecoding-run-recovery-scan`.

The smoke command creates no Run, performs no model request, and starts no Docker
container. Its output is limited to fixed schema/queue names and a project count;
it excludes the database URI, credentials, provider settings, and project IDs.

## Claim boundary

This closes the expanded-schema and pg-boss compatibility check for the currently
configured PostgreSQL service. It does not claim target-Linux Docker isolation or
prove the permissions and topology of a different production database; deployments
must rerun the same command with their secret-manager-provided environment.
