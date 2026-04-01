# Base: Node 20 + Bun (Anthropic's official devcontainer not publicly available)
# Per Eng decision #1, fall back to Node 20 base when official image unavailable
FROM node:20-bookworm

ARG MEMORY_TYPE=vanilla

# Install Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# Install git (needed for agent workspace)
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Conditional: install claude-mem only when MEMORY_TYPE=claude-mem
RUN if [ "$MEMORY_TYPE" = "claude-mem" ]; then \
      npx claude-mem install; \
    fi

# Working directory for agent projects
WORKDIR /workspace

# Copy entrypoint script
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Prompt file mounted at runtime: /workspace/prompt.md
# Results directory mounted at runtime: /workspace/results/

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
