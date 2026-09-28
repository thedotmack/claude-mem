import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import * as realHookSettings from '../../../src/shared/hook-settings.js';
import * as realOauthToken from '../../../src/shared/oauth-token.js';
import * as realProjectName from '../../../src/utils/project-name.js';
import * as realWorkerUtils from '../../../src/shared/worker-utils.js';

// Snapshot eagerly (see context-session-start.test.ts) so afterAll restores the real modules.
const realHookSettingsSnapshot = { ...realHookSettings };
const realOauthTokenSnapshot = { ...realOauthToken };
const realProjectNameSnapshot = { ...realProjectName };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };

const REMINDER_URL = 'https://cmem.ai/login?next=%2Fapi%2Fpro%2Ftrial%2Fclaim%3Fpairing%3Dabc%26login_only%3D1';
const calls: string[] = [];
let reminderReply: unknown = { show: true, url: REMINDER_URL, expires_in: 1800 };

mock.module('../../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => ({ CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: 'false' }),
}));
mock.module('../../../src/shared/oauth-token.js', () => ({ readStaleMarker: () => null }));
mock.module('../../../src/utils/project-name.js', () => ({
  getProjectContext: () => ({ primary: 'p', parent: 'p', isWorktree: false, allProjects: ['p'] }),
}));
mock.module('../../../src/shared/worker-utils.js', () => ({
  executeWithWorkerFallback: async (url: string) => {
    calls.push(url);
    return url.startsWith('/api/signin/reminder') ? reminderReply : 'context from worker';
  },
  getWorkerPort: () => 37777,
  isWorkerFallback: () => false,
}));

const dataDir = mkdtempSync(join(tmpdir(), 'cm-reminder-hook-'));
const previousDataDir = process.env.CLAUDE_MEM_DATA_DIR;
process.env.CLAUDE_MEM_DATA_DIR = dataDir;

afterAll(() => {
  mock.module('../../../src/shared/hook-settings.js', () => realHookSettingsSnapshot);
  mock.module('../../../src/shared/oauth-token.js', () => realOauthTokenSnapshot);
  mock.module('../../../src/utils/project-name.js', () => realProjectNameSnapshot);
  mock.module('../../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
  if (previousDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
  else process.env.CLAUDE_MEM_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

function setState(state: string, arm: string): void {
  writeFileSync(join(dataDir, 'signin-state.json'), JSON.stringify({ state, arm, updatedAt: '' }));
}

async function run(sessionId: string) {
  const { contextHandler } = await import('../../../src/cli/handlers/context.js');
  return contextHandler.execute({ sessionId, cwd: '/tmp/repo', platform: 'claude-code' });
}

describe('SessionStart sign-in reminder', () => {
  beforeEach(() => {
    calls.length = 0;
    reminderReply = { show: true, url: REMINDER_URL, expires_in: 1800 };
    rmSync(join(dataDir, 'signin-reminder-sessions.json'), { force: true });
  });

  it('arm C + unclaimed: the person sees the link and the agent gets the facts', async () => {
    setState('unclaimed', 'C');
    const result = await run('s-1');
    expect(calls).toEqual(['/api/context/inject?projects=p&platformSource=claude', '/api/signin/reminder?session_id=s-1']);
    expect(result.systemMessage).toBe(`claude-mem: sign-in not finished (free). Link, valid 30 min: ${REMINDER_URL}`);
    expect(result.hookSpecificOutput?.additionalContext).toBe(
      `claude-mem sign-in is not finished for this install. The user can finish it here (valid 30 min): ${REMINDER_URL}. New link: npx claude-mem login --request.\n\ncontext from worker`,
    );
  });

  it('a session already reminded makes no worker call', async () => {
    setState('unclaimed', 'C');
    writeFileSync(join(dataDir, 'signin-reminder-sessions.json'), JSON.stringify(['s-2']));
    const result = await run('s-2');
    expect(calls.some((c) => c.startsWith('/api/signin'))).toBe(false);
    expect(result.systemMessage).toBeUndefined();
  });

  for (const [state, arm] of [['claimed', 'C'], ['dismissed', 'C'], ['unclaimed', 'A'], ['unclaimed', 'B']]) {
    it(`${state} in arm ${arm}: no reminder and no worker call`, async () => {
      setState(state, arm);
      const result = await run('s-3');
      expect(calls.some((c) => c.startsWith('/api/signin'))).toBe(false);
      expect(result.systemMessage).toBeUndefined();
      expect(result.hookSpecificOutput?.additionalContext).toBe('context from worker');
    });
  }

  it('a worker answer of show:false (or junk) shows nothing', async () => {
    setState('unclaimed', 'C');
    reminderReply = { show: false, reason: 'claimed' };
    expect((await run('s-4')).systemMessage).toBeUndefined();
    reminderReply = { show: true, url: 'javascript:alert(1)' };
    expect((await run('s-5')).systemMessage).toBeUndefined();
  });
});
