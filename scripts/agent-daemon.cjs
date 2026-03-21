#!/usr/bin/env node
/**
 * Agent Daemon: Picks up mailbox tasks for custom agents and calls LLM APIs
 *
 * For each custom agent (not claude-code, codex, claude-app):
 * 1. Polls mailbox every 10s
 * 2. Calls the configured LLM API (via OpenRouter) with the prompt
 * 3. Posts the response as an observation
 * 4. Marks the message as read
 * 5. Sends a completion message back
 *
 * Uses OpenRouter as the unified API since it supports all models.
 * Requires OPENROUTER_API_KEY in ~/.claude-mem/settings.json or env.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const POLL_INTERVAL = 10000; // 10 seconds
const SETTINGS_PATH = path.join(os.homedir(), '.claude-mem', 'settings.json');
const PID_FILE = path.join(os.homedir(), '.claude-mem', 'agent-daemon.pid');
const BUILTIN_AGENTS = new Set(['claude-code', 'codex', 'claude-app']);

// ─── HTTP Helpers ──────────────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const data = JSON.stringify(body);
    const parsed = new URL(url);
    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'POST',
      timeout: 60000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let resData = '';
      res.on('data', chunk => resData += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: resData }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

function httpPatch(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'PATCH',
      timeout: 10000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let resData = '';
      res.on('data', chunk => resData += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: resData }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

// ─── Settings ──────────────────────────────────────────────
function getSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
  } catch { return {}; }
}

function getWorkerPort() {
  try {
    const pidFile = path.join(os.homedir(), '.claude-mem', 'worker.pid');
    const data = JSON.parse(fs.readFileSync(pidFile, 'utf-8'));
    return data.port;
  } catch { return 37777; }
}

function getOpenRouterKey() {
  const settings = getSettings();
  return settings.CLAUDE_MEM_OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY || '';
}

// ─── Call LLM via OpenRouter ───────────────────────────────
async function callLLM(model, prompt) {
  const apiKey = getOpenRouterKey();
  if (!apiKey) throw new Error('No OpenRouter API key configured');

  const response = await new Promise((resolve, reject) => {
    const data = JSON.stringify({
      model: model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 4096,
    });

    const req = https.request({
      hostname: 'openrouter.ai',
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'X-Title': 'claude-mem-agent-daemon',
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('LLM API timeout')); });
    req.setTimeout(120000); // 2 min timeout for LLM
    req.write(data);
    req.end();
  });

  if (response.status !== 200) {
    throw new Error(`OpenRouter API error ${response.status}: ${response.body.substring(0, 200)}`);
  }

  const result = JSON.parse(response.body);
  if (result.error) throw new Error(`API error: ${result.error.message}`);

  const content = result.choices?.[0]?.message?.content || '';
  const usage = result.usage || {};

  return { content, inputTokens: usage.prompt_tokens || 0, outputTokens: usage.completion_tokens || 0 };
}

// ─── Main Loop ─────────────────────────────────────────────
function log(msg) {
  const ts = new Date().toLocaleTimeString();
  console.log(`[${ts}] ${msg}`);
}

async function processAgent(baseUrl, agentName, agentConfig) {
  // Check mailbox
  let messages;
  try {
    const res = await httpGet(`${baseUrl}/api/mailbox/${agentName}`);
    if (res.status !== 200) return;
    messages = JSON.parse(res.body).messages || [];
  } catch { return; }

  if (messages.length === 0) return;

  log(`${agentName}: ${messages.length} unread message(s)`);

  for (const msg of messages) {
    log(`${agentName}: Processing "${msg.subject}"`);

    // Extract prompt from body
    let prompt = msg.body;
    try {
      const parsed = JSON.parse(msg.body);
      prompt = parsed.prompt || msg.body;
    } catch {} // body might be plain text

    // Get model from agent config
    const model = agentConfig.model || 'deepseek/deepseek-chat-v3-0324:free';

    try {
      // Call LLM
      log(`${agentName}: Calling ${model}...`);
      const result = await callLLM(model, prompt);
      log(`${agentName}: Got response (${result.inputTokens}+${result.outputTokens} tokens)`);

      // Post response as a message back
      await httpPost(`${baseUrl}/api/mailbox`, {
        from: agentName,
        to: msg.from_agent,
        subject: `Re: ${msg.subject}`,
        body: result.content,
        urgent: false
      });

      // Mark original message as read
      await httpPatch(`${baseUrl}/api/mailbox/${msg.id}/read`);

      // Update agent heartbeat with token usage
      const currentTokens = agentConfig.tokens_used_today || 0;
      await httpPatch(`${baseUrl}/api/status/${agentName}`, {
        current_task: null,
        tokens_used_today: currentTokens + result.inputTokens + result.outputTokens
      });

      log(`${agentName}: Response sent to ${msg.from_agent}`);

    } catch (err) {
      log(`${agentName}: ERROR - ${err.message}`);

      // Send error message back
      try {
        await httpPost(`${baseUrl}/api/mailbox`, {
          from: agentName,
          to: msg.from_agent,
          subject: `Error: ${msg.subject}`,
          body: `Failed to process with ${model}: ${err.message}`,
          urgent: true
        });
        await httpPatch(`${baseUrl}/api/mailbox/${msg.id}/read`);
      } catch {}
    }
  }
}

async function poll() {
  const port = getWorkerPort();
  const baseUrl = `http://localhost:${port}`;

  // Health check
  try {
    const res = await httpGet(`${baseUrl}/api/health`);
    if (res.status !== 200) return;
  } catch {
    return; // Worker offline
  }

  // Get agent list
  let controls;
  try {
    const res = await httpGet(`${baseUrl}/api/controls`);
    controls = JSON.parse(res.body);
  } catch { return; }

  // Process each custom agent (not built-in ones)
  for (const [name, config] of Object.entries(controls.agents || {})) {
    if (BUILTIN_AGENTS.has(name)) continue;
    if (!config.listening) continue;

    try {
      await processAgent(baseUrl, name, config);
    } catch (err) {
      log(`${name}: Poll error - ${err.message}`);
    }
  }
}

// ─── Start ─────────────────────────────────────────────────
fs.writeFileSync(PID_FILE, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
process.on('exit', () => { try { fs.unlinkSync(PID_FILE); } catch {} });
process.on('SIGINT', () => process.exit());
process.on('SIGTERM', () => process.exit());

log('=== Agent Daemon Started ===');
log(`Polling every ${POLL_INTERVAL / 1000}s for custom agent mailboxes`);
log('Built-in agents (claude-code, codex, claude-app) are skipped');
log('');

// Initial poll
poll();

// Continuous polling
setInterval(poll, POLL_INTERVAL);
