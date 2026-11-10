import { describe, expect, it } from 'bun:test';
import { HOOK_TIMEOUTS } from '../../../src/shared/hook-constants.js';

const SESSION_INIT_TIMEOUT_MS = HOOK_TIMEOUTS.SESSION_INIT_REQUEST;

describe('sessionInitHandler semantic injection platform source', () => {
  it('includes normalized platformSource in semantic context request payload', async () => {
    const env = { ...process.env };
    delete env.CLAUDE_MEM_INTERNAL;
    const prompt = 'Please restore the platform-specific context for semantic injection.';
    const script = `
      const workerCallLog = [];
      const { sessionInitHandler, setSessionInitDependenciesForTesting } = await import('./src/cli/handlers/session-init.ts');
      setSessionInitDependenciesForTesting({
        loadFromFileOnce: () => ({
          CLAUDE_MEM_EXCLUDED_PROJECTS: '',
          CLAUDE_MEM_RUNTIME: 'worker',
          CLAUDE_MEM_SEMANTIC_INJECT: 'true',
          CLAUDE_MEM_SEMANTIC_INJECT_LIMIT: '7',
        }),
        resolveRuntimeContext: () => ({ runtime: 'worker' }),
        // Stubbed with its siblings: the real reader touches settings.json,
        // which prints a creation notice on stderr in a fresh data dir.
        getSessionInitRequestTimeoutMs: () => ${SESSION_INIT_TIMEOUT_MS},
        shouldTrackProject: () => true,
        executeWithWorkerFallback: async (apiPath, method, body, options) => {
          workerCallLog.push({ path: apiPath, method, body, options });
          if (apiPath === '/api/sessions/init') return { sessionDbId: 42, promptNumber: 1 };
          if (apiPath === '/api/context/semantic') return { context: 'semantic context', count: 1 };
          throw new Error('Unexpected worker call: ' + apiPath);
        },
        isWorkerFallback: () => false,
      });
      const result = await sessionInitHandler.execute({
        sessionId: 'session-semantic-platform',
        cwd: '/tmp/session-init-semantic-platform-test',
        platform: 'codex-cli',
        prompt: ${JSON.stringify(prompt)},
      });
      const semanticCall = workerCallLog.find(call => call.path === '/api/context/semantic');
      const initCall = workerCallLog.find(call => call.path === '/api/sessions/init');
      if (!result.continue || !result.suppressOutput) throw new Error('unexpected result ' + JSON.stringify(result));
      if (!semanticCall) throw new Error('semantic call missing: ' + JSON.stringify(workerCallLog));
      if (!initCall) throw new Error('init call missing: ' + JSON.stringify(workerCallLog));
      if (semanticCall.method !== 'POST') throw new Error('semantic method mismatch: ' + semanticCall.method);
      const body = semanticCall.body;
      if (body.q !== ${JSON.stringify(prompt)} || body.limit !== '7' || body.platformSource !== 'codex') {
        throw new Error('semantic body mismatch: ' + JSON.stringify(body));
      }
      const expectedOptions = JSON.stringify({ workerStartupTimeoutMs: 15000, timeoutMs: 2000 });
      if (JSON.stringify(initCall.options) !== expectedOptions || JSON.stringify(semanticCall.options) !== expectedOptions) {
        throw new Error('Codex hook options mismatch: ' + JSON.stringify(workerCallLog));
      }
    `;

    const result = Bun.spawnSync({
      cmd: [process.execPath, '--eval', script],
      cwd: process.cwd(),
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(new TextDecoder().decode(result.stderr)).toBe('');
    expect(new TextDecoder().decode(result.stdout)).toBe('');
    expect(result.exitCode).toBe(0);
  });
});
