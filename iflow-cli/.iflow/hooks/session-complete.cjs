#!/usr/bin/env node
/**
 * session-complete.js
 * SessionEnd Hook - Save final session state
 *
 * Environment variables:
 * - IFLOW_SESSION_ID: Session ID
 * - IFLOW_CWD: Current working directory
 */

const http = require('http');

// Environment variable adapter
function getEnvVar(names) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return null;
}

const SESSION_ID = getEnvVar(['IFLOW_SESSION_ID', 'CLAUDE_SESSION_ID']);
const CWD = getEnvVar(['IFLOW_CWD', 'CLAUDE_CWD']);
const WORKER_PORT = process.env.CLAUDE_MEM_WORKER_PORT || 37777;

// Mark session as complete
async function completeSession(sessionId) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      contentSessionId: sessionId,
      status: 'completed',
      endedAt: Date.now()
    });

    const req = http.request({
      hostname: 'localhost',
      port: WORKER_PORT,
      path: '/api/sessions/complete',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      },
      timeout: 30000
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            resolve({ status: 'ok' });
          }
        } else {
          // Session complete endpoint may not exist, that's ok
          resolve({ status: 'ok' });
        }
      });
    });

    req.on('error', () => resolve({ status: 'ok' })); // Don't fail on error
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 'ok' });
    });

    req.write(data);
    req.end();
  });
}

// Main function
async function main() {
  try {
    if (!SESSION_ID) {
      console.log('No session ID, skipping session completion');
      process.exit(0);
    }

    // Check if worker is running
    const healthCheck = await new Promise((resolve) => {
      const req = http.request({
        hostname: 'localhost',
        port: WORKER_PORT,
        path: '/api/health',
        method: 'GET',
        timeout: 5000
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

    if (!healthCheck) {
      console.log('Claude-mem worker not running, skipping session completion');
      process.exit(0);
    }

    // Complete session
    await completeSession(SESSION_ID);

    console.log('✓ Session marked as complete');
    process.exit(0);

  } catch (error) {
    // Don't fail on error
    console.error('Failed to complete session:', error.message);
    process.exit(0);
  }
}

main();
