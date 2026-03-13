#!/usr/bin/env node
/**
 * capture-observation.js
 * PostToolUse Hook - Capture tool operations and save as observations
 *
 * Environment variables:
 * - IFLOW_TOOL_NAME: Tool name
 * - IFLOW_TOOL_ARGS: Tool arguments (JSON)
 * - IFLOW_SESSION_ID: Session ID
 * - IFLOW_CWD: Current working directory
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// Environment variable adapter (supports Claude Code and iFlow CLI)
function getEnvVar(names) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return null;
}

const TOOL_NAME = getEnvVar(['IFLOW_TOOL_NAME', 'CLAUDE_TOOL_NAME']);
const TOOL_ARGS = getEnvVar(['IFLOW_TOOL_ARGS', 'CLAUDE_TOOL_ARGS']);
const SESSION_ID = getEnvVar(['IFLOW_SESSION_ID', 'CLAUDE_SESSION_ID']);
const CWD = getEnvVar(['IFLOW_CWD', 'CLAUDE_CWD']);
const WORKER_PORT = process.env.CLAUDE_MEM_WORKER_PORT || 37777;

// Infer observation type from tool name and args
function inferObservationType(toolName, toolArgs) {
  const args = typeof toolArgs === 'string' ? JSON.parse(toolArgs) : toolArgs;

  // Infer from tool name
  if (toolName === 'run_shell_command') {
    const cmd = args.command || '';
    if (cmd.includes('test') || cmd.includes('spec')) return 'bugfix';
    if (cmd.includes('deploy') || cmd.includes('build')) return 'change';
    return 'discovery';
  }

  // File editing operations
  if (['Edit', 'MultiEdit', 'Write', 'write_file', 'replace'].includes(toolName)) {
    return 'change';
  }

  return 'discovery';
}

// Generate title from tool name and args
function generateTitle(toolName, toolArgs) {
  const args = typeof toolArgs === 'string' ? JSON.parse(toolArgs) : toolArgs;

  if (toolName === 'write_file' || toolName === 'Write') {
    return `Created/Modified: ${args.file_path || args.path || 'unknown file'}`;
  }

  if (toolName === 'replace' || toolName === 'Edit') {
    return `Edited: ${args.file_path || args.path || 'unknown file'}`;
  }

  if (toolName === 'run_shell_command') {
    const cmd = (args.command || '').slice(0, 50);
    return `Executed: ${cmd}...`;
  }

  return `${toolName} operation`;
}

// Extract file paths from tool args
function extractFiles(toolArgs) {
  const args = typeof toolArgs === 'string' ? JSON.parse(toolArgs) : toolArgs;
  const files = [];

  if (args.file_path) files.push(args.file_path);
  if (args.path) files.push(args.path);
  if (args.destinationFile) files.push(args.destinationFile);

  return files;
}

// Call Worker API to save observation
async function saveObservation(observation) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(observation);

    const req = http.request({
      hostname: 'localhost',
      port: WORKER_PORT,
      path: '/api/sessions/observations',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      },
      timeout: 25000
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(body));
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${body}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.write(data);
    req.end();
  });
}

// Main function
async function main() {
  try {
    // Parse tool arguments
    let toolArgs = {};
    try {
      toolArgs = TOOL_ARGS ? JSON.parse(TOOL_ARGS) : {};
    } catch (e) {
      console.error('Failed to parse tool args:', e.message);
      toolArgs = {};
    }

    // Build observation object
    const observation = {
      type: inferObservationType(TOOL_NAME, toolArgs),
      title: generateTitle(TOOL_NAME, toolArgs),
      files_modified: extractFiles(toolArgs),
      files_read: [],
      contentSessionId: SESSION_ID,
      cwd: CWD,
      tool_name: TOOL_NAME,
      tool_input: toolArgs,
      timestamp: Date.now()
    };

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
      // Worker not running, exit silently (don't block main flow)
      console.log('Claude-mem worker not running, skipping observation capture');
      process.exit(0);
    }

    // Save observation
    await saveObservation(observation);

    // Exit successfully (output will be displayed by iFlow CLI)
    console.log(`✓ Captured: ${observation.title}`);
    process.exit(0);

  } catch (error) {
    // Don't block main flow on error
    console.error('Failed to capture observation:', error.message);
    process.exit(0); // Return 0 to avoid blocking
  }
}

main();