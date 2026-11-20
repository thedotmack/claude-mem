import { mock } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as workerUtils from '../../../src/shared/worker-utils.js';

const originalWorker = { ...workerUtils };
const terminalOnly = process.argv[2] === 'terminal';
mock.module('../../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => ({
    CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: String(terminalOnly),
    CLAUDE_MEM_EXCLUDED_PROJECTS: '', CLAUDE_MEM_PRO_FALLBACK_AT: '',
    CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD: '2',
  }),
}));
mock.module('../../../src/shared/oauth-token.js', () => ({ readStaleMarker: () => null }));
mock.module('../../../src/utils/project-name.js', () => ({
  getProjectContext: () => ({ primary: 'outage-project', allProjects: ['outage-project'], isWorktree: false }),
}));
mock.module('../../../src/shared/worker-utils.js', () => ({
  ...originalWorker,
  executeWithWorkerFallback: async (path: string) => {
    if (!terminalOnly || path.includes('colors=true')) throw new Error('ECONNRESET');
    return 'context from worker';
  },
}));

const { contextHandler } = await import('../../../src/cli/handlers/context.js');
const path = join(process.env.CLAUDE_MEM_DATA_DIR!, 'state', 'hook-failures.json');
const steps = [];
for (let invocation = 0; invocation < 2; invocation++) {
  originalWorker.resetWorkerUnreachableState();
  const result = await contextHandler.execute({ sessionId: `outage-${invocation}`, cwd: '/work/outage-project', platform: 'claude-code' });
  const state = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { consecutiveFailures: 0 };
  steps.push({ result, state });
}
console.log(JSON.stringify(steps));
