# Pin the reviewed multi-platform base so a rebuild cannot silently change its supply chain.
FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0

# Build-time network access materializes the reviewed lockfile; Run containers stay offline.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates git python3 tini \
    && rm -rf /var/lib/apt/lists/* \
    && corepack disable \
    && npm install --global pnpm@10.26.1 \
    && groupadd --gid 10001 agent \
    && useradd --uid 10001 --gid 10001 --create-home --shell /bin/bash agent

WORKDIR /workspace/project

# This image is project-specific: any dependency or workspace manifest change rebuilds it.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json vitest.config.ts ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts

# Hoisting keeps every runtime dependency in the root volume restored over the Run bind mount.
RUN pnpm install --frozen-lockfile --config.node-linker=hoisted \
    && node scripts/link-workspace-packages.mjs \
    && chown -R 10001:10001 /workspace

USER 10001:10001
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--version"]
