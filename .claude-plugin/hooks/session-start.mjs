#!/usr/bin/env node
// claude-mem SessionStart hook
// 1. Ensures the worker service is running (starts it via bun if needed)
// 2. Initialises a session record in the worker
// 3. Fetches past context and injects it as a system reminder

import { execFile, execFileSync } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';

const PORT = process.env.CLAUDE_MEM_WORKER_PORT || '37777';
const BASE = `http://127.0.0.1:${PORT}`;

// ── helpers ────────────────────────────────────────────────────────────────

async function tryFetch(url, opts = {}, timeoutMs = 3000) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctrl.signal, ...opts });
    clearTimeout(t);
    return res;
  } catch {
    return null;
  }
}

async function workerReady() {
  const res = await tryFetch(`${BASE}/api/health`, {}, 2000);
  return res?.ok === true;
}

function findBun() {
  const candidates = [
    join(homedir(), '.bun', 'bin', 'bun.exe'),
    join(homedir(), '.bun', 'bin', 'bun'),
  ];
  for (const b of candidates) {
    if (existsSync(b)) return b;
  }
  try {
    execFileSync('bun', ['--version'], { stdio: 'ignore', timeout: 2000 });
    return 'bun';
  } catch { return null; }
}

async function startWorker() {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ||
    join(homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack');
  const workerCli = join(pluginRoot, 'plugin', 'scripts', 'worker-cli.js');

  if (!existsSync(workerCli)) {
    process.stderr.write('[claude-mem] worker-cli.js not found at ' + workerCli + '\n');
    return false;
  }

  const bun = findBun();
  if (!bun) {
    process.stderr.write('[claude-mem] bun not found — cannot start worker\n');
    return false;
  }

  return new Promise(resolve => {
    execFile(bun, [workerCli, 'start'], {
      timeout: 20000,
      windowsHide: true,
      env: { ...process.env, CLAUDE_MEM_WORKER_PORT: PORT },
    }, async () => {
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 500));
        if (await workerReady()) { resolve(true); return; }
      }
      resolve(false);
    });
  });
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  await new Promise(resolve => {
    process.stdin.on('data', d => { raw += d; });
    process.stdin.on('end', resolve);
  });

  let hookData = {};
  try { hookData = JSON.parse(raw); } catch {}

  const sessionId = hookData.session_id || hookData.sessionId || '';
  const cwd = hookData.cwd || process.cwd();

  // 1. Ensure worker is running
  if (!(await workerReady())) {
    const started = await startWorker();
    if (!started) {
      process.stderr.write('[claude-mem] Worker unavailable — skipping context injection\n');
      process.exit(0);
    }
  }

  // 2. Init session
  await tryFetch(`${BASE}/api/sessions/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contentSessionId: sessionId, project: cwd }),
  }, 5000);

  // 3. Fetch context to inject
  const ctxRes = await tryFetch(`${BASE}/api/context/inject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contentSessionId: sessionId, project: cwd }),
  }, 10000);

  if (ctxRes?.ok) {
    const data = await ctxRes.json().catch(() => null);
    const context = data?.context || data?.content || data?.output || '';
    if (context && context.trim()) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: context }) + '\n');
      process.exit(0);
    }
  }

  process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }) + '\n');
  process.exit(0);
}

main().catch(e => {
  process.stderr.write('[claude-mem] SessionStart error: ' + e.message + '\n');
  process.exit(0);
});
