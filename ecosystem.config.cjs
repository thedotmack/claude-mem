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

const os = require('os');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

// Determine log directory
const logDir = path.join(os.homedir(), '.claude-mem', 'logs');

// Find Claude Code binary with smart fallback chain
function findClaudeCodeBinary() {
  // 1. Check environment variable first
  if (process.env.CLAUDE_CODE_PATH) {
    return process.env.CLAUDE_CODE_PATH;
  }

  // 2. Try to find in PATH
  try {
    const whichClaude = execSync('which claude 2>/dev/null', { encoding: 'utf8' }).trim();
    if (whichClaude && fs.existsSync(whichClaude)) {
      return whichClaude;
    }
  } catch (e) {
    // which command failed, continue to fallback paths
  }

  // 3. Common installation paths to check
  const homedir = os.homedir();
  const possiblePaths = [
    // nvm installations (try current node version first)
    path.join(homedir, '.nvm/versions/node', process.version, 'bin/claude'),
    // Common nvm versions
    path.join(homedir, '.nvm/versions/node/v20.19.5/bin/claude'),
    path.join(homedir, '.nvm/versions/node/v22.0.0/bin/claude'),
    path.join(homedir, '.nvm/versions/node/v24.5.0/bin/claude'),
    // Local bin
    path.join(homedir, '.local/bin/claude'),
    // System-wide
    '/usr/local/bin/claude',
    '/usr/bin/claude',
    // Homebrew (macOS)
    '/opt/homebrew/bin/claude',
    '/usr/local/opt/claude/bin/claude',
  ];

  for (const candidatePath of possiblePaths) {
    if (fs.existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  // 4. Fallback to author's original path as last resort
  return '/Users/alexnewman/.nvm/versions/node/v24.5.0/bin/claude';
}

module.exports = {
  apps: [{
    name: 'claude-mem-worker',
    script: './plugin/scripts/worker-service.cjs',
    interpreter: 'node',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    min_uptime: '10s',
    max_restarts: 10,
    restart_delay: 4000,

    env: {
      NODE_ENV: 'production',
      CLAUDE_MEM_WORKER_PORT: 37777, // Fixed port for reliability
      FORCE_COLOR: '1',
      CLAUDE_CODE_PATH: findClaudeCodeBinary()
    },

    // Logging
    error_file: path.join(logDir, 'worker-error.log'),
    out_file: path.join(logDir, 'worker-out.log'),
    log_date_format: 'YYYY-MM-DD HH:mm:ss.SSS Z',
    merge_logs: true,

    // Keep logs from last 7 days
    log_type: 'json',

    // Process management
    kill_timeout: 5000,
    listen_timeout: 10000,
    shutdown_with_message: true,

    // PM2 Plus (optional monitoring)
    // instance_var: 'INSTANCE_ID',
    // pmx: true
  }]
};
