#!/bin/bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[0;33m'
NC='\033[0m'

echo ""
echo -e "${YELLOW}The curl-pipe-bash installer has been replaced.${NC}"
echo ""
echo -e "${GREEN}Install claude-mem with a single command:${NC}"
echo ""
echo -e "  ${CYAN}npx claude-mem install${NC}"
echo ""
echo -e "This requires Node.js >= 20. Get it from ${CYAN}https://nodejs.org${NC}"
echo ""
echo -e "For more info, visit: ${CYAN}https://docs.claude-mem.ai/installation${NC}"
echo ""
