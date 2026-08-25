FROM node:20-bookworm-slim

# Golden fixtures cover both Node and Python without run-time dependency downloads.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates git python3 tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 agent \
    && useradd --uid 10001 --gid 10001 --create-home --shell /bin/bash agent

WORKDIR /workspace
USER 10001:10001

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--version"]
