import { afterEach, describe, expect, it } from 'bun:test';
import { join } from 'path';
import { CLAUDE_CONFIG_DIR } from '../../../src/shared/paths.js';
import {
  sessionInitHandler,
  setSessionInitDependenciesForTesting,
} from '../../../src/cli/handlers/session-init.js';

const PLUGINS_DIR_NAME = 'plugins';
const PLUGIN_CACHE_DIR_NAME = 'cache';
const CLAUDE_MEM_PLUGIN_OWNER = 'thedotmack';
const CLAUDE_MEM_PLUGIN_NAME = 'claude-mem';
const PLUGIN_VERSION_DIR_NAME = '13.12.4';

describe('sessionInitHandler plugin cache self-capture guard', () => {
  afterEach(() => {
    setSessionInitDependenciesForTesting();
  });

  it('skips session init when the SDK hook cwd is inside the installed plugin cache', async () => {
    const workerCalls: Array<{ apiPath: string; method: string; body: unknown }> = [];
    setSessionInitDependenciesForTesting({
      executeWithWorkerFallback: async (apiPath, method, body) => {
        workerCalls.push({ apiPath, method, body });
        return { sessionDbId: 42, promptNumber: 1 };
      },
    });

    const cwd = join(
      CLAUDE_CONFIG_DIR,
      PLUGINS_DIR_NAME,
      PLUGIN_CACHE_DIR_NAME,
      CLAUDE_MEM_PLUGIN_OWNER,
      CLAUDE_MEM_PLUGIN_NAME,
      PLUGIN_VERSION_DIR_NAME,
    );
    const savedInternal = process.env.CLAUDE_MEM_INTERNAL;
    delete process.env.CLAUDE_MEM_INTERNAL;
    try {
      const result = await sessionInitHandler.execute({
        sessionId: 'observer-sdk-session',
        cwd,
        platform: 'claude-code',
        prompt: 'observer prompt',
      });

      expect(result.continue).toBe(true);
      expect(result.suppressOutput).toBe(true);
      expect(workerCalls).toEqual([]);
    } finally {
      if (savedInternal === undefined) {
        delete process.env.CLAUDE_MEM_INTERNAL;
      } else {
        process.env.CLAUDE_MEM_INTERNAL = savedInternal;
      }
    }
  });
});
