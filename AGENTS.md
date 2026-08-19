# Project Development Instructions

## Code comments

- Add concise explanatory comments to all newly added or materially changed code.
- Use documentation comments on exported interfaces, types, and functions to describe their responsibility and important caller obligations.
- Explain state transitions, security checks, persistence guarantees, concurrency assumptions, protocol constraints, and other non-obvious decisions next to the relevant implementation.
- In tests, comment the scenario detail when its purpose is not clear from the test name.
- Comments must explain intent or constraints; do not restate obvious syntax line by line.

## Verification

- Develop behavior through the confirmed public seams using red-green TDD.
- Run the relevant focused test during each slice, then run `pnpm test` and `pnpm typecheck` before handoff.
