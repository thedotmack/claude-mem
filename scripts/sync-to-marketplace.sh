#!/bin/bash

# sync-to-marketplace.sh
# Syncs the plugin folder to the Claude marketplace location

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
SOURCE_DIR="plugin/"
DEST_DIR="$HOME/.claude/plugins/marketplaces/thedotmack/plugin/"

# Function to print colored output
print_status() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if source directory exists
if [ ! -d "$SOURCE_DIR" ]; then
    print_error "Source directory '$SOURCE_DIR' does not exist!"
    exit 1
fi

# Create destination directory if it doesn't exist
if [ ! -d "$DEST_DIR" ]; then
    print_warning "Destination directory '$DEST_DIR' does not exist. Creating it..."
    mkdir -p "$DEST_DIR"
fi

print_status "Syncing plugin folder to marketplace..."
print_status "Source: $SOURCE_DIR"
print_status "Destination: $DEST_DIR"

# Show what would be synced (dry run first)
if [ "$1" = "--dry-run" ] || [ "$1" = "-n" ]; then
    print_status "Dry run - showing what would be synced:"
    rsync -av --delete --dry-run "$SOURCE_DIR" "$DEST_DIR"
    exit 0
fi

# Perform the actual sync
if rsync -av --delete "$SOURCE_DIR" "$DEST_DIR"; then
    print_status "✅ Plugin folder synced successfully!"
else
    print_error "❌ Sync failed!"
    exit 1
fi

# Show summary
echo ""
print_status "Sync complete. Files are now synchronized."
print_status "You can run '$0 --dry-run' to preview changes before syncing."