# Sandbox PoC

The Dockerfile supplies a non-root process. The Worker must still enforce runtime controls; do not treat the image as a security boundary by itself.

Expected Phase 0 command once Docker is running:

```bash
docker build -f docker/sandbox.Dockerfile -t lecoding-sandbox:phase0 .
docker run --rm \
  --read-only \
  --user 10001:10001 \
  --network none \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --cpus 1 \
  --memory 512m \
  --pids-limit 128 \
  --ulimit nofile=1024:1024 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
  --mount type=bind,source=/srv/lecoding/runs/example,target=/workspace \
  --workdir /workspace \
  --env HOME=/tmp \
  lecoding-sandbox:phase0
```

`createDockerRunPlan` enforces this shape before the daemon is contacted. `prepare` resolves the registered root and workspace through filesystem `realpath`, then rejects lexical or symlink escapes. The live macOS Docker Desktop PoC verifies uid 10001, read-only rootfs, scoped workspace/tmpfs writes, and AbortSignal cancellation. Repeat the full matrix on the target Linux Worker host before Phase 1.

Before production, pin the base image by digest and run the same controls on the target Linux host.

## Offline verification image

`verification.Dockerfile` builds a project-specific image from the reviewed
workspace manifests and `pnpm-lock.yaml`. Build-time network access installs the
exact dependency graph and pnpm version; verification Runs remain `network=none`.

```bash
docker build -f docker/verification.Dockerfile -t lecoding-verification:reviewed .
```

The Worker mounts a Run worktree at `/workspace/project` and an anonymous volume
at `/workspace/project/node_modules`. Docker initializes that nested volume from
the image before checks start. `link-workspace-packages.mjs` also places relative
workspace-package links in the root dependency volume, so the bind-mounted source
resolves current `apps/*` and `packages/*` code without copying dependencies into
the worktree. Container disposal uses `docker rm -v`; the dependency volume cannot
survive or pollute the Run. Publish the image and configure its immutable digest as
`LECODING_VERIFICATION_IMAGE`.

## Target Linux evidence

Run the strict evidence command on the actual Linux Worker host from a clean
checkout. It refuses non-Linux hosts, Docker daemons whose OS type is not Linux,
failed commands, and Vitest runs containing any skipped case:

```bash
corepack enable
pnpm install --frozen-lockfile
node scripts/run-target-linux-isolation.mjs \
  docs/evidence/target-linux-isolation-YYYY-MM-DD.json
```

The command builds `lecoding-sandbox:phase0`, runs the complete
`docker-environment.test.ts` matrix against that image, and records the host
kernel, architecture, Docker Server/cgroup/security metadata, immutable image ID,
repository digests when available, and bounded test output. Review and commit the
generated report before marking the Phase 0 target-Linux requirement complete.
