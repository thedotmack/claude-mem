FROM ubuntu:24.04
ARG NODE_VERSION=20

ENV DEBIAN_FRONTEND=noninteractive
ENV TERM=xterm-256color
ENV COLORTERM=truecolor

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    bash \
    git \
    build-essential \
    python3 \
    unzip \
    jq \
    sudo \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN node -v && npm -v

WORKDIR /workspace

RUN cat > /root/.bashrc <<'EOF'
export PS1='\[\033[1;36m\]cmem-test\[\033[0m\]:\[\033[1;33m\]\w\[\033[0m\]\$ '

cat <<'BANNER'
=====================================================================
  claude-mem installer test sandbox (clean Linux, no Bun, no uv)
=====================================================================

  Try the new installer interactively:

      node dist/npx-cli/index.js install --no-auto-start

  Or just the runtime setup module via repair:

      node dist/npx-cli/index.js repair

  After install, verify the Setup hook is fast:

      time node ~/.claude/plugins/cache/thedotmack/claude-mem/$(jq -r .version package.json)/scripts/version-check.js

  Container HOME=/root is isolated — nothing here touches your real
  ~/.claude or ~/.claude-mem. Exit with Ctrl-D.

=====================================================================
BANNER
EOF

# bash --login reads ~/.bash_profile (or ~/.profile), not ~/.bashrc, so
# without this the banner above never runs in the container's CMD shell.
RUN printf '%s\n' '[[ -f ~/.bashrc ]] && . ~/.bashrc' > /root/.bash_profile

CMD ["bash", "--login"]
