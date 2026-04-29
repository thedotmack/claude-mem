
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

RUN mkdir -p /home/node/.claude /home/node/.claude-mem \
 && chown -R node:node /home/node/.claude /home/node/.claude-mem

USER node
WORKDIR /home/node

COPY --chown=node:node docker/claude-mem/entrypoint.sh /usr/local/bin/claude-mem-entrypoint
RUN chmod +x /usr/local/bin/claude-mem-entrypoint

ENTRYPOINT ["/usr/local/bin/claude-mem-entrypoint"]
CMD ["bash"]
