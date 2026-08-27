# Phase 0 Threat Model

## Assets

- Source repositories and generated patches
- User, device, model-provider, and future Git credentials
- Run events, approval decisions, artifacts, and verification evidence
- Worker host and Docker daemon

## Trust zones

1. Web/UI: untrusted user input and rendered model output.
2. Control plane: authentication, Run state, approvals, budgets, and audit.
3. Worker: the only server process allowed to request sandbox execution.
4. Sandbox/worktree: untrusted repository content and model-generated commands.
5. External providers: model APIs, package registries, and future integrations.

## Hard denies

Hard denies apply in every approval mode, including `full_access`:

- Docker socket access
- Host credentials, SSH private keys, browser profiles, and keychains
- Other users' or projects' workspaces
- New host mounts, privilege escalation, or container capability changes
- Loopback, private, link-local, and cloud metadata network targets
- Policy, audit, and budget modification by an Agent tool call

## Phase 0 abuse cases

| Case | Required evidence |
|---|---|
| Model claims completion without verification | Run remains non-successful unless Verifier passes |
| Model suggests weaker or replacement verification commands | Verifier executes only the administrator-reviewed required argv plan plus the non-removable host Diff Safety check; uncovered criteria remain inconclusive |
| Agent edits `.ai-agent/project.yaml` in its own or a sibling worktree | Worker loads and caches the reviewed baseline from a realpath outside the entire managed worktree root before accepting work |
| Verification infrastructure returns secret-bearing errors | VerificationReport records stable redacted failure categories and never copies command output or backend exceptions |
| Full-access Run requests Docker socket | PolicyEngine returns fixed deny |
| Concurrent task modifies source checkout | Change exists only inside the Run worktree |
| Path contains `/var` versus `/private/var` alias | Repository identity uses filesystem `realpath` |
| Two registry entries alias one mutable root or place trusted source below another project's worktree | Registry startup canonicalizes all paths and rejects duplicate source/config identities, overlapping worktree roots, and every source/worktree overlap before composing project runtimes |
| Worktree patch uses `../` or an absolute path | Workspace rejects before write |
| Worker retries a side-effecting call | The model-issued call is persisted before execution; its durable `call_id` completion is reused, while an unfinished claim stops for reconciliation instead of invoking the model or command again |
| Model provider returns malformed JSON or multiple/invalid function calls | Before exposing an action, the gateway replays the identical request at most once only for malformed HTTP/tool JSON; exhaustion and every semantic/schema violation fail closed before PolicyEngine or RunEnvironment |
| Provider retry logging leaks untrusted content or credentials | Worker logs an explicit fixed-field projection containing Run ID, protocol, retry count, stable category, and outcome; it never spreads or serializes provider/request fields |
| Model call requires continuation after Worker replacement | Provider response ID is persisted with the tool result and reused only with the matching `call_id` output |
| Model provider rejects a request with credential-bearing detail | Gateway records only the HTTP status and never copies the remote body or API key into Run failure text |
| Operator configures a plaintext remote model endpoint | Configuration rejects remote HTTP before attaching the bearer credential; only HTTPS or loopback HTTP is allowed |
| Remote client reaches the Run API without authentication | Non-loopback startup requires a 32+ character Bearer token and an explicit TLS-proxy assertion; every API, SSE, and command route authenticates before reading its body or invoking control seams |
| Browser or proxy leaks the control-plane token through URLs | The Web console keeps it in tab-scoped session storage and the SDK sends it only as an Authorization header; deployment guidance forbids credential-bearing proxy logs |
| Browser disconnects | Run persists independently of SSE connection |
| Browser approval is tampered into a broad grant | Control plane accepts only the current approval ID with `scope: once`; RunEngine validates it against durable pending state |
| A stale browser tab answers a newer model question | `answer` must carry the exact durable pending request ID; RunEngine rejects mismatches and consumes only the current `waiting_user` request |
| A model question contains markup or script text | Inspect exposes only the minimal question projection and the Web console assigns it with `textContent`, never HTML |
| Live steering races an in-flight command | Steering uses a separate ordered mailbox and is consumed only at a later model boundary; it never invalidates the Run lease or replays/interposes on the current side effect |
| Browser sends oversized steering content | API and RunEngine independently cap each answer or steering message at 4,000 characters before persistence |
| Client retries after losing a steer response | The SDK reuses a stable `commandId`; mailbox row, submitted event, and SSE outbox are one PostgreSQL statement, so the exact retry returns the original sequence without duplicating model input |
| Client reuses an idempotency key with altered content | The unique Run/command identity resolves to the original message and the adapter rejects any content mismatch |
| Worker crashes between mailbox staging and delivery receipt | Production `persistEvents` commits the Run cursor/pending steering snapshot, `user_message_delivered`, and its SSE outbox rows in one CAS transaction |
| Client retries a waiting-user answer after the Run advances | The Run snapshot retains the command receipt; exact answer/steer retries succeed after completion, while changed type, request ID, or content fails closed |
| Conversation event contains model/user markup | Event payloads pass the strict JSON envelope and Web renders titles from a closed local map plus details with `textContent`; replay never evaluates payload HTML |
| SSE reconnect redelivers conversation history | Web deduplicates by the stable per-Run event sequence and stops only on the terminal status event, preserving ordered full-history replay |
| Browser requests or commands an unregistered project's Run | Every history, inspect, changes, SSE, and command route verifies the administrator-owned project allowlist; history also returns only a bounded summary projection |
| Browser turns a Run ID into an arbitrary filesystem Diff | Change reader accepts identity-safe Run IDs only, derives the path below the managed root, verifies Git ownership, bounds output, and renders it as text |
| Verification container cannot access Git metadata | Git metadata remains host-owned; Diff Safety revalidates the managed worktree identity and checks tracked plus untracked changes through fixed argv |
| Terminal Run leaves a writable container alive | RunEngine removes runtime and verification containers plus anonymous dependency volumes while retaining only the managed evidence worktree |
| Local Runner disconnects | Run enters `environment_offline` and stops receiving actions |

## Docker PoC requirements

The sandbox image is not sufficient by itself. Runtime creation must enforce:

```text
non-root user
read-only root filesystem
cap-drop=ALL
no-new-privileges
network=none by default
bounded CPU, memory, PIDs, files, and wall-clock time
one writable worktree mount and bounded tmpfs
no Docker socket, SSH directory, or application environment mount
```

The Docker PoC must be rerun on the target Linux host before making a production isolation claim. Docker Desktop on macOS is useful for development but is not production isolation evidence; the owner accepted this as tracked debt while Phase 1 sequencing continues.
