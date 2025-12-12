/**
 * PM2 Ecosystem Configuration for claude-mem Worker Service
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs
 *   pm2 stop claude-mem-worker
 *   pm2 restart claude-mem-worker
 *   pm2 logs claude-mem-worker
 *   pm2 status
 *
 * Note: This config dynamically sets NODE_PATH to resolve native modules
 * from the cache directory when installed via Claude's plugin marketplace.
 * See: https://github.com/thedotmack/claude-mem/issues/253
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

/**
 * Find the cache directory containing node_modules
 * Claude installs dependencies in cache/thedotmack/claude-mem/{version}/
 */
function findCacheNodeModules() {
  const cacheBase = path.join(os.homedir(), '.claude', 'plugins', 'cache', 'thedotmack', 'claude-mem');

  if (!fs.existsSync(cacheBase)) {
    return null;
  }

  // Find version directories (e.g., "7.0.11")
  const versions = fs.readdirSync(cacheBase)
    .filter(name => /^\d+\.\d+\.\d+/.test(name))
    .sort((a, b) => {
      // Sort by semver (latest first)
      const [aMajor, aMinor, aPatch] = a.split('.').map(Number);
      const [bMajor, bMinor, bPatch] = b.split('.').map(Number);
      return bMajor - aMajor || bMinor - aMinor || bPatch - aPatch;
    });

  for (const version of versions) {
    const nodeModulesPath = path.join(cacheBase, version, 'node_modules');
    if (fs.existsSync(nodeModulesPath)) {
      return nodeModulesPath;
    }
  }

  return null;
}

// Build NODE_PATH with fallbacks
const nodePaths = [
  findCacheNodeModules(),                    // 1. Cache directory (marketplace install)
  path.join(__dirname, 'node_modules'),      // 2. Local node_modules (dev sync)
  process.env.NODE_PATH                      // 3. Existing NODE_PATH
].filter(Boolean);

module.exports = {
  apps: [
    {
      name: 'claude-mem-worker',
      script: './plugin/scripts/worker-service.cjs',
      // Windows: prevent visible console windows
      windowsHide: true,
      // Set NODE_PATH to resolve native modules from cache directory
      env: {
        NODE_PATH: nodePaths.join(path.delimiter)
      },
      // INTENTIONAL: Watch mode enables auto-restart on plugin updates
      //
      // Why this is enabled:
      // - When you run `npm run sync-marketplace` or rebuild the plugin,
      //   files in ~/.claude/plugins/marketplaces/thedotmack/ change
      // - Watch mode detects these changes and auto-restarts the worker
      // - Users get the latest code without manually running `pm2 restart`
      //
      // This is a feature, not a bug - it ensures users always run the
      // latest version after plugin updates.
      watch: true,
      ignore_watch: [
        'node_modules',
        'logs',
        '*.log',
        '*.db',
        '*.db-*',
        '.git'
      ]
    }
  ]
};
