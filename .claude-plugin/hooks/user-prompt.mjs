#!/usr/bin/env node
// claude-mem UserPromptSubmit hook
// Sends the user prompt to the worker so it can be stored and associated with
// the current session for later recall.

const PORT = process.env.CLAUDE_MEM_WORKER_PORT || '37777';
const BASE = `http://127.0.0.1:${PORT}`;
const CONTINUE = JSON.stringify({ continue: true, suppressOutput: true });

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
  const prompt = hookData.prompt || hookData.user_prompt || '';
  const cwd = hookData.cwd || process.cwd();

  if (prompt) {
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 4000);
      await fetch(`${BASE}/api/prompts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contentSessionId: sessionId, prompt, project: cwd }),
        signal: ctrl.signal,
      });
    } catch { /* non-fatal */ }
  }

  process.stdout.write(CONTINUE + '\n');
  process.exit(0);
}

main().catch(() => {
  process.stdout.write(CONTINUE + '\n');
  process.exit(0);
});
