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
 * Runtime Selection:
 *   Set CLAUDE_MEM_RUNTIME environment variable to 'bun' to use Bun runtime
 *   Or configure in ~/.claude-mem/settings.json: { "env": { "CLAUDE_MEM_RUNTIME": "bun" } }
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/**
 * Detect if Bun is available and should be used
 */
function getRuntime() {
  // Check environment variable first
  const envRuntime = process.env.CLAUDE_MEM_RUNTIME;
  if (envRuntime === 'bun' || envRuntime === 'node') {
    // Verify the runtime is available
    if (envRuntime === 'bun') {
      try {
        execSync('bun --version', { stdio: 'ignore' });
        return 'bun';
      } catch {
        console.warn('CLAUDE_MEM_RUNTIME=bun but Bun not available, falling back to Node.js');
      }
    }
    return 'node';
  }

  // Check settings file
  const settingsPath = path.join(require('os').homedir(), '.claude-mem', 'settings.json');
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      const runtime = settings.env?.CLAUDE_MEM_RUNTIME;
      if (runtime === 'bun') {
        try {
          execSync('bun --version', { stdio: 'ignore' });
          return 'bun';
        } catch {
          console.warn('Settings specify Bun but Bun not available, falling back to Node.js');
        }
      }
    } catch {
      // Ignore settings read errors
    }
  }

  return 'node';
}

const runtime = getRuntime();

module.exports = {
  apps: [
    {
      name: 'claude-mem-worker',
      script: './plugin/scripts/worker-service.cjs',
      interpreter: runtime,
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
