#!/usr/bin/env node
// claude-mem PostToolUse hook
// Sends tool usage data to the worker as an observation for the current session.
// Respects CLAUDE_MEM_SKIP_TOOLS to avoid capturing low-signal tool calls.

const PORT = process.env.CLAUDE_MEM_WORKER_PORT || '37777';
const BASE = `http://127.0.0.1:${PORT}`;
const CONTINUE = JSON.stringify({ continue: true, suppressOutput: true });

const DEFAULT_SKIP = new Set([
  'ListMcpResourcesTool', 'SlashCommand', 'Skill', 'TodoWrite',
  'AskUserQuestion', 'mcp__ccd_session__mark_chapter',
]);

function buildSkipSet() {
  const env = process.env.CLAUDE_MEM_SKIP_TOOLS;
  if (!env) return DEFAULT_SKIP;
  return new Set(env.split(',').map(s => s.trim()).filter(Boolean));
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

  const toolName = hookData.tool_name || hookData.toolName || '';
  const skipTools = buildSkipSet();

  // Skip low-signal tools
  if (!toolName || skipTools.has(toolName)) {
    process.stdout.write(CONTINUE + '\n');
    process.exit(0);
  }

  const sessionId = hookData.session_id || hookData.sessionId || '';
  const cwd = hookData.cwd || process.cwd();
  const toolInput = hookData.tool_input ?? hookData.toolInput ?? {};
  const toolResponse = hookData.tool_response ?? hookData.toolResponse ?? {};

  // Build a compact observation text
  let text = `Tool: ${toolName}`;
  if (toolInput?.file_path) text += ` | file: ${toolInput.file_path}`;
  else if (toolInput?.command) text += ` | cmd: ${String(toolInput.command).slice(0, 120)}`;
  else if (toolInput?.pattern) text += ` | pattern: ${toolInput.pattern}`;
  else if (toolInput?.query) text += ` | query: ${toolInput.query}`;

  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 4000);
    await fetch(`${BASE}/api/observations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contentSessionId: sessionId,
        project: cwd,
        text,
        type: 'tool-use',
        toolName,
        toolInput,
        toolResponse,
      }),
      signal: ctrl.signal,
    });
  } catch { /* non-fatal */ }

  process.stdout.write(CONTINUE + '\n');
  process.exit(0);
}

main().catch(() => {
  process.stdout.write(CONTINUE + '\n');
  process.exit(0);
});
