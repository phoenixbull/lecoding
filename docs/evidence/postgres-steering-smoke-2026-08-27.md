# PostgreSQL Steering Mailbox Evidence — 2026-08-27

The real PostgreSQL service configured in the ignored root `.env.local` file was
exercised through two independent Worker database adapters:

```bash
pnpm smoke:postgres-steering
```

## Result

The command exited successfully and established:

- Worker A inserted two steering messages for one UUID-scoped Run;
- their durable mailbox sequences preserved insertion order;
- retrying the first `commandId` returned its original sequence without inserting;
- Worker B resolved the command identity and read both messages in order;
- Worker B resumed after the first sequence and received only the second message;
- exactly two `user_message_submitted` events had matching transactional outbox rows;
- mailbox, event, outbox, and counter rows for the smoke Run were deleted and a
  post-cleanup query confirmed zero residue.

The command prints only fixed counts and statuses. Generated Run and command IDs,
messages, database settings, and credentials are not emitted. It performs no model
request, worktree operation, verification, or Docker action.

## Claim boundary

This proves ordered, idempotent steering persistence and replacement-Worker reads
against the currently configured PostgreSQL service. It does not prove delivery at
a live model-turn boundary; that remains covered by RunEngine and model-adapter
integration tests. A different deployment must rerun the command with its own
injected environment.
