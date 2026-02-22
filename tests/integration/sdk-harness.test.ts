/**
 * SDK Harness Integration Tests
 *
 * Validates the Claude Code CLI subprocess wire protocol by spawning `claude -p`
 * as a child process and asserting on the JSON stream output.
 *
 * These are real subprocess integration tests — no mocks or stubs.
 * All tests use CLAUDE_CODE_SIMPLE=1 for isolation (no hooks, no MCP, no CLAUDE.md).
 *
 * Run with: npm run test:sdk
 * Skip with: SKIP_SDK_TESTS=1 npm run test:sdk
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execSync, spawn } from 'child_process';
import type { ChildProcess } from 'child_process';

// Resolve the actual `claude` binary path. The CLI is often wrapped in a shell
// function (e.g. for auto-update), but `spawn()` doesn't go through the shell,
// so we need the real binary path.
const CLAUDE_BIN = (() => {
  try {
    return execSync('bash -c "type -P claude"', { encoding: 'utf-8' }).trim();
  } catch {
    return 'claude'; // Fallback to PATH lookup
  }
})();

// Propagate current environment with these overrides:
// - CLAUDE_CODE_SIMPLE=1: disables hooks, MCP, CLAUDE.md, and attachments
// - CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1: suppresses telemetry/update checks
// - Strip CLAUDECODE: prevents "nested session" refusal when tests run inside
//   a Claude Code session (the parent session sets CLAUDECODE=1)
// - Strip other CLAUDE_* vars from parent to avoid inheriting session-specific
//   flags (e.g. CLAUDE_CODE_ENTRYPOINT) that could change subprocess behavior
const HARNESS_ENV: Record<string, string> = Object.fromEntries(
  Object.entries({
    ...process.env,
    CLAUDE_CODE_SIMPLE: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }).filter(
    ([k, v]) =>
      // Runtime guard: process.env values can be undefined at runtime despite type inference
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      v !== undefined &&
      !k.startsWith('CLAUDECODE') &&
      !(k.startsWith('CLAUDE_') &&
        k !== 'CLAUDE_CODE_SIMPLE' &&
        k !== 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC' &&
        k !== 'CLAUDE_CONFIG_DIR')
  )
);

/**
 * Spawn a `claude -p` subprocess with stream-json output format.
 *
 * Note: `--verbose` is required when combining `-p` with `--output-format stream-json`.
 * Without it, the CLI errors: "stream-json requires --verbose".
 *
 * @param args - Arguments to pass after `claude` (e.g. ['-p', 'Say hello', '--max-turns', '1'])
 * @param opts.persistSession - When true, omits --no-session-persistence so Claude
 *   can write to the session store (needed for resume round-trip tests).
 */
function spawnClaude(
  args: string[],
  opts: { persistSession?: boolean } = {}
): ChildProcess {
  const extraArgs = opts.persistSession ? [] : ['--no-session-persistence'];
  const child = spawn(CLAUDE_BIN, [...args, '--output-format', 'stream-json', '--verbose', ...extraArgs], {
    env: HARNESS_ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Drain stderr to prevent pipe buffer blocking (64KB limit on Linux).
  // The --verbose flag can produce significant stderr output.
  // stdio: ['ignore', 'pipe', 'pipe'] guarantees stderr is non-null.
  child.stderr.resume();

  return child;
}

/**
 * Collect all stdout lines from a child process, parse each as newline-delimited
 * JSON, and return the parsed messages. Non-JSON lines are silently skipped to
 * handle any preamble or debug output that may precede the JSON stream.
 */
function collectMessages(child: ChildProcess): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const messages: unknown[] = [];
    let buffer = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      // Keep the last (possibly incomplete) line in the buffer
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          messages.push(JSON.parse(trimmed));
        } catch {
          // Skip non-JSON lines (debug output, preamble, etc.)
        }
      }
    });

    child.on('close', () => {
      // Flush any remaining buffered content
      if (buffer.trim()) {
        try {
          messages.push(JSON.parse(buffer.trim()));
        } catch {
          // Skip if not valid JSON
        }
      }
      resolve(messages);
    });

    child.on('error', reject);
  });
}

/**
 * Poll for a condition with retry, avoiding fixed-delay race conditions.
 * Checks every `intervalMs` up to `timeoutMs` total.
 */
async function waitForCondition(
  check: () => boolean,
  timeoutMs: number = 2000,
  intervalMs: number = 100
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise<void>((resolve) => { setTimeout(() => { resolve(); }, intervalMs); });
  }
  return check(); // Final attempt
}

