import { describe, expect, it } from 'bun:test';

const SESSION_INIT_REQUEST_TIMEOUT_MS = 12000;

describe('sessionInitHandler request timeout', () => {
  it('passes the dedicated session-init timeout to the worker request (#3434)', () => {
    const env = { ...process.env };
    delete env.CLAUDE_MEM_INTERNAL;
    const script = `
      const workerCallLog = [];
      const { sessionInitHandler, setSessionInitDependenciesForTesting } = await import('./src/cli/handlers/session-init.ts');
      setSessionInitDependenciesForTesting({
        loadFromFileOnce: () => ({
          CLAUDE_MEM_EXCLUDED_PROJECTS: '',
          CLAUDE_MEM_RUNTIME: 'worker',
          CLAUDE_MEM_SEMANTIC_INJECT: 'false',
          CLAUDE_MEM_SEMANTIC_INJECT_LIMIT: '5',
        }),
        resolveRuntimeContext: () => ({ runtime: 'worker' }),
        shouldTrackProject: () => true,
        getSessionInitRequestTimeoutMs: () => ${SESSION_INIT_REQUEST_TIMEOUT_MS},
        executeWithWorkerFallback: async (apiPath, method, body, options) => {
          workerCallLog.push({ path: apiPath, method, body, options });
          return { sessionDbId: 42, promptNumber: 1 };
        },
        isWorkerFallback: () => false,
      });
      await sessionInitHandler.execute({
        sessionId: 'session-init-timeout',
        cwd: '/tmp/session-init-timeout-test',
        platform: 'claude-code',
        prompt: 'Please initialize this session without blocking the prompt loop.',
      });
      const initCall = workerCallLog.find(call => call.path === '/api/sessions/init');
      if (!initCall) throw new Error('session init worker call missing');
      if (initCall.options?.timeoutMs !== ${SESSION_INIT_REQUEST_TIMEOUT_MS}) {
        throw new Error('timeout mismatch: ' + JSON.stringify(initCall.options));
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
