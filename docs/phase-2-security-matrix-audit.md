# Phase 2 Security Matrix Audit

Updated: 2026-08-28

| Threat | Enforced boundary | Evidence |
|---|---|---|
| Path traversal / symlink escape | Canonical registered worktree containment before Docker bind or Git reads | Docker and Git workspace tests reject outside-root and symlink targets |
| Command composition | Exact low-risk argv allowlist in `auto_review`; shell, Git config/ext-diff, injected test flags, and arbitrary network commands require review | Policy adversarial catalog has zero silent allows |
| Fixed-deny override | Credential/browser paths and container-runtime sockets are denied for reads and writes; host-control commands and private/metadata targets are denied before reviewer/project rules/mode | Policy matrix covers manual, auto-review, full access, and a malicious project allow rule |
| Approved-network exfiltration | Phase 2 server containers remain `--network none`; an untrusted runtime network override cannot change the plan | Docker plan test asserts the authoritative network argument remains `none` |
| Output bomb / secret leakage | Per-stream byte cap, bounded persisted prefix, pre-persistence redaction, content-addressed Artifact access control, seven-day retention | Artifact/redaction audit and focused storage/runtime tests |
| Container escape | Non-root UID, read-only root, all capabilities dropped, no-new-privileges, PID/CPU/memory/fd limits, private tmpfs, immutable images, no Docker socket mount | Exact Docker plan contract plus daemon-backed cases where the local daemon is available |
| Authorization writes / IDOR | Membership is rechecked for Run commands, result decisions, approvals, membership and project-policy mutation; full access is admin-only and host scopes are rejected | Worker API tests cover every Run surface and admin-only mutations |

The code-level matrix is closed. The target-Linux daemon execution evidence is
tracked separately as the explicitly parked Phase 0 environment exception and
does not weaken the enforced configuration contract in this phase.

Focused policy and Docker-plan verification passed 18 tests with the two
daemon-dependent cases skipped. The repository suite passed 330 tests inside
the workspace sandbox; the five loopback-bind cases then passed in the permitted
8/8 HTTP rerun. Workspace typecheck passed 12/12 tasks.
