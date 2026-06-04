import { describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';

function writeFakeGemini(path: string, sessionId: string): void {
  writeFileSync(path, `#!/bin/sh
if [ "\${1:-}" = "--version" ]; then
  echo "gemini fake ${sessionId}"
  exit 0
fi
printf '%s\\n' "$@" > "$CLAUDE_MEM_GEMINI_ARGS_FILE"
printf '%s' "\${GEMINI_API_KEY:-}" > "$CLAUDE_MEM_GEMINI_KEY_FILE"
cat >/dev/null
printf '{"session_id":"${sessionId}","response":"","stats":{"models":{}}}'
`);
  chmodSync(path, 0o755);
}

describe('GeminiCliProvider subprocess integration', () => {
  it('starts fresh sessions without --session-id, injects saved API keys, and re-resolves changed configured paths', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-gemini-cli-provider-'));
    try {
      const dataDir = join(tempDir, 'data');
      const binDir = join(tempDir, 'bin');
      mkdirSync(dataDir, { recursive: true });
      mkdirSync(binDir, { recursive: true });

      const firstGemini = join(binDir, 'gemini-one');
      const secondGemini = join(binDir, 'gemini-two');
      writeFakeGemini(firstGemini, 'smoke-session');
      writeFakeGemini(secondGemini, 'second-session');

      const settingsPath = join(dataDir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({
        CLAUDE_MEM_PROVIDER: 'gemini-cli',
        CLAUDE_MEM_MODE: 'code',
        CLAUDE_MEM_GEMINI_CLI_PATH: firstGemini,
        CLAUDE_MEM_GEMINI_CLI_MODEL: 'fake-model',
        CLAUDE_MEM_GEMINI_CLI_TIMEOUT_MS: '5000',
      }));
      writeFileSync(join(dataDir, '.env'), 'GEMINI_API_KEY=saved-smoke-key\n');

      const childEnv = {
        ...process.env,
        CLAUDE_MEM_DATA_DIR: dataDir,
        CLAUDE_MEM_GEMINI_ARGS_FILE: join(tempDir, 'args'),
        CLAUDE_MEM_GEMINI_KEY_FILE: join(tempDir, 'key'),
        CLAUDE_MEM_GEMINI_SECOND_PATH: secondGemini,
      };
      delete childEnv.GEMINI_API_KEY;

      const output = execFileSync(process.execPath, ['--eval', `
        const { readFileSync, writeFileSync } = await import('fs');
        const { join } = await import('path');
        const { ModeManager } = await import('./src/services/domain/ModeManager.ts');
        const { GeminiCliProvider } = await import('./src/services/worker/GeminiCliProvider.ts');
        const { findGeminiExecutable } = await import('./src/shared/find-gemini-executable.ts');

        ModeManager.getInstance().loadMode('code');

        const session = {
          sessionDbId: 42,
          memorySessionId: null,
          abortController: new AbortController(),
          queue: [],
          isProcessing: false,
          conversationHistory: [],
          cumulativeInputTokens: 0,
          cumulativeOutputTokens: 0,
        };
        const registered = [];
        const dbManager = {
          getSessionStore() {
            return {
              ensureMemorySessionIdRegistered(sessionDbId, memorySessionId) {
                registered.push({ sessionDbId, memorySessionId });
              },
            };
          },
        };
        const sessionManager = { async *getMessageIterator() {} };

        const provider = new GeminiCliProvider(dbManager, sessionManager);
        await provider.startSession(session);
        await new Promise((resolve) => setTimeout(resolve, 20));

        const args = readFileSync(process.env.CLAUDE_MEM_GEMINI_ARGS_FILE, 'utf8').trim().split('\\n').filter(Boolean);
        const key = readFileSync(process.env.CLAUDE_MEM_GEMINI_KEY_FILE, 'utf8');

        writeFileSync(join(process.env.CLAUDE_MEM_DATA_DIR, 'settings.json'), JSON.stringify({
          CLAUDE_MEM_PROVIDER: 'gemini-cli',
          CLAUDE_MEM_MODE: 'code',
          CLAUDE_MEM_GEMINI_CLI_PATH: process.env.CLAUDE_MEM_GEMINI_SECOND_PATH,
          CLAUDE_MEM_GEMINI_CLI_MODEL: 'fake-model',
          CLAUDE_MEM_GEMINI_CLI_TIMEOUT_MS: '5000',
        }));
        const resolvedAfterSettingsChange = findGeminiExecutable();

        console.log('RESULT ' + JSON.stringify({
          memorySessionId: session.memorySessionId,
          registered,
          hasSessionIdFlag: args.includes('--session-id'),
          hasResumeFlag: args.includes('--resume'),
          key,
          resolvedAfterSettingsChange,
        }));
      `], {
        cwd: process.cwd(),
        env: childEnv,
        encoding: 'utf8',
      });

      const resultLine = output.trim().split('\n').find((line) => line.startsWith('RESULT '));
      expect(resultLine).toBeDefined();
      const result = JSON.parse(resultLine!.slice('RESULT '.length));

      expect(result.memorySessionId).toBe('smoke-session');
      expect(result.registered).toEqual([{ sessionDbId: 42, memorySessionId: 'smoke-session' }]);
      expect(result.hasSessionIdFlag).toBe(false);
      expect(result.hasResumeFlag).toBe(false);
      expect(result.key).toBe('saved-smoke-key');
      expect(result.resolvedAfterSettingsChange).toBe(secondGemini);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('re-primes a fresh gemini session when --resume finds none, then resumes with the real prompt', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-gemini-cli-recover-'));
    try {
      const dataDir = join(tempDir, 'data');
      const binDir = join(tempDir, 'bin');
      mkdirSync(dataDir, { recursive: true });
      mkdirSync(binDir, { recursive: true });

      // Fake gemini: logs every invocation's args (one line per call) and fails
      // the FIRST `--resume` with a session-not-found error (gated by a marker
      // file) so the provider's recovery path triggers on the observation turn.
      const geminiPath = join(binDir, 'gemini');
      writeFileSync(geminiPath, `#!/bin/sh
if [ "\${1:-}" = "--version" ]; then
  echo "gemini fake recover"
  exit 0
fi
printf '%s ' "$@" >> "$CLAUDE_MEM_GEMINI_ARGS_FILE"
printf '\\n' >> "$CLAUDE_MEM_GEMINI_ARGS_FILE"
cat >/dev/null
case " $* " in
  *' --resume '*)
    if [ ! -f "$CLAUDE_MEM_RESUME_MARKER" ]; then
      : > "$CLAUDE_MEM_RESUME_MARKER"
      echo "Error: could not find session" >&2
      exit 1
    fi
    ;;
esac
printf '{"session_id":"sess","response":"","stats":{"models":{}}}'
`);
      chmodSync(geminiPath, 0o755);

      writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({
        CLAUDE_MEM_PROVIDER: 'gemini-cli',
        CLAUDE_MEM_MODE: 'code',
        CLAUDE_MEM_GEMINI_CLI_PATH: geminiPath,
        CLAUDE_MEM_GEMINI_CLI_MODEL: 'fake-model',
        CLAUDE_MEM_GEMINI_CLI_TIMEOUT_MS: '5000',
      }));

      const childEnv = {
        ...process.env,
        CLAUDE_MEM_DATA_DIR: dataDir,
        CLAUDE_MEM_GEMINI_ARGS_FILE: join(tempDir, 'args'),
        CLAUDE_MEM_RESUME_MARKER: join(tempDir, 'resume-failed'),
      };
      delete childEnv.GEMINI_API_KEY;

      const output = execFileSync(process.execPath, ['--eval', `
        const { readFileSync } = await import('fs');
        const { ModeManager } = await import('./src/services/domain/ModeManager.ts');
        const { GeminiCliProvider } = await import('./src/services/worker/GeminiCliProvider.ts');

        ModeManager.getInstance().loadMode('code');

        const session = {
          sessionDbId: 7,
          memorySessionId: null,
          forceInit: false,
          lastPromptNumber: 1,
          project: 'demo',
          contentSessionId: 'content-1',
          userPrompt: 'do the thing',
          startTime: Date.now(),
          earliestPendingTimestamp: null,
          abortController: new AbortController(),
          conversationHistory: [],
          cumulativeInputTokens: 0,
          cumulativeOutputTokens: 0,
        };
        const registered = [];
        const dbManager = {
          getSessionStore() {
            return {
              ensureMemorySessionIdRegistered(id, mid) { registered.push({ id, mid }); },
              updateMemorySessionId() {},
            };
          },
        };
        const sessionManager = {
          async *getMessageIterator() {
            yield {
              type: 'observation',
              tool_name: 'Read',
              tool_input: { file_path: '/x' },
              tool_response: { ok: true },
              prompt_number: 2,
              cwd: '/tmp',
              agentId: null,
              agentType: null,
            };
          },
        };

        const provider = new GeminiCliProvider(dbManager, sessionManager);
        await provider.startSession(session);

        const raw = readFileSync(process.env.CLAUDE_MEM_GEMINI_ARGS_FILE, 'utf8');
        const calls = raw.split('\\n').map((l) => l.trim()).filter(Boolean).map((l) => {
          const m = l.match(/--resume (\\S+)/);
          return { resume: !!m, resumeId: m ? m[1] : null };
        });

        console.log('RESULT ' + JSON.stringify({
          memorySessionId: session.memorySessionId,
          registered,
          calls,
        }));
      `], {
        cwd: process.cwd(),
        env: childEnv,
        encoding: 'utf8',
      });

      const resultLine = output.trim().split('\n').find((line) => line.startsWith('RESULT '));
      expect(resultLine).toBeDefined();
      const result = JSON.parse(resultLine!.slice('RESULT '.length));

      // Expected gemini invocations, in order:
      //   0: init turn          — no --resume, captures the session id
      //   1: observation resume — --resume sess, fails (session not found)
      //   2: recovery re-prime  — no --resume, re-establishes the session  ← the fix
      //   3: observation resume — --resume sess, now on the primed session
      // Without the re-priming fix there are only 3 calls and the observation
      // prompt lands on an un-primed fresh session (call 2 carries it directly).
      expect(result.calls.length).toBe(4);
      expect(result.calls[0].resume).toBe(false);
      expect(result.calls[1]).toEqual({ resume: true, resumeId: 'sess' });
      expect(result.calls[2].resume).toBe(false);
      expect(result.calls[3]).toEqual({ resume: true, resumeId: 'sess' });
      expect(result.memorySessionId).toBe('sess');
      expect(result.registered).toContainEqual({ id: 7, mid: 'sess' });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
