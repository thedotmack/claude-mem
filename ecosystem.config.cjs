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

module.exports = {
  apps: [
    {
      name: 'claude-mem-worker',
      script: './plugin/scripts/worker-service.cjs',
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
