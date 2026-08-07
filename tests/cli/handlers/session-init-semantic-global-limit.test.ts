import { afterAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { logger } from '../../../src/utils/logger.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

const originalInternalEnv = process.env.CLAUDE_MEM_INTERNAL;

beforeEach(() => {
  delete process.env.CLAUDE_MEM_INTERNAL;
  loggerSpies.forEach(spy => spy.mockRestore());
  loggerSpies = [
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
    spyOn(logger, 'failure').mockImplementation(() => {}),
  ];
});

afterAll(() => {
  if (originalInternalEnv === undefined) {
    delete process.env.CLAUDE_MEM_INTERNAL;
  } else {
    process.env.CLAUDE_MEM_INTERNAL = originalInternalEnv;
  }
  loggerSpies.forEach(spy => spy.mockRestore());
});

function runSessionInit(settings: Record<string, string>): { exitCode: number | null; stdout: string; stderr: string } {
  const env = { ...process.env };
  delete env.CLAUDE_MEM_INTERNAL;
  const prompt = 'Please restore the cross-project Palantir knowledge for this session.';
  const script = `
    const workerCallLog = [];
    const { sessionInitHandler, setSessionInitDependenciesForTesting } = await import('./src/cli/handlers/session-init.ts');
    setSessionInitDependenciesForTesting({
      loadFromFileOnce: () => (${JSON.stringify(settings)}),
      resolveRuntimeContext: () => ({ runtime: 'worker' }),
      shouldTrackProject: () => true,
      executeWithWorkerFallback: async (apiPath, method, body) => {
        workerCallLog.push({ path: apiPath, method, body });
        if (apiPath === '/api/sessions/init') return { sessionDbId: 42, promptNumber: 1 };
        if (apiPath.startsWith('/api/context/inject')) return '';
        if (apiPath === '/api/context/semantic') {
          return { context: 'project context', count: 1, globalContext: 'global context section', globalCount: 2 };
        }
        throw new Error('Unexpected worker call: ' + apiPath);
      },
      isWorkerFallback: () => false,
    });
    const result = await sessionInitHandler.execute({
      sessionId: 'session-semantic-global',
      cwd: '/tmp/session-init-semantic-global-test',
      platform: 'kimi',
      prompt: ${JSON.stringify(prompt)},
    });
    const semanticCall = workerCallLog.find(call => call.path === '/api/context/semantic');
    if (!semanticCall) throw new Error('semantic call missing: ' + JSON.stringify(workerCallLog));
    process.stdout.write(JSON.stringify({ semanticBody: semanticCall.body, result }));
  `;

  const result = Bun.spawnSync({
    cmd: [process.execPath, '--eval', script],
    cwd: process.cwd(),
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

const BASE_SETTINGS = {
  CLAUDE_MEM_EXCLUDED_PROJECTS: '',
  CLAUDE_MEM_RUNTIME: 'worker',
  CLAUDE_MEM_SEMANTIC_INJECT: 'true',
  CLAUDE_MEM_SEMANTIC_INJECT_LIMIT: '7',
};

describe('sessionInitHandler cross-project semantic injection', () => {
  it('passes CLAUDE_MEM_SEMANTIC_INJECT_GLOBAL_LIMIT through to the worker and appends globalContext', () => {
    const run = runSessionInit({ ...BASE_SETTINGS, CLAUDE_MEM_SEMANTIC_INJECT_GLOBAL_LIMIT: '3' });

    expect(run.stderr).toBe('');
    expect(run.exitCode).toBe(0);

    const { semanticBody, result } = JSON.parse(run.stdout);
    expect(semanticBody.globalLimit).toBe('3');
    expect(semanticBody.limit).toBe('7');
    expect(result.hookSpecificOutput.additionalContext).toContain('project context');
    expect(result.hookSpecificOutput.additionalContext).toContain('global context section');
    // Global section rides after the project section, never merged into it.
    const additional = result.hookSpecificOutput.additionalContext as string;
    expect(additional.indexOf('project context')).toBeLessThan(additional.indexOf('global context section'));
  });

  it('defaults globalLimit to 0 when the setting is absent', () => {
    const run = runSessionInit({ ...BASE_SETTINGS });

    expect(run.stderr).toBe('');
    expect(run.exitCode).toBe(0);

    const { semanticBody } = JSON.parse(run.stdout);
    expect(semanticBody.globalLimit).toBe('0');
  });
});
