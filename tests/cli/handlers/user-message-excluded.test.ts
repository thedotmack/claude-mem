import { afterAll, describe, expect, it, mock } from 'bun:test';

import * as realProjectName from '../../../src/utils/project-name.js';
import * as realShouldTrack from '../../../src/shared/should-track-project.js';
import * as realWorkerUtils from '../../../src/shared/worker-utils.js';

const realProjectNameSnapshot = { ...realProjectName };
const realShouldTrackSnapshot = { ...realShouldTrack };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };

const calls: unknown[][] = [];
let trackCwd: string | null = null;

mock.module('../../../src/shared/should-track-project.js', () => ({
  shouldTrackProject: (cwd: string) => cwd !== '/excluded/home',
  shouldEmitProjectRow: () => true,
}));

mock.module('../../../src/utils/project-name.js', () => ({
  getProjectContext: (cwd: string) => {
    trackCwd = cwd;
    return {
      primary: 'home-project',
      parent: null,
      isWorktree: false,
      allProjects: ['home-project'],
    };
  },
}));

mock.module('../../../src/shared/worker-utils.js', () => ({
  executeWithWorkerFallback: async (...args: unknown[]) => {
    calls.push(args);
    return 'injected context';
  },
  getWorkerPort: () => 37777,
  isWorkerFallback: () => false,
}));

afterAll(() => {
  mock.module('../../../src/shared/should-track-project.js', () => realShouldTrackSnapshot);
  mock.module('../../../src/utils/project-name.js', () => realProjectNameSnapshot);
  mock.module('../../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
});

describe('userMessageHandler excluded-project gate', () => {
  it('does not inject or banner when the cwd is excluded', async () => {
    calls.length = 0;
    trackCwd = null;
    const { userMessageHandler } = await import('../../../src/cli/handlers/user-message.js');

    const result = await userMessageHandler.execute({
      sessionId: 'session-excluded',
      cwd: '/excluded/home',
      platform: 'claude-code',
    });

    expect(result.exitCode).toBe(0);
    expect(result.systemMessage).toBeUndefined();
    expect(calls).toEqual([]);
    expect(trackCwd).toBeNull();
  });

  it('still injects via getProjectContext when the cwd is tracked', async () => {
    calls.length = 0;
    trackCwd = null;
    const { userMessageHandler } = await import('../../../src/cli/handlers/user-message.js');

    const result = await userMessageHandler.execute({
      sessionId: 'session-tracked',
      cwd: '/home/user/home-project',
      platform: 'claude-code',
    });

    expect(trackCwd).toBe('/home/user/home-project');
    expect(calls[0]?.[0]).toBe(
      '/api/context/inject?projects=home-project&colors=true&platformSource=claude',
    );
    expect(result.systemMessage).toContain('Claude-Mem Context Loaded');
    expect(result.systemMessage).toContain('injected context');
  });
});
