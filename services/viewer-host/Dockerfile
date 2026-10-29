# Cloud viewer host. Build from the repository root, so the built plugin/ is in
# the context:
#   fly deploy --config services/viewer-host/fly.toml --dockerfile services/viewer-host/Dockerfile .
FROM oven/bun:1.4-debian

WORKDIR /app

# The worker's runtime dependencies, without the optional embedder (no search
# by meaning here) and without native grammar builds (no code is parsed here).
COPY plugin/package.json plugin/bun.lock ./plugin/
RUN cd plugin && bun install --production --frozen-lockfile --ignore-scripts --omit optional

COPY plugin ./plugin
COPY services/viewer-host/src ./viewer-host/src

ENV PORT=8080
ENV CLAUDE_MEM_DATA_DIR=/data/claude-mem
ENV CLAUDE_MEM_WORKER_SCRIPT=/app/plugin/scripts/worker-service.cjs
EXPOSE 8080

CMD ["bun", "run", "viewer-host/src/index.ts"]
