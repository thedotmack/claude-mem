// The UserPromptSubmit hook stamps the prompt's source time, and the
// transcript anchor forwards its line's own time (null when it has none), so
// the worker can tell new work in a deleted session from content that
// predates the deletion. Runs in its own process: other suites mock this module.
import { describe, expect, it } from 'bun:test';

describe('session-init sends eventOccurredAtEpochMs', () => {
  it('stamps the hook clock for a live hook and forwards the transcript line time unchanged', () => {
    const script = `
      const initBodies = [];
      const { sessionInitHandler, recordSessionPrompt, setSessionInitDependenciesForTesting } = await import('./src/cli/handlers/session-init.ts');
      setSessionInitDependenciesForTesting({
        loadFromFileOnce: () => ({ CLAUDE_MEM_EXCLUDED_PROJECTS: '', CLAUDE_MEM_RUNTIME: 'worker',
          CLAUDE_MEM_SEMANTIC_INJECT: 'false', CLAUDE_MEM_SEMANTIC_INJECT_LIMIT: '5' }),
        resolveRuntimeContext: () => ({ runtime: 'worker' }),
        shouldTrackProject: () => true,
        getSessionInitRequestTimeoutMs: () => 12000,
        executeWithWorkerFallback: async (apiPath, method, body) => {
          if (apiPath === '/api/sessions/init') initBodies.push(body);
          return { sessionDbId: 42, promptNumber: 1 };
        },
        isWorkerFallback: () => false,
      });
      const before = Date.now();
      await sessionInitHandler.execute({ sessionId: 'hook', cwd: process.cwd(), platform: 'claude-code', prompt: 'hello' });
      const after = Date.now();
      await recordSessionPrompt({ sessionId: 'line', cwd: process.cwd(), platform: 'codex', prompt: 'timed', eventOccurredAtEpochMs: 1234 });
      await recordSessionPrompt({ sessionId: 'untimed', cwd: process.cwd(), platform: 'codex', prompt: 'untimed', eventOccurredAtEpochMs: null });
      const [hook, line, untimed] = initBodies.map(body => body.eventOccurredAtEpochMs);
      if (!(typeof hook === 'number' && hook >= before && hook <= after)) throw new Error('hook time ' + hook);
      if (line !== 1234) throw new Error('line time ' + line);
      if (untimed !== null) throw new Error('untimed ' + untimed);
    `;
    const result = Bun.spawnSync({
      cmd: [process.execPath, '--eval', script],
      cwd: process.cwd(),
      env: { ...process.env, CLAUDE_MEM_INTERNAL: undefined },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(new TextDecoder().decode(result.stderr)).toBe('');
    expect(result.exitCode).toBe(0);
  });
});
