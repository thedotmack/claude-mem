# Basic claude-mem container for ad-hoc testing.
#
# Base layout mirrors anthropics/claude-code .devcontainer
# (https://github.com/anthropics/claude-code/blob/main/.devcontainer/Dockerfile):
#   FROM node:20, non-root `node` user, global npm install of @anthropic-ai/claude-code.
# We skip the firewall/zsh/fzf/delta/git-hist noise since this image is for
# exercising claude-mem, not as a full dev environment.
#
# On top of that base we install:
#   - Bun (claude-mem worker service runtime)
#   - uv  (provides Python for Chroma per CLAUDE.md)
#   - The locally-built plugin/ tree at /opt/claude-mem
#
# Usage:
#   docker build -f docker/claude-mem/Dockerfile -t claude-mem:basic .
#   docker run --rm -it \
#     -v $(mktemp -d):/home/node/.claude-mem \
#     -e CLAUDE_MEM_CREDENTIALS_FILE=/auth/.credentials.json \
#     -v /path/to/extracted/creds.json:/auth/.credentials.json:ro \
#     claude-mem:basic

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

# Bun — system-wide so the unprivileged `node` user can execute it.
# Pin via --build-arg BUN_VERSION=X.Y.Z; default is the version verified at PR time.
ARG BUN_VERSION=1.3.12
ENV BUN_INSTALL="/usr/local/bun"
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
 && chmod -R a+rX /usr/local/bun
ENV PATH="/usr/local/bun/bin:${PATH}"

# uv — system-wide, for Chroma's Python runtime. Pin via --build-arg UV_VERSION=X.Y.Z.
# Versioned installer URL per https://docs.astral.sh/uv/getting-started/installation/.
ARG UV_VERSION=0.11.7
ENV UV_INSTALL_DIR="/usr/local/bin"
# `&&` binds tighter than `||` in bash, so the previous form let `curl|sh` fail
# silently via the trailing `|| true`. Group the chmod so tolerated failure is
# scoped to perms-fixing only.
RUN set -eux \
 && curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" | sh \
 && { chmod a+rX /usr/local/bin/uv /usr/local/bin/uvx 2>/dev/null || true; }

# Match the upstream devcontainer's npm-global prefix so `npm install -g`
# targets a dir the `node` user owns.
RUN mkdir -p /usr/local/share/npm-global \
 && chown -R node:node /usr/local/share/npm-global
ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
ENV PATH="/usr/local/share/npm-global/bin:${PATH}"

# Claude Code CLI. Override at build-time with --build-arg CLAUDE_CODE_VERSION=X.Y.Z
# to pin; default tracks latest.
ARG CLAUDE_CODE_VERSION=latest
USER node
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

# Locally-built claude-mem plugin. COPY runs as root by default and layers are
# cached, so put this after the npm install so iterating on the plugin doesn't
# invalidate the CLI install layer.
USER root
COPY plugin/ /opt/claude-mem/
RUN chown -R node:node /opt/claude-mem

# Persistent mount points for ad-hoc testing — mount a host dir at either of
# these to inspect the claude-mem DB after a session.
RUN mkdir -p /home/node/.claude /home/node/.claude-mem \
 && chown -R node:node /home/node/.claude /home/node/.claude-mem

USER node
WORKDIR /home/node

# Helper: copies OAuth creds out of the read-only mount into $HOME/.claude/
# before exec'ing whatever you asked for. Saves the "cp + chmod" dance every
# time you drop in.
COPY --chown=node:node docker/claude-mem/entrypoint.sh /usr/local/bin/claude-mem-entrypoint
RUN chmod +x /usr/local/bin/claude-mem-entrypoint

ENTRYPOINT ["/usr/local/bin/claude-mem-entrypoint"]
CMD ["bash"]
