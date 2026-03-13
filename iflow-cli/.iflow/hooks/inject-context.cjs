#!/usr/bin/env node
/**
 * inject-context.js
 * SessionStart Hook - Inject relevant historical memories into session context
 *
 * Environment variables:
 * - IFLOW_SESSION_ID: Session ID
 * - IFLOW_SESSION_SOURCE: Session source
 * - IFLOW_CWD: Current working directory
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// Environment variable adapter
function getEnvVar(names) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return null;
}

const SESSION_ID = getEnvVar(['IFLOW_SESSION_ID', 'CLAUDE_SESSION_ID']);
const SESSION_SOURCE = getEnvVar(['IFLOW_SESSION_SOURCE', 'CLAUDE_SESSION_SOURCE']);
const CWD = getEnvVar(['IFLOW_CWD', 'CLAUDE_CWD']);
const WORKER_PORT = process.env.CLAUDE_MEM_WORKER_PORT || 37777;

// Infer project name from project path
function inferProjectName(cwd) {
  if (!cwd) return 'default';
  return path.basename(cwd) || 'default';
}

// Search relevant memories
async function searchRelevantMemories(project, limit = 10) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port: WORKER_PORT,
      path: `/api/search?project=${encodeURIComponent(project)}&limit=${limit}&orderBy=date_desc`,
      method: 'GET',
      timeout: 10000
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });

    req.end();
  });
}

// Format memories as context
function formatContext(response) {
  // Handle API response structure: { content: [...] } or { observations, sessions, prompts }
  let memories = [];
  if (response && response.content && Array.isArray(response.content)) {
    memories = response.content;
  } else if (response && response.observations && Array.isArray(response.observations)) {
    memories = response.observations;
  } else if (Array.isArray(response)) {
    memories = response;
  }

  if (!memories || memories.length === 0) {
    return '';
  }

  const lines = [
    '=== Historical Memory Context ===',
    '',
    'Below are relevant historical work records that may help with the current task:',
    ''
  ];

  for (const mem of memories.slice(0, 5)) {
    const typeEmoji = {
      decision: '🔵',
      bugfix: '🔴',
      feature: '🟢',
      discovery: '🟡',
      change: '🟣'
    }[mem.type] || '⚪';

    const date = mem.created_at ? new Date(mem.created_at).toLocaleDateString() : '';
    lines.push(`${typeEmoji} **${mem.title || 'Unknown operation'}** (${date})`);
    if (mem.files_modified && mem.files_modified.length > 0) {
      lines.push(`   Files: ${mem.files_modified.slice(0, 3).join(', ')}`);
    }
    lines.push('');
  }

  lines.push('Use `/mem-search <keyword>` to search for more historical memories');
  lines.push('');

  return lines.join('\n');
}

// Main function
async function main() {
  try {
    // Only inject on startup (not resume/clear/compact)
    if (SESSION_SOURCE && SESSION_SOURCE !== 'startup') {
      console.log(`Skipping context injection for source: ${SESSION_SOURCE}`);
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
      console.log('Claude-mem worker not running, skipping context injection');
      process.exit(0);
    }

    const project = inferProjectName(CWD);

    // Search relevant memories
    const response = await searchRelevantMemories(project);

    if (!response) {
      console.log('No relevant memories found for this project');
      process.exit(0);
    }

    // Output context (will be injected into session by iFlow CLI)
    const context = formatContext(response);

    if (context) {
      console.log(context);
    } else {
      console.log('No relevant memories found for this project');
    }

    process.exit(0);

  } catch (error) {
    // Don't block session startup on error
    console.error('Failed to inject context:', error.message);
    process.exit(0);
  }
}

main();