import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';

import * as realHookSettings from '../../../src/shared/hook-settings.js';
import * as realProjectName from '../../../src/utils/project-name.js';
import * as realShouldTrack from '../../../src/shared/should-track-project.js';
import * as realWorkerUtils from '../../../src/shared/worker-utils.js';

/**
 * Snapshot the real namespaces EAGERLY, before the mock.module calls below —
 * bun re-points `import * as` namespaces when a module is mocked, so spreading
 * inside afterAll would copy the stubs back and leak into later test files.
 */
const realHookSettingsSnapshot = { ...realHookSettings };
const realProjectNameSnapshot = { ...realProjectName };
const realShouldTrackSnapshot = { ...realShouldTrack };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };

let proUpsell = 'true';

mock.module('../../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => ({
    CLAUDE_MEM_PRO_UPSELL: proUpsell,
  }),
}));

mock.module('../../../src/shared/should-track-project.js', () => ({
  shouldTrackProject: () => true,
  shouldEmitProjectRow: () => true,
}));

mock.module('../../../src/utils/project-name.js', () => ({
  getProjectContext: () => ({
    primary: 'home-project',
    parent: null,
    isWorktree: false,
    allProjects: ['home-project'],
  }),
}));

mock.module('../../../src/shared/worker-utils.js', () => ({
  executeWithWorkerFallback: async () => 'injected context',
  getWorkerPort: () => 37777,
  isWorkerFallback: () => false,
}));

afterAll(() => {
  mock.module('../../../src/shared/hook-settings.js', () => realHookSettingsSnapshot);
  mock.module('../../../src/utils/project-name.js', () => realProjectNameSnapshot);
  mock.module('../../../src/shared/should-track-project.js', () => realShouldTrackSnapshot);
  mock.module('../../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
});

beforeEach(() => {
  proUpsell = 'true';
});

describe('userMessageHandler Pro upsell gate (#4768)', () => {
  it('keeps the trial pitch in the context banner by default', async () => {
    const { userMessageHandler } = await import('../../../src/cli/handlers/user-message.js');

    const result = await userMessageHandler.execute({
      sessionId: 'session-upsell-default',
      cwd: '/home/user/home-project',
      platform: 'claude-code',
    });

    expect(result.systemMessage).toContain('Claude-Mem Context Loaded');
    expect(result.systemMessage).toContain('Watch live in browser');
    expect(result.systemMessage).toContain('Day Free Trial');
  });

  it('drops the trial pitch from the context banner when CLAUDE_MEM_PRO_UPSELL=false, keeping the rest', async () => {
    proUpsell = 'false';
    const { userMessageHandler } = await import('../../../src/cli/handlers/user-message.js');

    const result = await userMessageHandler.execute({
      sessionId: 'session-upsell-off',
      cwd: '/home/user/home-project',
      platform: 'claude-code',
    });

    expect(result.systemMessage).toContain('Claude-Mem Context Loaded');
    expect(result.systemMessage).toContain('injected context');
    expect(result.systemMessage).toContain('Watch live in browser');
    expect(result.systemMessage).not.toContain('Free Trial');
    expect(result.systemMessage).not.toContain('cmem.ai/pro');
  });
});
