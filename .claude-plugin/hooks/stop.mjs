#!/usr/bin/env node
// claude-mem Stop / SessionEnd hook
// Marks the session as complete and triggers summarization in the worker.

const PORT = process.env.CLAUDE_MEM_WORKER_PORT || '37777';
const BASE = `http://127.0.0.1:${PORT}`;

async function tryPost(path, body, timeoutMs = 8000) {
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), timeoutMs);
    await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch { /* non-fatal */ }
}

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

  await tryPost('/api/sessions/complete', { contentSessionId: sessionId, project: cwd });
  await tryPost('/api/sessions/summarize', { contentSessionId: sessionId, project: cwd });

  process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }) + '\n');
  process.exit(0);
}

main().catch(() => { process.exit(0); });
