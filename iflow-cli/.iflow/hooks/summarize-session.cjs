#!/usr/bin/env node
/**
 * summarize-session.js
 * Stop Hook - Generate session summary
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

// Trigger session summarization
async function triggerSummarization(sessionId) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ contentSessionId: sessionId });

    const req = http.request({
      hostname: 'localhost',
      port: WORKER_PORT,
      path: '/api/sessions/summarize',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      },
      timeout: 60000 // Summarization may take longer
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
          reject(new Error(`HTTP ${res.statusCode}: ${body}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });

    req.write(data);
    req.end();
  });
}

// Main function
async function main() {
  try {
    if (!SESSION_ID) {
      console.log('No session ID, skipping summarization');
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
      console.log('Claude-mem worker not running, skipping summarization');
      process.exit(0);
    }

    // Trigger summarization
    console.log('Generating session summary...');
    await triggerSummarization(SESSION_ID);

    console.log('✓ Session summary generated');
    process.exit(0);

  } catch (error) {
    console.error('Failed to generate summary:', error.message);
    process.exit(0);
  }
}

main();