// SPDX-License-Identifier: Apache-2.0
//
// Working-memory injection in the session-init (UserPromptSubmit) handler.
// Uses the same subprocess pattern as session-init-semantic-global-limit.test.ts:
// the handler is driven with injected dependencies and the worker is mocked.

import { afterAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { logger } from '../../src/utils/logger.js';

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

const LONG_PROMPT = 'Please continue debugging the failing worker route from earlier.';

function runSessionInit(workingBehavior: string): { exitCode: number | null; stdout: string; stderr: string } {
  const env = { ...process.env };
  delete env.CLAUDE_MEM_INTERNAL;
  const script = `
    const { sessionInitHandler, setSessionInitDependenciesForTesting } = await import('./src/cli/handlers/session-init.ts');
    setSessionInitDependenciesForTesting({
      loadFromFileOnce: () => ({ CLAUDE_MEM_EXCLUDED_PROJECTS: '', CLAUDE_MEM_WORKING_ENABLED: 'true' }),
      resolveRuntimeContext: () => ({ runtime: 'worker' }),
      shouldTrackProject: () => true,
      executeWithWorkerFallback: async (apiPath, method, body) => {
        if (apiPath === '/api/sessions/init') return { sessionDbId: 7, promptNumber: 3 };
        if (apiPath.startsWith('/api/working')) {
          ${workingBehavior}
        }
        throw new Error('Unexpected worker call: ' + apiPath);
      },
      isWorkerFallback: () => false,
    });
    const result = await sessionInitHandler.execute({
      sessionId: 'session-working-inject',
      cwd: '/tmp/session-init-working-test',
      platform: 'claude',
      prompt: ${JSON.stringify(LONG_PROMPT)},
    });
    process.stdout.write(JSON.stringify({ result }));
  `;

  const run = Bun.spawnSync({
    cmd: [process.execPath, '--eval', script],
    cwd: process.cwd(),
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  return {
    exitCode: run.exitCode,
    stdout: new TextDecoder().decode(run.stdout),
    stderr: new TextDecoder().decode(run.stderr),
  };
}

function parseResult(stdout: string): any {
  return JSON.parse(stdout).result;
}

describe('sessionInitHandler working-memory injection', () => {
  it('injects the rendered block when entries exist', () => {
    const behavior = `return {
      entries: [{
        id: 1, project: 'session-init-working-test', task_key: 'default', key: 'hypothesis',
        kind: 'intent', value: 'route order bug', source: 'agent',
        created_at_epoch: 0, updated_at_epoch: 0, expires_at_epoch: 9999999999999
      }, {
        id: 2, project: 'session-init-working-test', task_key: 'default', key: 'journal:1',
        kind: 'journal', value: 'Read src/routes.ts', source: 'observer',
        created_at_epoch: 0, updated_at_epoch: 0, expires_at_epoch: 9999999999999
      }],
      tokens: 5, limits: { maxKeys: 8, maxTokens: 1000, journalSize: 5, ttlDays: 7 }
    };`;
    const run = runSessionInit(behavior);

    expect(run.stderr).toBe('');
    expect(run.exitCode).toBe(0);

    const result = parseResult(run.stdout);
    const additional = result.hookSpecificOutput.additionalContext as string;
    expect(additional).toContain('## Working Memory — task: default');
    expect(additional).toContain('- [intent] hypothesis: route order bug');
    expect(additional).toContain('- [journal] Read src/routes.ts');
  });

  it('injects the empty-set reminder when the set is empty and the prompt is substantial', () => {
    const run = runSessionInit(`return { entries: [], tokens: 0, limits: { maxKeys: 8, maxTokens: 1000, journalSize: 5, ttlDays: 7 } };`);

    expect(run.stderr).toBe('');
    expect(run.exitCode).toBe(0);

    const result = parseResult(run.stdout);
    expect(result.hookSpecificOutput.additionalContext).toContain(
      'Working memory is empty — record your current hypothesis/plan via working_set'
    );
  });

  it('is fail-open: a worker error leaves the hook result intact', () => {
    const run = runSessionInit(`throw new Error('worker exploded');`);

    expect(run.exitCode).toBe(0);

    const result = parseResult(run.stdout);
    expect(result.continue).toBe(true);
    expect(result.hookSpecificOutput).toBeUndefined();
  });

  it('skips the reminder for short prompts', () => {
    const env = { ...process.env };
    delete env.CLAUDE_MEM_INTERNAL;
    const script = `
      const { sessionInitHandler, setSessionInitDependenciesForTesting } = await import('./src/cli/handlers/session-init.ts');
      setSessionInitDependenciesForTesting({
        loadFromFileOnce: () => ({ CLAUDE_MEM_EXCLUDED_PROJECTS: '', CLAUDE_MEM_WORKING_ENABLED: 'true' }),
        resolveRuntimeContext: () => ({ runtime: 'worker' }),
        shouldTrackProject: () => true,
        executeWithWorkerFallback: async (apiPath) => {
          if (apiPath === '/api/sessions/init') return { sessionDbId: 7, promptNumber: 3 };
          if (apiPath.startsWith('/api/working')) return { entries: [], tokens: 0, limits: {} };
          throw new Error('Unexpected worker call: ' + apiPath);
        },
        isWorkerFallback: () => false,
      });
      const result = await sessionInitHandler.execute({
        sessionId: 'session-working-short',
        cwd: '/tmp/session-init-working-test',
        platform: 'claude',
        prompt: 'short',
      });
      process.stdout.write(JSON.stringify({ result }));
    `;
    const run = Bun.spawnSync({
      cmd: [process.execPath, '--eval', script],
      cwd: process.cwd(),
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(run.exitCode).toBe(0);
    const result = JSON.parse(new TextDecoder().decode(run.stdout)).result;
    expect(result.continue).toBe(true);
    expect(result.hookSpecificOutput).toBeUndefined();
  });
});