// Opt-out guard: set SKIP_SDK_TESTS=1 to skip these tests without failing.
// The `claude` CLI works with both API keys and subscription login.
describe.skipIf(process.env.SKIP_SDK_TESTS === '1')('SDK Harness', () => {
  // Track spawned processes so afterEach can clean up any that didn't exit naturally.
  const spawnedProcesses: ChildProcess[] = [];

  afterEach(() => {
    for (const child of spawnedProcesses) {
      if (child.exitCode === null && !child.killed) {
        child.kill('SIGTERM');
      }
    }
    spawnedProcesses.length = 0;
  });

  it('spawns claude -p and receives valid JSON stream', async () => {
    const child = spawnClaude(['-p', 'Say hello', '--max-turns', '1']);
    spawnedProcesses.push(child);

    const messages = await collectMessages(child);

    // Must have received at least some messages
    expect(messages.length).toBeGreaterThan(0);

    // Must include an assistant message
    const hasAssistant = messages.some(
      (m) => (m as Record<string, unknown>).type === 'assistant'
    );
    expect(hasAssistant).toBe(true);

    // Must include a result message
    const hasResult = messages.some(
      (m) => (m as Record<string, unknown>).type === 'result'
    );
    expect(hasResult).toBe(true);

    // Result message must report success
    const resultMessage = messages.find(
      (m) => (m as Record<string, unknown>).type === 'result'
    ) as Record<string, unknown> | undefined;
    expect(resultMessage).toBeDefined();
    expect(resultMessage?.subtype).toBe('success');
  });

  it('validates process cleanup after SIGTERM', async () => {
    const child = spawnClaude(['-p', 'Count from 1 to 100 slowly', '--max-turns', '1']);
    spawnedProcesses.push(child);

    // Wait for the first data event before terminating
    await new Promise<void>((resolve) => {
      child.stdout?.once('data', () => { resolve(); });
      // Resolve after a short timeout if no data arrives (process may exit quickly)
      setTimeout(() => { resolve(); }, 5000);
    });

    child.kill('SIGTERM');

    // Wait for the process to exit
    const exitCode = await new Promise<number | null>((resolve) => {
      if (child.exitCode !== null) {
        resolve(child.exitCode);
        return;
      }
      child.on('exit', (code) => { resolve(code); });
    });

    // Process must have exited (exit code is not null after close)
    expect(exitCode).not.toBeNull();

    // Guard: PID must have been assigned
    expect(child.pid).toBeDefined();
    const pid = child.pid as number;

    // Poll for PID cleanup with retry (avoids race condition on slow/loaded systems)
    const pidExited = await waitForCondition(() => {
      try {
        process.kill(pid, 0); // signal 0 = existence check
        return false; // Still running
      } catch {
        return true; // ESRCH = no such process
      }
    });

    expect(pidExited).toBe(true);
  });

  it('validates session resume round-trip', async () => {
    // Phase 1: Plant a memorable word in a new session
    const phase1 = spawnClaude(
      ['-p', 'Remember the word: pineapple', '--max-turns', '1'],
      { persistSession: true }
    );
    spawnedProcesses.push(phase1);

    const phase1Messages = await collectMessages(phase1);

    // Extract session_id from any message in the stream
    const sessionId = phase1Messages
      .map((m) => (m as Record<string, unknown>).session_id)
      .find((id) => typeof id === 'string' && id.length > 0) as string | undefined;

    expect(sessionId).toBeDefined();
    expect(typeof sessionId).toBe('string');

    // Phase 2: Resume the session and ask about the word
    // Note: sessionId is verified as defined by the expect above
    const phase2 = spawnClaude(
      ['-p', 'What word did I ask you to remember?', '--resume', sessionId ?? '', '--max-turns', '1'],
      { persistSession: true }
    );
    spawnedProcesses.push(phase2);

    const phase2Messages = await collectMessages(phase2);

    // Must contain a result message indicating the round-trip completed
    const hasResult = phase2Messages.some(
      (m) => (m as Record<string, unknown>).type === 'result'
    );
    expect(hasResult).toBe(true);

    // Note: persisted sessions are an acceptable trade-off for integration tests.
    // Claude's session store handles its own cleanup. These test sessions are
    // created with --no-session-persistence by default; only the resume test
    // persists (2 sessions per run, ~few KB each).
  });
});
