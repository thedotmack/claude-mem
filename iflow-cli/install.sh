#!/bin/bash
#
# Claude-Mem iFlow CLI Installation Script
# Integrates claude-mem into iFlow CLI
#

set -e

# Color definitions
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default configuration
IFLOW_CONFIG_DIR="${HOME}/.iflow"
CLAUDE_MEM_ROOT="${HOME}/.claude-mem"
WORKER_PORT="${CLAUDE_MEM_WORKER_PORT:-37777}"

echo -e "${BLUE}╔════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   Claude-Mem for iFlow CLI Installer      ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════╝${NC}"
echo ""

# Check dependencies
check_dependencies() {
    echo -e "${YELLOW}Checking dependencies...${NC}"

    if ! command -v node &> /dev/null; then
        echo -e "${RED}Error: Node.js is not installed${NC}"
        echo "Please install Node.js 18+ from https://nodejs.org"
        exit 1
    fi
    echo -e "${GREEN}✓ Node.js: $(node --version)${NC}"

    # Bun is REQUIRED - hooks use bun-runner which requires Bun to be installed
    if command -v bun &> /dev/null; then
        echo -e "${GREEN}✓ Bun: $(bun --version)${NC}"
    else
        # Check common Bun installation paths (bun-runner.js does this too)
        local BUN_PATHS=(
            "${HOME}/.bun/bin/bun"
            "/usr/local/bin/bun"
            "/opt/homebrew/bin/bun"
        )
        local BUN_FOUND=false
        for path in "${BUN_PATHS[@]}"; do
            if [ -x "$path" ]; then
                echo -e "${GREEN}✓ Bun: $($path --version) (at $path)${NC}"
                BUN_FOUND=true
                break
            fi
        done

        if [ "$BUN_FOUND" = false ]; then
            echo -e "${RED}Error: Bun is not installed${NC}"
            echo ""
            echo "Bun is REQUIRED for claude-mem hooks to function."
            echo "All hook commands use bun-runner which requires Bun runtime."
            echo ""
            echo "Install Bun:"
            echo "  curl -fsSL https://bun.sh/install | bash"
            echo "  # Then restart your shell or run: source ~/.bashrc"
            exit 1
        fi
    fi
}

# Check/clone claude-mem
setup_claude_mem() {
    echo ""
    echo -e "${YELLOW}Setting up claude-mem...${NC}"

    if [ -d "${CLAUDE_MEM_ROOT}" ]; then
        echo -e "${GREEN}✓ claude-mem already exists at ${CLAUDE_MEM_ROOT}${NC}"
        read -p "Update existing installation? (y/N): " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            cd "${CLAUDE_MEM_ROOT}"
            git pull
            npm install
            npm run build
        fi
    else
        echo "Cloning claude-mem..."
        git clone https://github.com/thedotmack/claude-mem.git "${CLAUDE_MEM_ROOT}"
        cd "${CLAUDE_MEM_ROOT}"
        npm install
        npm run build
    fi
}

