# claude-mem-local — the stable, containerized legacy worker.
#
# Runs the SAME runtime the host normally runs (`worker-service.cjs --daemon`,
# SQLite + local Chroma) but isolated in Docker, so `npm run build-and-sync`
# dev churn on the host can never take memory capture down. The host's hooks
# reach it via the published worker port with CLAUDE_MEM_EXTERNAL_WORKER=true
# in ~/.claude-mem/settings.json.
#
# Data lives in the `claude-mem-local-data` named volume mounted at
# /data/claude-mem — seed it from the host with docker/local/seed-data.sh.
# Manage the whole lifecycle with scripts/claude-mem-docker.sh.

FROM node:20

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git \
      curl \
      ca-certificates \
      unzip \
      procps \
      sqlite3 \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

ARG BUN_VERSION=1.3.12
ENV BUN_INSTALL="/usr/local/bun"
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
 && chmod -R a+rX /usr/local/bun
ENV PATH="/usr/local/bun/bin:${PATH}"

ARG UV_VERSION=0.11.7
ENV UV_INSTALL_DIR="/usr/local/bin"
RUN set -eux \
 && curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" | sh \
 && { chmod a+rX /usr/local/bin/uv /usr/local/bin/uvx 2>/dev/null || true; }

COPY plugin/ /opt/claude-mem/
RUN chown -R node:node /opt/claude-mem \
 && mkdir -p /data/claude-mem \
 && chown -R node:node /data/claude-mem

USER node
RUN cd /opt/claude-mem \
 && npm install --omit=dev --legacy-peer-deps

# Pre-warm uv's cache with the exact pinned chroma-mcp spawn the worker uses
# (ChromaMcpManager.buildLauncherPrefix), so first boot doesn't spend minutes
# downloading Python + chromadb before semantic search comes up.
RUN uvx --python 3.13 \
      --with 'onnxruntime>=1.20' \
      --with 'protobuf<7' \
      --from chroma-mcp==0.2.6 \
      chroma-mcp --help >/dev/null 2>&1 || true

WORKDIR /home/node

ENV CLAUDE_MEM_DATA_DIR=/data/claude-mem

# --daemon is the in-process server entrypoint (stays in the foreground);
# `start` would spawn a detached child and exit, which kills the container.
ENTRYPOINT ["bun", "/opt/claude-mem/scripts/worker-service.cjs", "--daemon"]
