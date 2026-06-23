import { describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { classifyAgyCliError, extractAgyConversationId } from '../src/services/worker/AgyCliProvider.js';
import { SettingsDefaultsManager } from '../src/shared/SettingsDefaultsManager.js';
import { SettingsRoutes } from '../src/services/worker/http/routes/SettingsRoutes.js';

function writeFakeAgy(path: string, conversationId: string): void {
  writeFileSync(path, `#!/bin/sh
if [ "\${1:-}" = "--version" ]; then
  echo "agy fake ${conversationId}"
  exit 0
fi
printf '%s\n' "$@" > "$CLAUDE_MEM_AGY_ARGS_FILE"
log_path=""
conversation=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --log-file) log_path="$2"; shift 2 ;;
    --conversation) conversation="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [ -z "$conversation" ]; then
  printf 'Created conversation ${conversationId}\n' > "$log_path"
fi
`);
  chmodSync(path, 0o755);
}

describe('AgyCliProvider', () => {
  it('extracts conversation IDs and classifies stable failure modes', () => {
    expect(extractAgyConversationId(
      'I server.go] Created conversation 17b73f60-9ef9-4288-82a1-13b0d0f9d29a\n'
    )).toBe('17b73f60-9ef9-4288-82a1-13b0d0f9d29a');
    expect(extractAgyConversationId('no conversation record')).toBeNull();

    expect(classifyAgyCliError({
      exitCode: 1,
      stderr: 'could not find conversation',
      cause: new Error('missing'),
    }).kind).toBe('session_not_found');
    expect(classifyAgyCliError({
      exitCode: 1,
      stderr: 'RESOURCE_EXHAUSTED quota',
      cause: new Error('quota'),
    }).kind).toBe('quota_exhausted');
    expect(classifyAgyCliError({
      exitCode: 1,
      stderr: 'silent auth failed',
      cause: new Error('auth'),
    }).kind).toBe('auth_invalid');
  });

  it('exposes safe defaults and accepts agy-cli settings', () => {
    expect(SettingsDefaultsManager.get('CLAUDE_MEM_AGY_CLI_MODEL')).toBe('');
    expect(SettingsDefaultsManager.get('CLAUDE_MEM_AGY_CLI_PATH')).toBe('');
    expect(SettingsDefaultsManager.get('CLAUDE_MEM_AGY_CLI_TIMEOUT_MS')).toBe('300000');

    const routes = new SettingsRoutes({} as any) as any;
    expect(routes.validateSettings({
      CLAUDE_MEM_PROVIDER: 'agy-cli',
      CLAUDE_MEM_AGY_CLI_TIMEOUT_MS: '300000',
    })).toEqual({ valid: true });
    expect(routes.validateSettings({
      CLAUDE_MEM_PROVIDER: 'agy-cli',
      CLAUDE_MEM_AGY_CLI_TIMEOUT_MS: '999',
    })).toEqual({
      valid: false,
      error: 'CLAUDE_MEM_AGY_CLI_TIMEOUT_MS must be between 1000 and 3600000',
    });
  });

  it('reports unavailable Agy status and rejects routing instead of falling back to Claude', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-agy-cli-unavailable-'));
    try {
      const dataDir = join(tempDir, 'data');
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({
        CLAUDE_MEM_PROVIDER: 'agy-cli',
        CLAUDE_MEM_AGY_CLI_PATH: join(tempDir, 'missing-agy'),
      }));

      const output = execFileSync(process.execPath, ['--eval', `
        const { getAiProviderStatus } = await import('./src/services/worker-service.ts');
        const { SessionRoutes } = await import('./src/services/worker/http/routes/SessionRoutes.ts');

        const status = getAiProviderStatus();
        const routes = new SessionRoutes(
          undefined, undefined, undefined, undefined, undefined,
          undefined, undefined, undefined, undefined,
        );
        let selectedProvider = null;
        let routingError = null;
        try {
          selectedProvider = routes.getSelectedProvider();
        } catch (error) {
          routingError = error instanceof Error ? error.message : String(error);
        }
        console.log('RESULT ' + JSON.stringify({ status, selectedProvider, routingError }));
      `], {
        cwd: process.cwd(),
        env: { ...process.env, CLAUDE_MEM_DATA_DIR: dataDir },
        encoding: 'utf8',
      });

      const resultLine = output.trim().split('\n').find((line) => line.startsWith('RESULT '));
      expect(resultLine).toBeDefined();
      const result = JSON.parse(resultLine!.slice('RESULT '.length));
      expect(result.status).toEqual({
        provider: 'agy-cli',
        available: false,
        error: 'Agy CLI provider selected but no working executable was found. Install `agy` or set CLAUDE_MEM_AGY_CLI_PATH.',
      });
      expect(result.selectedProvider).toBeNull();
      expect(result.routingError).toBe(result.status.error);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('restores persisted Agy conversations after restart but clears them for SDK providers', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-agy-cli-restart-'));
    try {
      const dataDir = join(tempDir, 'data');
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({
        CLAUDE_MEM_PROVIDER: 'agy-cli',
      }));

      const output = execFileSync(process.execPath, ['--eval', `
        const { writeFileSync } = await import('fs');
        const { join } = await import('path');
        const { SessionManager } = await import('./src/services/worker/SessionManager.ts');

        const dbSession = {
          id: 91,
          content_session_id: 'content-restart',
          memory_session_id: '44444444-4444-4444-8444-444444444444',
          project: 'demo',
          platform_source: 'codex',
          user_prompt: 'continue after restart',
          custom_title: null,
          status: 'active',
        };
        const store = { getPromptNumberFromUserPrompts() { return 2; } };
        const dbManager = {
          getSessionById() { return dbSession; },
          getSessionStore() { return store; },
        };

        const agySession = new SessionManager(dbManager).initializeSession(91, undefined, 2);
        writeFileSync(join(process.env.CLAUDE_MEM_DATA_DIR, 'settings.json'), JSON.stringify({
          CLAUDE_MEM_PROVIDER: 'claude',
        }));
        const claudeSession = new SessionManager(dbManager).initializeSession(91, undefined, 2);

        console.log('RESULT ' + JSON.stringify({
          agyMemorySessionId: agySession.memorySessionId,
          claudeMemorySessionId: claudeSession.memorySessionId,
        }));
      `], {
        cwd: process.cwd(),
        env: { ...process.env, CLAUDE_MEM_DATA_DIR: dataDir },
        encoding: 'utf8',
      });

      const resultLine = output.trim().split('\n').find((line) => line.startsWith('RESULT '));
      expect(resultLine).toBeDefined();
      const result = JSON.parse(resultLine!.slice('RESULT '.length));
      expect(result.agyMemorySessionId).toBe('44444444-4444-4444-8444-444444444444');
      expect(result.claudeMemorySessionId).toBeNull();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('waits for process exit and escalates to SIGKILL when abort is ignored', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-agy-cli-abort-'));
    try {
      const dataDir = join(tempDir, 'data');
      const binDir = join(tempDir, 'bin');
      const pidFile = join(tempDir, 'agy.pid');
      mkdirSync(dataDir, { recursive: true });
      mkdirSync(binDir, { recursive: true });

      const agyPath = join(binDir, 'agy');
      writeFileSync(agyPath, `#!/usr/bin/env node
const { writeFileSync } = require('fs');
if (process.argv.includes('--version')) {
  console.log('agy fake abort');
  process.exit(0);
}
writeFileSync(process.env.CLAUDE_MEM_AGY_PID_FILE, String(process.pid));
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`);
      chmodSync(agyPath, 0o755);
      writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({
        CLAUDE_MEM_PROVIDER: 'agy-cli',
        CLAUDE_MEM_MODE: 'code',
        CLAUDE_MEM_AGY_CLI_PATH: agyPath,
        CLAUDE_MEM_AGY_CLI_TIMEOUT_MS: '10000',
      }));

      const output = execFileSync(process.execPath, ['--eval', `
        const { existsSync, readFileSync } = await import('fs');
        const { setTimeout: sleep } = await import('timers/promises');
        const { ModeManager } = await import('./src/services/domain/ModeManager.ts');
        const { AgyCliProvider } = await import('./src/services/worker/AgyCliProvider.ts');

        ModeManager.getInstance().loadMode('code');
        const session = {
          sessionDbId: 92,
          memorySessionId: null,
          forceInit: false,
          lastPromptNumber: 1,
          project: 'demo',
          contentSessionId: 'content-abort',
          userPrompt: 'abort this turn',
          startTime: Date.now(),
          earliestPendingTimestamp: null,
          abortController: new AbortController(),
          conversationHistory: [],
          cumulativeInputTokens: 0,
          cumulativeOutputTokens: 0,
        };
        const dbManager = {
          getSessionStore() {
            return {
              ensureMemorySessionIdRegistered() {},
              updateMemorySessionId() {},
            };
          },
        };
        const provider = new AgyCliProvider(dbManager, { async *getMessageIterator() {} });
        const run = provider.startSession(session);
        const deadline = Date.now() + 3000;
        while (!existsSync(process.env.CLAUDE_MEM_AGY_PID_FILE) && Date.now() < deadline) {
          await sleep(10);
        }
        if (!existsSync(process.env.CLAUDE_MEM_AGY_PID_FILE)) throw new Error('fake agy did not start');
        const pid = Number(readFileSync(process.env.CLAUDE_MEM_AGY_PID_FILE, 'utf8'));
        const abortAt = Date.now();
        session.abortController.abort();
        let errorName = '';
        try { await run; } catch (error) { errorName = error?.name || ''; }
        const elapsedMs = Date.now() - abortAt;
        let alive = true;
        try { process.kill(pid, 0); } catch { alive = false; }
        console.log('RESULT ' + JSON.stringify({ errorName, elapsedMs, alive }));
      `], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CLAUDE_MEM_DATA_DIR: dataDir,
          CLAUDE_MEM_AGY_PID_FILE: pidFile,
        },
        encoding: 'utf8',
        timeout: 10_000,
      });

      const resultLine = output.trim().split('\n').find((line) => line.startsWith('RESULT '));
      expect(resultLine).toBeDefined();
      const result = JSON.parse(resultLine!.slice('RESULT '.length));
      expect(result.errorName).toBe('AbortError');
      expect(result.elapsedMs).toBeGreaterThanOrEqual(900);
      expect(result.elapsedMs).toBeLessThan(5000);
      expect(result.alive).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('confirms claimed observation and summary messages when Agy returns empty stdout', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-agy-cli-empty-'));
    try {
      const dataDir = join(tempDir, 'data');
      const binDir = join(tempDir, 'bin');
      mkdirSync(dataDir, { recursive: true });
      mkdirSync(binDir, { recursive: true });

      const agyPath = join(binDir, 'agy');
      writeFakeAgy(agyPath, '55555555-5555-4555-8555-555555555555');
      writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({
        CLAUDE_MEM_PROVIDER: 'agy-cli',
        CLAUDE_MEM_MODE: 'code',
        CLAUDE_MEM_AGY_CLI_PATH: agyPath,
        CLAUDE_MEM_AGY_CLI_TIMEOUT_MS: '5000',
      }));

      const output = execFileSync(process.execPath, ['--eval', `
        const { ModeManager } = await import('./src/services/domain/ModeManager.ts');
        const { AgyCliProvider } = await import('./src/services/worker/AgyCliProvider.ts');

        ModeManager.getInstance().loadMode('code');
        const session = {
          sessionDbId: 93,
          memorySessionId: null,
          forceInit: false,
          lastPromptNumber: 1,
          project: 'demo',
          contentSessionId: 'content-empty',
          userPrompt: 'consume empty turns',
          startTime: Date.now(),
          earliestPendingTimestamp: 123,
          abortController: new AbortController(),
          conversationHistory: [],
          cumulativeInputTokens: 0,
          cumulativeOutputTokens: 0,
          consecutiveInvalidOutputs: 0,
        };
        const dbManager = {
          getSessionStore() {
            return {
              ensureMemorySessionIdRegistered() {},
              updateMemorySessionId() {},
            };
          },
        };
        let confirmed = 0;
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
            yield { type: 'summarize', last_assistant_message: 'done' };
          },
          async confirmClaimedMessages() {
            confirmed += 1;
            session.earliestPendingTimestamp = null;
            return 1;
          },
        };

        const provider = new AgyCliProvider(dbManager, sessionManager);
        await provider.startSession(session);
        console.log('RESULT ' + JSON.stringify({
          confirmed,
          earliestPendingTimestamp: session.earliestPendingTimestamp,
        }));
      `], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CLAUDE_MEM_DATA_DIR: dataDir,
          CLAUDE_MEM_AGY_ARGS_FILE: join(tempDir, 'args'),
        },
        encoding: 'utf8',
      });

      const resultLine = output.trim().split('\n').find((line) => line.startsWith('RESULT '));
      expect(resultLine).toBeDefined();
      const result = JSON.parse(resultLine!.slice('RESULT '.length));
      expect(result.confirmed).toBe(2);
      expect(result.earliestPendingTimestamp).toBeNull();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('creates an isolated conversation and re-resolves configured executable changes', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-agy-cli-provider-'));
    try {
      const dataDir = join(tempDir, 'data');
      const binDir = join(tempDir, 'bin');
      mkdirSync(dataDir, { recursive: true });
      mkdirSync(binDir, { recursive: true });

      const firstAgy = join(binDir, 'agy-one');
      const secondAgy = join(binDir, 'agy-two');
      writeFakeAgy(firstAgy, '11111111-1111-4111-8111-111111111111');
      writeFakeAgy(secondAgy, '22222222-2222-4222-8222-222222222222');

      writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({
        CLAUDE_MEM_PROVIDER: 'agy-cli',
        CLAUDE_MEM_MODE: 'code',
        CLAUDE_MEM_AGY_CLI_PATH: firstAgy,
        CLAUDE_MEM_AGY_CLI_MODEL: 'fake-model',
        CLAUDE_MEM_AGY_CLI_TIMEOUT_MS: '5000',
      }));

      const childEnv = {
        ...process.env,
        CLAUDE_MEM_DATA_DIR: dataDir,
        CLAUDE_MEM_AGY_ARGS_FILE: join(tempDir, 'args'),
        CLAUDE_MEM_AGY_SECOND_PATH: secondAgy,
      };

      const output = execFileSync(process.execPath, ['--eval', `
        const { readFileSync, writeFileSync } = await import('fs');
        const { join } = await import('path');
        const { ModeManager } = await import('./src/services/domain/ModeManager.ts');
        const { AgyCliProvider, isAgyCliSelected, isAgyCliAvailable } = await import('./src/services/worker/AgyCliProvider.ts');
        const { findAgyExecutable } = await import('./src/shared/find-agy-executable.ts');

        ModeManager.getInstance().loadMode('code');
        const session = {
          sessionDbId: 42,
          memorySessionId: null,
          forceInit: false,
          lastPromptNumber: 1,
          project: 'demo',
          contentSessionId: 'content-1',
          userPrompt: 'observe this session',
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
        const sessionManager = { async *getMessageIterator() {} };

        const provider = new AgyCliProvider(dbManager, sessionManager);
        await provider.startSession(session);
        const args = readFileSync(process.env.CLAUDE_MEM_AGY_ARGS_FILE, 'utf8');

        writeFileSync(join(process.env.CLAUDE_MEM_DATA_DIR, 'settings.json'), JSON.stringify({
          CLAUDE_MEM_PROVIDER: 'agy-cli',
          CLAUDE_MEM_MODE: 'code',
          CLAUDE_MEM_AGY_CLI_PATH: process.env.CLAUDE_MEM_AGY_SECOND_PATH,
          CLAUDE_MEM_AGY_CLI_TIMEOUT_MS: '5000',
        }));
        const resolvedAfterSettingsChange = findAgyExecutable();
        const available = isAgyCliAvailable();

        writeFileSync(join(process.env.CLAUDE_MEM_DATA_DIR, 'settings.json'), JSON.stringify({
          CLAUDE_MEM_PROVIDER: 'agy-cli',
          CLAUDE_MEM_MODE: 'code',
          CLAUDE_MEM_AGY_CLI_PATH: join(process.env.CLAUDE_MEM_DATA_DIR, 'missing-agy'),
          CLAUDE_MEM_AGY_CLI_TIMEOUT_MS: '5000',
        }));
        const availableAfterInvalidPath = isAgyCliAvailable();

        console.log('RESULT ' + JSON.stringify({
          memorySessionId: session.memorySessionId,
          registered,
          hasAddDir: args.includes('--add-dir'),
          hasConversation: args.includes('--conversation'),
          hasPrint: args.includes('--print'),
          hasModel: args.includes('--model\\nfake-model'),
          selected: isAgyCliSelected(),
          available,
          resolvedAfterSettingsChange,
          availableAfterInvalidPath,
        }));
      `], {
        cwd: process.cwd(),
        env: childEnv,
        encoding: 'utf8',
      });

      const resultLine = output.trim().split('\n').find((line) => line.startsWith('RESULT '));
      expect(resultLine).toBeDefined();
      const result = JSON.parse(resultLine!.slice('RESULT '.length));
      expect(result.memorySessionId).toBe('11111111-1111-4111-8111-111111111111');
      expect(result.registered).toEqual([{
        id: 42,
        mid: '11111111-1111-4111-8111-111111111111',
      }]);
      expect(result.hasAddDir).toBe(true);
      expect(result.hasConversation).toBe(false);
      expect(result.hasPrint).toBe(true);
      expect(result.hasModel).toBe(true);
      expect(result.selected).toBe(true);
      expect(result.available).toBe(true);
      expect(result.resolvedAfterSettingsChange).toBe(secondAgy);
      expect(result.availableAfterInvalidPath).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('re-primes a fresh conversation when a resume target disappears', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-agy-cli-recover-'));
    try {
      const dataDir = join(tempDir, 'data');
      const binDir = join(tempDir, 'bin');
      mkdirSync(dataDir, { recursive: true });
      mkdirSync(binDir, { recursive: true });

      const agyPath = join(binDir, 'agy');
      writeFileSync(agyPath, `#!/bin/sh
if [ "\${1:-}" = "--version" ]; then
  echo "agy fake recover"
  exit 0
fi
printf 'CALL\n' >> "$CLAUDE_MEM_AGY_ARGS_FILE"
printf '%s\n' "$@" >> "$CLAUDE_MEM_AGY_ARGS_FILE"
log_path=""
conversation=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --log-file) log_path="$2"; shift 2 ;;
    --conversation) conversation="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [ -n "$conversation" ] && [ ! -f "$CLAUDE_MEM_RESUME_MARKER" ]; then
  : > "$CLAUDE_MEM_RESUME_MARKER"
  echo "conversation not found" >&2
  exit 1
fi
if [ -z "$conversation" ]; then
  printf 'Created conversation 33333333-3333-4333-8333-333333333333\n' > "$log_path"
fi
`);
      chmodSync(agyPath, 0o755);

      writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({
        CLAUDE_MEM_PROVIDER: 'agy-cli',
        CLAUDE_MEM_MODE: 'code',
        CLAUDE_MEM_AGY_CLI_PATH: agyPath,
        CLAUDE_MEM_AGY_CLI_TIMEOUT_MS: '5000',
      }));

      const childEnv = {
        ...process.env,
        CLAUDE_MEM_DATA_DIR: dataDir,
        CLAUDE_MEM_AGY_ARGS_FILE: join(tempDir, 'args'),
        CLAUDE_MEM_RESUME_MARKER: join(tempDir, 'resume-failed'),
      };

      const output = execFileSync(process.execPath, ['--eval', `
        const { readFileSync } = await import('fs');
        const { ModeManager } = await import('./src/services/domain/ModeManager.ts');
        const { AgyCliProvider } = await import('./src/services/worker/AgyCliProvider.ts');

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
          async confirmClaimedMessages() { return 1; },
        };

        const provider = new AgyCliProvider(dbManager, sessionManager);
        await provider.startSession(session);
        const raw = readFileSync(process.env.CLAUDE_MEM_AGY_ARGS_FILE, 'utf8');
        const calls = raw.split('CALL\\n').map((x) => x.trim()).filter(Boolean).map((call) => {
          const match = call.match(/--conversation\\n([^\\n]+)/);
          return { resume: !!match, conversationId: match ? match[1] : null };
        });
        console.log('RESULT ' + JSON.stringify({ memorySessionId: session.memorySessionId, registered, calls }));
      `], {
        cwd: process.cwd(),
        env: childEnv,
        encoding: 'utf8',
      });

      const resultLine = output.trim().split('\n').find((line) => line.startsWith('RESULT '));
      expect(resultLine).toBeDefined();
      const result = JSON.parse(resultLine!.slice('RESULT '.length));
      expect(result.calls).toEqual([
        { resume: false, conversationId: null },
        { resume: true, conversationId: '33333333-3333-4333-8333-333333333333' },
        { resume: false, conversationId: null },
        { resume: true, conversationId: '33333333-3333-4333-8333-333333333333' },
      ]);
      expect(result.memorySessionId).toBe('33333333-3333-4333-8333-333333333333');
      expect(result.registered).toContainEqual({ id: 7, mid: '33333333-3333-4333-8333-333333333333' });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