# Install iFlow CLI integration files using symlinks
install_iflow_integration() {
    echo ""
    echo -e "${YELLOW}Installing iFlow CLI integration...${NC}"

    # Create directories
    mkdir -p "${IFLOW_CONFIG_DIR}/hooks/claude-mem"
    mkdir -p "${IFLOW_CONFIG_DIR}/skills"
    mkdir -p "${IFLOW_CONFIG_DIR}/mcp"

    # Create symlinks for worker scripts (needed by hooks)
    ln -sf "${CLAUDE_MEM_ROOT}/plugin/scripts/bun-runner.js" "${IFLOW_CONFIG_DIR}/hooks/claude-mem/bun-runner.cjs"
    ln -sf "${CLAUDE_MEM_ROOT}/plugin/scripts/worker-service.cjs" "${IFLOW_CONFIG_DIR}/hooks/claude-mem/worker-service.cjs"
    echo -e "${GREEN}✓ Created symlinks for worker scripts${NC}"

    # Create symlinks for MCP server
    ln -sf "${CLAUDE_MEM_ROOT}/plugin/scripts/mcp-server.cjs" "${IFLOW_CONFIG_DIR}/mcp/mcp-server.cjs"
    echo -e "${GREEN}✓ Created symlinks for MCP server${NC}"

    # Create symlinks for skills (link to main plugin skills)
    for skill in mem-search smart-explore; do
        rm -rf "${IFLOW_CONFIG_DIR}/skills/${skill}" 2>/dev/null || true
        ln -s "${CLAUDE_MEM_ROOT}/plugin/skills/${skill}" "${IFLOW_CONFIG_DIR}/skills/${skill}"
    done
    echo -e "${GREEN}✓ Created symlinks for skills${NC}"

    # Update settings.json
    IFLOW_SETTINGS="${IFLOW_CONFIG_DIR}/settings.json"

    if [ ! -f "${IFLOW_SETTINGS}" ]; then
        mkdir -p "${IFLOW_CONFIG_DIR}"
        echo '{}' > "${IFLOW_SETTINGS}"
    fi

    # Use node to merge JSON configuration
    node -e "
const fs = require('fs');
const settings = JSON.parse(fs.readFileSync('${IFLOW_SETTINGS}', 'utf8'));

// Add hooks configuration
settings.hooks = settings.hooks || {};
settings.hooks.SessionStart = settings.hooks.SessionStart || [];
settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit || [];
settings.hooks.PostToolUse = settings.hooks.PostToolUse || [];
settings.hooks.Stop = settings.hooks.Stop || [];
settings.hooks.SessionEnd = settings.hooks.SessionEnd || [];

const hooksDir = '${IFLOW_CONFIG_DIR}/hooks/claude-mem';

// Check if claude-mem hooks already exist
const hasClaudeMemHooks = settings.hooks.SessionStart.some(h =>
  JSON.stringify(h).includes('claude-mem') || JSON.stringify(h).includes('worker-service')
);

if (!hasClaudeMemHooks) {
  // SessionStart: startup - start worker + inject context
  settings.hooks.SessionStart.push({
    matcher: 'startup',
    hooks: [
      { type: 'command', command: 'node ' + hooksDir + '/bun-runner.cjs ' + hooksDir + '/worker-service.cjs start', timeout: 60 },
      { type: 'command', command: 'node ' + hooksDir + '/bun-runner.cjs ' + hooksDir + '/worker-service.cjs hook iflow-cli context', timeout: 60 }
    ]
  });

  // SessionStart: clear/compact - start worker only
  settings.hooks.SessionStart.push({
    matcher: 'clear|compact',
    hooks: [
      { type: 'command', command: 'node ' + hooksDir + '/bun-runner.cjs ' + hooksDir + '/worker-service.cjs start', timeout: 60 }
    ]
  });

  // UserPromptSubmit: session init
  settings.hooks.UserPromptSubmit.push({
    hooks: [
      { type: 'command', command: 'node ' + hooksDir + '/bun-runner.cjs ' + hooksDir + '/worker-service.cjs hook iflow-cli session-init', timeout: 30 }
    ]
  });

  // PostToolUse: observation capture
  settings.hooks.PostToolUse.push({
    matcher: 'Edit|MultiEdit|Write|write_file|replace|run_shell_command',
    hooks: [
      { type: 'command', command: 'node ' + hooksDir + '/bun-runner.cjs ' + hooksDir + '/worker-service.cjs hook iflow-cli observation', timeout: 60 }
    ]
  });

  // Stop: summarize
  settings.hooks.Stop.push({
    hooks: [
      { type: 'command', command: 'node ' + hooksDir + '/bun-runner.cjs ' + hooksDir + '/worker-service.cjs hook iflow-cli summarize', timeout: 120 }
    ]
  });

  // SessionEnd: cleanup
  settings.hooks.SessionEnd.push({
    hooks: [
      { type: 'command', command: 'node ' + hooksDir + '/bun-runner.cjs ' + hooksDir + '/worker-service.cjs hook iflow-cli session-complete', timeout: 30 }
    ]
  });
}

// Add MCP server
settings.mcpServers = settings.mcpServers || {};
settings.mcpServers['claude-mem'] = {
  command: 'node',
  args: ['${IFLOW_CONFIG_DIR}/mcp/mcp-server.cjs'],
  env: { CLAUDE_MEM_DATA_DIR: '${HOME}/.claude-mem/data' }
};

fs.writeFileSync('${IFLOW_SETTINGS}', JSON.stringify(settings, null, 2));
console.log('✓ Updated settings.json');
"

    echo -e "${GREEN}✓ Installed iFlow CLI integration${NC}"
}

# Start worker
start_worker() {
    echo ""
    echo -e "${YELLOW}Starting claude-mem worker...${NC}"

    cd "${CLAUDE_MEM_ROOT}"

    # Check if worker is already running
    if curl -s "http://localhost:${WORKER_PORT}/api/health" > /dev/null 2>&1; then
        echo -e "${GREEN}✓ Worker already running on port ${WORKER_PORT}${NC}"
    else
        # Start worker using bun-runner (same as hooks do)
        # worker-service.cjs requires Bun runtime modules (bun:sqlite, etc.)
        nohup node plugin/scripts/bun-runner.js plugin/scripts/worker-service.cjs start > /dev/null 2>&1 &
        sleep 2

        if curl -s "http://localhost:${WORKER_PORT}/api/health" > /dev/null 2>&1; then
            echo -e "${GREEN}✓ Worker started on port ${WORKER_PORT}${NC}"
        else
            echo -e "${YELLOW}⚠ Worker may need manual start${NC}"
            echo "  Run: cd ${CLAUDE_MEM_ROOT} && npm run worker:start"
        fi
    fi
}

# Display completion information
show_completion() {
    echo ""
    echo -e "${GREEN}╔════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║        Installation Complete!             ║${NC}"
    echo -e "${GREEN}╚════════════════════════════════════════════╝${NC}"
    echo ""
    echo "Claude-mem is now integrated with iFlow CLI!"
    echo ""
    echo -e "${BLUE}Features enabled:${NC}"
    echo "  ✓ Context injection on session start"
    echo "  ✓ Session tracking initialization"
    echo "  ✓ Automatic observation capture"
    echo "  ✓ Session summarization"
    echo "  ✓ Session state saving"
    echo ""
    echo -e "${BLUE}Available skills:${NC}"
    echo "  @mem-search <query>  - Search historical memories"
    echo "  @smart-explore      - Smart code exploration"
    echo ""
    echo -e "${BLUE}Next steps:${NC}"
    echo "  1. Restart iFlow CLI: iflow"
    echo "  2. Start working - memories will be captured automatically"
    echo "  3. Use @mem-search to find past work"
    echo ""
    echo -e "${BLUE}Configuration:${NC}"
    echo "  Settings: ${IFLOW_CONFIG_DIR}/settings.json"
    echo "  Hooks: ${IFLOW_CONFIG_DIR}/hooks/claude-mem/"
    echo "  Skills: ${IFLOW_CONFIG_DIR}/skills/"
    echo "  Data: ${HOME}/.claude-mem/data/"
    echo "  Web UI: http://localhost:${WORKER_PORT}"
    echo ""
}

# Main flow
main() {
    check_dependencies
    setup_claude_mem
    install_iflow_integration
    start_worker
    show_completion
}

main "$@"