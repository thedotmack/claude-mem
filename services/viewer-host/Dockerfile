# Cloud viewer host: one image for the router and every account's viewer
# machine (src/index.ts, VIEWER_ROLE). Build from the repository root, so the
# built plugin/ is in the context. Today production runs fly.toml (one owner):
#   npm run build
#   fly deploy --config services/viewer-host/fly.toml --dockerfile services/viewer-host/Dockerfile .
# After the router cutover (see fly.router.toml), every release is:
#   1. npm run build
#   2. fly deploy --config services/viewer-host/fly.router.toml --dockerfile services/viewer-host/Dockerfile .
#   3. bun services/viewer-host/scripts/rollout-image.ts --worker-ready-timeout-seconds <N> --only <one cmem-vw- app>, check it
#   4. bun services/viewer-host/scripts/rollout-image.ts --worker-ready-timeout-seconds <N>
#      (N is required: the worker boot time measured in the Phase 8 staging run)
FROM oven/bun:1.4-debian

WORKDIR /app

# The worker's runtime dependencies, without the optional embedder (no search
# by meaning here) and without native grammar builds (no code is parsed here).
COPY plugin/package.json plugin/bun.lock ./plugin/
RUN cd plugin && bun install --production --frozen-lockfile --ignore-scripts --omit optional

COPY plugin ./plugin
COPY services/viewer-host/src ./viewer-host/src

# The tree-sitter CLI, put in place once here with the same verified provisioning code the
# worker runs at start (src/services/smart-file-read/tree-sitter-cli-provision.ts). The
# install above skips scripts, so without this every machine start found no CLI and
# downloaded it again: about 60 s of network and CPU on each wake (Phase 8 staging run).
# The worker's start check then finds it usable and downloads nothing. After COPY plugin, so
# nothing copied later can replace it. 300000 ms is the limit the worker itself gives the
# download (TREE_SITTER_CLI_INSTALL_TIMEOUT_MS). The build fails if no working CLI results.
RUN --mount=type=bind,source=src/services/smart-file-read,target=/opt/tree-sitter-provision \
    bun -e 'import { ensureTreeSitterCliBinary } from "/opt/tree-sitter-provision/tree-sitter-cli-provision.ts"; console.log("tree-sitter CLI:", await ensureTreeSitterCliBinary("/app/plugin", 300000));' \
 && /app/plugin/node_modules/tree-sitter-cli/tree-sitter --version

ENV PORT=8080
ENV CLAUDE_MEM_DATA_DIR=/data/claude-mem
ENV CLAUDE_MEM_WORKER_SCRIPT=/app/plugin/scripts/worker-service.cjs
# The worker this host runs is updated by redeploying the image, never in place.
ENV CLAUDE_MEM_AUTO_UPDATE=false
EXPOSE 8080

CMD ["bun", "run", "viewer-host/src/index.ts"]
