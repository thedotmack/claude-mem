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
});
