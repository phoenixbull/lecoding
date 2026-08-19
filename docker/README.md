# Sandbox PoC

The Dockerfile supplies a non-root process. The Worker must still enforce runtime controls; do not treat the image as a security boundary by itself.

Expected Phase 0 command once Docker is running:

```bash
docker build -f docker/sandbox.Dockerfile -t lecoding-sandbox:phase0 .
docker run --rm \
  --read-only \
  --network none \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --cpus 1 \
  --memory 512m \
  --pids-limit 128 \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  lecoding-sandbox:phase0
```

Before production, pin the base image by digest and run the same controls on the target Linux host.
