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
  apps: [{
    name: 'claude-mem-worker',
    script: './plugin/scripts/worker-service.cjs',
    error_file: '/dev/null',
    out_file: '/dev/null',
    watch: true,
    ignore_watch: [
      'node_modules',
      'logs',
      '*.log',
      '*.db',
      '*.db-*',
      '.git'
    ]
  }]
};
