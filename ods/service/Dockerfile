FROM node:22-bookworm-slim

ARG CLAUDE_MEM_VERSION=15.0.1
ARG BUN_VERSION=1.3.12

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# Install exact runtime versions at build time; startup never downloads a package.
RUN npm install --global bun@${BUN_VERSION} \
 && mkdir -p /opt/cmem /data \
 && npm install --prefix /opt/cmem --ignore-scripts --omit=dev claude-mem@${CLAUDE_MEM_VERSION} \
 && npm install --prefix /opt/cmem/node_modules/claude-mem/plugin --omit=dev \
 && chown -R node:node /opt/cmem /data

COPY gateway.mjs /opt/cmem/gateway.mjs

USER node
WORKDIR /opt/cmem/node_modules/claude-mem
ENV CLAUDE_MEM_DATA_DIR=/data
ENV CLAUDE_MEM_TELEMETRY=false
ENV DO_NOT_TRACK=1

CMD ["bun", "plugin/scripts/worker-service.cjs", "--daemon"]
