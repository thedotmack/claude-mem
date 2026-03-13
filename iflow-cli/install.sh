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
REPO_URL="https://raw.githubusercontent.com/thedotmack/claude-mem/main/iflow-cli"

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

    if command -v bun &> /dev/null; then
        echo -e "${GREEN}✓ Bun: $(bun --version)${NC}"
    else
        echo -e "${YELLOW}⚠ Bun not installed (optional, needed for worker)${NC}"
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

# Install iFlow CLI integration files
install_iflow_integration() {
    echo ""
    echo -e "${YELLOW}Installing iFlow CLI integration...${NC}"

    # Create directories
    mkdir -p "${CLAUDE_MEM_ROOT}/iflow-cli/hooks"
    mkdir -p "${IFLOW_CONFIG_DIR}/skills/mem-search"
    mkdir -p "${IFLOW_CONFIG_DIR}/skills/mem-context"

    # Download hook scripts from GitHub
    echo "Downloading hook scripts..."
    curl -fsSL "${REPO_URL}/.iflow/hooks/capture-observation.cjs" -o "${CLAUDE_MEM_ROOT}/iflow-cli/hooks/capture-observation.cjs"
    curl -fsSL "${REPO_URL}/.iflow/hooks/inject-context.cjs" -o "${CLAUDE_MEM_ROOT}/iflow-cli/hooks/inject-context.cjs"
    curl -fsSL "${REPO_URL}/.iflow/hooks/start-worker.cjs" -o "${CLAUDE_MEM_ROOT}/iflow-cli/hooks/start-worker.cjs"
    curl -fsSL "${REPO_URL}/.iflow/hooks/summarize-session.cjs" -o "${CLAUDE_MEM_ROOT}/iflow-cli/hooks/summarize-session.cjs"
    curl -fsSL "${REPO_URL}/.iflow/hooks/session-complete.cjs" -o "${CLAUDE_MEM_ROOT}/iflow-cli/hooks/session-complete.cjs"
    echo -e "${GREEN}✓ Downloaded hook scripts${NC}"

    # Download skills to ~/.iflow/skills/
    echo "Downloading skills..."
    curl -fsSL "${REPO_URL}/.iflow/skills/mem-search/SKILL.md" -o "${IFLOW_CONFIG_DIR}/skills/mem-search/SKILL.md"
    curl -fsSL "${REPO_URL}/.iflow/skills/mem-context/SKILL.md" -o "${IFLOW_CONFIG_DIR}/skills/mem-context/SKILL.md"
    echo -e "${GREEN}✓ Downloaded skill definitions${NC}"

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
settings.hooks.PostToolUse = settings.hooks.PostToolUse || [];
settings.hooks.Stop = settings.hooks.Stop || [];
settings.hooks.SessionEnd = settings.hooks.SessionEnd || [];

// Add claude-mem hooks (avoid duplicates)
const sessionStartHook = {
  matcher: 'startup',
  hooks: [
    { type: 'command', command: 'node ${CLAUDE_MEM_ROOT}/iflow-cli/hooks/start-worker.cjs', timeout: 60 },
    { type: 'command', command: 'node ${CLAUDE_MEM_ROOT}/iflow-cli/hooks/inject-context.cjs', timeout: 60 }
  ]
};

const postToolUseHook = {
  matcher: 'Edit|MultiEdit|Write|write_file|replace|run_shell_command',
  hooks: [
    { type: 'command', command: 'node ${CLAUDE_MEM_ROOT}/iflow-cli/hooks/capture-observation.cjs', timeout: 30 }
  ]
};

const stopHook = {
  hooks: [
    { type: 'command', command: 'node ${CLAUDE_MEM_ROOT}/iflow-cli/hooks/summarize-session.cjs', timeout: 120 }
  ]
};

const sessionEndHook = {
  hooks: [
    { type: 'command', command: 'node ${CLAUDE_MEM_ROOT}/iflow-cli/hooks/session-complete.cjs', timeout: 30 }
  ]
};

// Check if claude-mem hooks already exist
const hasClaudeMemHooks = settings.hooks.SessionStart.some(h =>
  JSON.stringify(h).includes('claude-mem') || JSON.stringify(h).includes('inject-context')
);

if (!hasClaudeMemHooks) {
  settings.hooks.SessionStart.push(sessionStartHook);
  settings.hooks.PostToolUse.push(postToolUseHook);
  settings.hooks.Stop.push(stopHook);
  settings.hooks.SessionEnd.push(sessionEndHook);
}

// Add MCP server
settings.mcpServers = settings.mcpServers || {};
settings.mcpServers['claude-mem'] = {
  command: 'node',
  args: ['${CLAUDE_MEM_ROOT}/plugin/scripts/mcp-server.cjs'],
  env: { CLAUDE_MEM_DATA_DIR: '${HOME}/.claude-mem/data' }
};

// Add configuration
settings.claudeMem = {
  workerPort: ${WORKER_PORT},
  project: 'iflow-cli',
  autoCapture: true,
  autoInject: true,
  maxContextTokens: 4000
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
        # Start worker (background)
        nohup node plugin/scripts/worker-service.cjs start > /dev/null 2>&1 &
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
    echo "  ✓ Automatic observation capture (PostToolUse hook)"
    echo "  ✓ Context injection on session start (SessionStart hook)"
    echo "  ✓ Session summarization (Stop hook)"
    echo "  ✓ Session state saving (SessionEnd hook)"
    echo ""
    echo -e "${BLUE}Available skills:${NC}"
    echo "  @mem-search <query>  - Search historical memories"
    echo "  @mem-context         - Manually inject context"
    echo ""
    echo -e "${BLUE}Next steps:${NC}"
    echo "  1. Restart iFlow CLI: iflow"
    echo "  2. Start working - memories will be captured automatically"
    echo "  3. Use @mem-search to find past work"
    echo ""
    echo -e "${BLUE}Configuration:${NC}"
    echo "  Settings: ${IFLOW_CONFIG_DIR}/settings.json"
    echo "  Skills: ${IFLOW_CONFIG_DIR}/skills/"
    echo "  Hooks: ${CLAUDE_MEM_ROOT}/iflow-cli/hooks/"
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
