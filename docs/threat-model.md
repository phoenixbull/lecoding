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
| Full-access Run requests Docker socket | PolicyEngine returns fixed deny |
| Concurrent task modifies source checkout | Change exists only inside the Run worktree |
| Path contains `/var` versus `/private/var` alias | Repository identity uses filesystem `realpath` |
| Worktree patch uses `../` or an absolute path | Workspace rejects before write |
| Worker retries a side-effecting call | Durable `call_id` completion is reused; an unfinished claim stops for reconciliation instead of executing again |
| Browser disconnects | Run persists independently of SSE connection |
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

The Docker PoC must be rerun on the target Linux host before Phase 1. Docker Desktop on macOS is useful for development but is not production isolation evidence.
