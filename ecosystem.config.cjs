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

// Determine log directory
const logDir = path.join(os.homedir(), '.claude-mem', 'logs');

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
      FORCE_COLOR: '1'
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
