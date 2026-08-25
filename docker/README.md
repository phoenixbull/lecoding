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
