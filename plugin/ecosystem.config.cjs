/**
 * PM2 Ecosystem Configuration for claude-mem Worker Service (Packaged Plugin)
 *
 * NOTE: This config is for the packaged/cache version of the plugin.
 * The script path is relative to the cache directory structure.
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
      // Packaged structure: cache/thedotmack/claude-mem/X.X.X/scripts/worker-service.cjs
      script: './scripts/worker-service.cjs',
      // Windows: prevent visible console windows
      windowsHide: true,
      // INTENTIONAL: Watch mode enables auto-restart on plugin updates
      //
      // Why this is enabled:
      // - When plugin updates, files change
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
