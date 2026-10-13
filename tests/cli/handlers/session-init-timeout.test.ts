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
      if (typeof initCall.options?.timeoutMs !== 'number' || initCall.options.timeoutMs <= 0 || initCall.options.timeoutMs > ${SESSION_INIT_REQUEST_TIMEOUT_MS}) {
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

  it('passes the dedicated session-init timeout to the server runtime request (#3434)', () => {
    const env = { ...process.env };
    delete env.CLAUDE_MEM_INTERNAL;
    const script = `
      const serverCalls = [];
      const { sessionInitHandler, setSessionInitDependenciesForTesting } = await import('./src/cli/handlers/session-init.ts');
      setSessionInitDependenciesForTesting({
        loadFromFileOnce: () => ({
          CLAUDE_MEM_EXCLUDED_PROJECTS: '',
          CLAUDE_MEM_RUNTIME: 'server',
          CLAUDE_MEM_SEMANTIC_INJECT: 'false',
          CLAUDE_MEM_SEMANTIC_INJECT_LIMIT: '5',
        }),
        resolveRuntimeContext: () => ({
          runtime: 'server',
          projectId: 'server-project-1',
          serverBaseUrl: 'http://server.test',
          client: {
            startSession: async (input, options) => {
              serverCalls.push({ input, options });
              return { session: { id: 'server-session-1' } };
            },
          },
        }),
        shouldTrackProject: () => true,
        getSessionInitRequestTimeoutMs: () => ${SESSION_INIT_REQUEST_TIMEOUT_MS},
        executeWithWorkerFallback: async () => {
          throw new Error('worker fallback should not be called in server success path');
        },
        isWorkerFallback: () => false,
        logServerFallback: () => {},
      });
      await sessionInitHandler.execute({
        sessionId: 'server-session-init-timeout',
        cwd: '/tmp/server-session-init-timeout-test',
        platform: 'claude-code',
        prompt: 'Please initialize the server runtime without blocking the prompt loop.',
      });
      if (serverCalls.length !== 1) throw new Error('server startSession count mismatch: ' + serverCalls.length);
      if (serverCalls[0].options?.timeoutMs !== Math.floor(${SESSION_INIT_REQUEST_TIMEOUT_MS} / 2)) {
        throw new Error('server timeout mismatch: ' + JSON.stringify(serverCalls[0].options));
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

  it('keeps Codex bounded startup but caps its request at the prompt budget (#3434)', () => {
    const env = { ...process.env };
    delete env.CLAUDE_MEM_INTERNAL;
    const script = `
      const workerCalls = [];
      let budgetMs = 500;
      const { HOOK_TIMEOUTS } = await import('./src/shared/hook-constants.ts');
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
        getSessionInitRequestTimeoutMs: () => budgetMs,
        executeWithWorkerFallback: async (apiPath, method, body, options) => {
          workerCalls.push({ apiPath, options });
          return { sessionDbId: 42, promptNumber: 1 };
        },
        isWorkerFallback: () => false,
      });
      // This test checks the timeout arguments at the 500 ms minimum budget.
      // Keep elapsed time deterministic; one wall-clock tick would skip the call.
      Date.now = () => 1000;
      const runCodexPrompt = async (sessionId) => {
        await sessionInitHandler.execute({
          sessionId,
          cwd: '/tmp/codex-session-init-budget-test',
          platform: 'codex',
          prompt: 'Please initialize this Codex session inside the configured budget.',
        });
        const initCall = workerCalls.filter(call => call.apiPath === '/api/sessions/init').pop();
        if (!initCall) throw new Error('codex init call missing');
        if (initCall.options?.workerStartupTimeoutMs !== HOOK_TIMEOUTS.POST_SPAWN_WAIT) {
          throw new Error('codex lost its bounded startup: ' + JSON.stringify(initCall.options));
        }
        return initCall.options.timeoutMs;
      };

      const shortBudgetRequestMs = await runCodexPrompt('codex-short-budget');
      if (typeof shortBudgetRequestMs !== 'number' || shortBudgetRequestMs <= 0 || shortBudgetRequestMs > 500) {
        throw new Error('codex request outlived a 500 ms budget: ' + shortBudgetRequestMs);
      }
      budgetMs = 10000;
      const defaultBudgetRequestMs = await runCodexPrompt('codex-default-budget');
      if (defaultBudgetRequestMs !== 2000) {
        throw new Error('codex default request timeout changed: ' + defaultBudgetRequestMs);
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

  it('does not reset the full timeout budget after server fallback (#3434)', () => {
    const env = { ...process.env };
    delete env.CLAUDE_MEM_INTERNAL;
    const fallbackTimeoutMs = 8000;
    const script = `
      const workerCalls = [];
      const serverCalls = [];
      const { sessionInitHandler, setSessionInitDependenciesForTesting } = await import('./src/cli/handlers/session-init.ts');
      const { ServerClientError } = await import('./src/services/hooks/server-client.ts');
      setSessionInitDependenciesForTesting({
        loadFromFileOnce: () => ({
          CLAUDE_MEM_EXCLUDED_PROJECTS: '',
          CLAUDE_MEM_RUNTIME: 'server',
          CLAUDE_MEM_SEMANTIC_INJECT: 'false',
          CLAUDE_MEM_SEMANTIC_INJECT_LIMIT: '5',
        }),
        resolveRuntimeContext: () => ({
          runtime: 'server',
          projectId: 'server-project-1',
          serverBaseUrl: 'http://server.test',
          client: {
            startSession: async (input, options) => {
              serverCalls.push({ input, options });
              await new Promise(resolve => setTimeout(resolve, 50));
              throw new ServerClientError('timeout', 'simulated server timeout');
            },
          },
        }),
        shouldTrackProject: () => true,
        getSessionInitRequestTimeoutMs: () => ${fallbackTimeoutMs},
        executeWithWorkerFallback: async (apiPath, method, body, options) => {
          workerCalls.push({ apiPath, method, body, options });
          return { sessionDbId: 42, promptNumber: 1 };
        },
        isWorkerFallback: () => false,
        logServerFallback: () => {},
      });
      await sessionInitHandler.execute({
        sessionId: 'server-fallback-budget',
        cwd: '/tmp/server-fallback-budget-test',
        platform: 'claude-code',
        prompt: 'Please initialize through server fallback without exceeding the host deadline.',
      });
      if (serverCalls[0].options?.timeoutMs !== Math.floor(${fallbackTimeoutMs} / 2)) {
        throw new Error('server timeout mismatch: ' + JSON.stringify(serverCalls[0].options));
      }
      const initCall = workerCalls.find(call => call.apiPath === '/api/sessions/init');
      if (!initCall) throw new Error('worker init call missing');
      if (typeof initCall.options?.timeoutMs !== 'number' || initCall.options.timeoutMs <= 0 || initCall.options.timeoutMs >= ${fallbackTimeoutMs}) {
        throw new Error('worker fallback timeout reused full budget: ' + JSON.stringify(initCall.options));
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
