#!/bin/bash
# Find Silent Failure Patterns
#
# This script searches for defensive OR patterns (|| '' || null || undefined)
# that should potentially use happy_path_error__with_fallback instead.
#
# Usage: ./scripts/find-silent-failures.sh

echo "=================================================="
echo "Searching for defensive OR patterns in src/"
echo "These MAY be silent failures that should log errors"
echo "=================================================="
echo ""

echo "🔍 Searching for: || ''"
echo "---"
grep -rn "|| ''" src/ --include="*.ts" --color=always || echo "  (none found)"
echo ""

echo "🔍 Searching for: || \"\""
echo "---"
grep -rn '|| ""' src/ --include="*.ts" --color=always || echo "  (none found)"
echo ""

echo "🔍 Searching for: || null"
echo "---"
grep -rn "|| null" src/ --include="*.ts" --color=always || echo "  (none found)"
echo ""

echo "🔍 Searching for: || undefined"
echo "---"
grep -rn "|| undefined" src/ --include="*.ts" --color=always || echo "  (none found)"
echo ""

echo "=================================================="
echo "Review each match and determine if it should use:"
echo "  happy_path_error__with_fallback('description', data, fallback)"
echo "=================================================="
