/**
 * PM2 Ecosystem Configuration for claude-mem Worker Service
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs
 *   pm2 stop claude-mem-worker
 *   pm2 restart claude-mem-worker
 *   pm2 logs claude-mem-worker
 *   pm2 status
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

/**
 * Load NODE_OPTIONS from settings file
 * Priority: ~/.claude-mem/settings.json > default
 * Default provides reasonable heap size for vector database workload
 */
function getNodeOptions() {
  try {
    const settingsPath = path.join(os.homedir(), '.claude-mem', 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      if (settings.env?.NODE_OPTIONS) {
        return settings.env.NODE_OPTIONS;
      }
    }
  } catch (error) {
    // Fall through to default if settings file is invalid
    console.warn('Failed to load NODE_OPTIONS from settings.json:', error.message);
  }

  // Default: 256 MB heap for vector database + observations
  // Industry standard: Worker services should idle at 40-60% heap usage
  return '--max-old-space-size=256';
}

module.exports = {
  apps: [
    {
      name: 'claude-mem-worker',
      script: './plugin/scripts/worker-service.cjs',
      interpreter_args: getNodeOptions(),
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
