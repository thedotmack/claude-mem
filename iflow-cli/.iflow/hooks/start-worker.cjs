#!/usr/bin/env node
/**
 * start-worker.js
 * SessionStart Hook - Start claude-mem worker service
 */

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const WORKER_PORT = process.env.CLAUDE_MEM_WORKER_PORT || 37777;
const CLAUDE_MEM_ROOT = process.env.CLAUDE_MEM_ROOT ||
  process.env.HOME + '/.claude-mem';

// Check if worker is already running
async function isWorkerRunning() {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: 'localhost',
      port: WORKER_PORT,
      path: '/api/health',
      method: 'GET',
      timeout: 3000
    }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

// Start worker
async function startWorker() {
  return new Promise((resolve, reject) => {
    const workerPath = path.join(CLAUDE_MEM_ROOT, 'plugin/scripts/worker-service.cjs');

    const worker = spawn('node', [workerPath, 'start'], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        CLAUDE_MEM_WORKER_PORT: WORKER_PORT.toString()
      }
    });

    worker.unref();

    // Wait for startup
    setTimeout(async () => {
      const running = await isWorkerRunning();
      if (running) {
        resolve(true);
      } else {
        reject(new Error('Worker failed to start'));
      }
    }, 2000);
  });
}

async function main() {
  try {
    // Check if already running
    const running = await isWorkerRunning();

    if (running) {
      console.log('Claude-mem worker already running');
      process.exit(0);
    }

    // Start worker
    console.log('Starting claude-mem worker...');
    await startWorker();
    console.log('✓ Claude-mem worker started on port ' + WORKER_PORT);

    process.exit(0);
  } catch (error) {
    console.error('Failed to start worker:', error.message);
    // Don't block session startup
    process.exit(0);
  }
}

main();