
FROM node:20

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git \
      curl \
      ca-certificates \
      unzip \
      jq \
      less \
      procps \
      uuid-runtime \
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

RUN mkdir -p /usr/local/share/npm-global \
 && chown -R node:node /usr/local/share/npm-global
ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
ENV PATH="/usr/local/share/npm-global/bin:${PATH}"

ARG CLAUDE_CODE_VERSION=latest
USER node
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

USER root
COPY plugin/ /opt/claude-mem/
RUN chown -R node:node /opt/claude-mem

USER node
# onnxruntime-node's postinstall would add its CUDA provider (about 370 MB) on
# linux/x64. The embedder runs on the CPU, and this image has no CUDA runtime
# to load it with, so skip it, and drop the npm cache the install leaves.
RUN cd /opt/claude-mem \
 && ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install --omit=dev --legacy-peer-deps \
 && npm cache clean --force

# The embedding model search by meaning uses (LocalEmbedder), fetched into
# transformers.js's cache inside the image; otherwise every new container
# downloads it at its first embed, and one without network access searches by
# keyword only.
RUN cd /opt/claude-mem \
 && node -e "import('@huggingface/transformers').then(t => t.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'fp32' }))"

USER root
RUN mkdir -p /home/node/.claude /home/node/.claude-mem /data/claude-mem \
 && chown -R node:node /home/node/.claude /home/node/.claude-mem /data/claude-mem

COPY --chown=node:node docker/claude-mem/entrypoint.sh /usr/local/bin/claude-mem-entrypoint
RUN chmod +x /usr/local/bin/claude-mem-entrypoint

USER node
WORKDIR /home/node

# Phase 10 — server-beta runtime is the only foregrounded process. The legacy
# worker binaries remain available for tooling but are NEVER spawned by the
# entrypoint. Mode selection happens via CLAUDE_MEM_CONTAINER_MODE
# (server | worker | shell). `docker run ... bash` works because shell mode
# falls through to "$@".
ENV CLAUDE_MEM_CONTAINER_MODE=server
ENV CLAUDE_MEM_RUNTIME=server-beta

ENTRYPOINT ["/usr/local/bin/claude-mem-entrypoint"]
CMD []
