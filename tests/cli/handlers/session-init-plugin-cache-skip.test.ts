import { describe, expect, it } from 'bun:test';

const PLUGINS_DIR_NAME = 'plugins';
const PLUGIN_CACHE_DIR_NAME = 'cache';
const CLAUDE_MEM_PLUGIN_OWNER = 'thedotmack';
const CLAUDE_MEM_PLUGIN_NAME = 'claude-mem';
const PLUGIN_VERSION_DIR_NAME = '13.12.4';

describe('sessionInitHandler plugin cache self-capture guard', () => {
  it('skips session init when the SDK hook cwd is inside the installed plugin cache', async () => {
    const env = { ...process.env };
    delete env.CLAUDE_MEM_INTERNAL;

    const script = `
      const { join } = await import('path');
      const { CLAUDE_CONFIG_DIR } = await import('./src/shared/paths.ts');
      const { sessionInitHandler, setSessionInitDependenciesForTesting } = await import('./src/cli/handlers/session-init.ts');
      const workerCalls = [];

      setSessionInitDependenciesForTesting({
        loadFromFileOnce: () => ({
          CLAUDE_MEM_EXCLUDED_PROJECTS: '',
          CLAUDE_MEM_RUNTIME: 'worker',
          CLAUDE_MEM_SEMANTIC_INJECT: 'false',
          CLAUDE_MEM_SEMANTIC_INJECT_LIMIT: '7',
        }),
        resolveRuntimeContext: () => ({ runtime: 'worker' }),
        executeWithWorkerFallback: async (apiPath, method, body) => {
          workerCalls.push({ apiPath, method, body });
          return { sessionDbId: 42, promptNumber: 1 };
        },
        isWorkerFallback: () => false,
      });

      const cwd = join(
        CLAUDE_CONFIG_DIR,
        ${JSON.stringify(PLUGINS_DIR_NAME)},
        ${JSON.stringify(PLUGIN_CACHE_DIR_NAME)},
        ${JSON.stringify(CLAUDE_MEM_PLUGIN_OWNER)},
        ${JSON.stringify(CLAUDE_MEM_PLUGIN_NAME)},
        ${JSON.stringify(PLUGIN_VERSION_DIR_NAME)},
      );
      const result = await sessionInitHandler.execute({
        sessionId: 'observer-sdk-session',
        cwd,
        platform: 'claude-code',
        prompt: 'observer prompt',
      });

      if (!result.continue || !result.suppressOutput) {
        throw new Error('unexpected result ' + JSON.stringify(result));
      }
      if (workerCalls.length !== 0) {
        throw new Error('worker should not be called: ' + JSON.stringify(workerCalls));
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
