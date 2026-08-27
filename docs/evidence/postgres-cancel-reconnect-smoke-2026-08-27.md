# PostgreSQL Cancel Fanout and Reconnect Evidence — 2026-08-27

The real PostgreSQL service configured in the ignored root `.env.local` file was
exercised with two independent Worker database adapters:

```bash
pnpm smoke:postgres-cancel
```

## Result

The command exited successfully and established:

- two dedicated `LISTEN run_engine_cancel` sessions were active;
- a cancellation published through Worker A reached both Worker sessions;
- only Worker A's owned LISTEN connection was then deliberately ended;
- Worker B stayed online and published in the reverse direction;
- Worker A's cancel bus automatically created a new client, re-LISTENed, and
  received the new cancellation alongside Worker B;
- fanout therefore remained two recipients after reconnection.

The command emits only fixed counts and statuses. It does not print connection
settings or generated signal IDs, create a Run, write application tables, call a
model, or start Docker. Repeated publication during the short reconnect window
uses one generated smoke identity and recipient sets, so delivery evidence is not
inflated by retries.

## Claim boundary

This proves PostgreSQL LISTEN/NOTIFY fanout and client-session reconnection for the
currently configured service. It does not simulate a database-server outage or
network partition across hosts, and a different deployment must rerun the command
with its own injected environment.
