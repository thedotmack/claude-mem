// A Codex turn ends with one Stop hook. Payloads here have the keys Codex 0.167 sends (text replaced).
import { describe, it, expect, beforeEach, afterEach, afterAll, spyOn, mock } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';

import * as realSettingsDefaultsManager from '../../../src/shared/SettingsDefaultsManager.js';
import * as realHookSettings from '../../../src/shared/hook-settings.js';
const realSettingsSnapshot = { ...realSettingsDefaultsManager };
const realHookSettingsSnapshot = { ...realHookSettings };

mock.module('../../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    get: (key: string) => (key === 'CLAUDE_MEM_DATA_DIR' ? join(homedir(), '.claude-mem') : ''),
    getInt: () => 0,
    loadFromFile: () => ({ CLAUDE_MEM_EXCLUDED_PROJECTS: '' }),
  },
}));

mock.module('../../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => ({ CLAUDE_MEM_EXCLUDED_PROJECTS: '' }),
}));

import { logger } from '../../../src/utils/logger.js';
import { codexAdapter } from '../../../src/cli/adapters/codex.js';
import { HookSpool } from '../../../src/shared/hook-spool.js';
import { spooledEntries, useTempHookSpoolDataDir } from '../../helpers/temp-hook-spool.js';

const SESSION_ID = '01a1ce65-e816-7000-8000-000000000005';
const stop = (extra: Record<string, unknown> = {}) => ({
  session_id: SESSION_ID,
  turn_id: '01a1ce65-ffff-7000-8000-000000000006',
  transcript_path: null,
  cwd: '/tmp',
  hook_event_name: 'Stop',
  model: 'gpt-test',
  permission_mode: 'default',
  stop_hook_active: false,
  last_assistant_message: 'Which shape should the test use, circle or square?',
  ...extra,
});

let loggerSpies: ReturnType<typeof spyOn>[] = [];
let tempSpool: ReturnType<typeof useTempHookSpoolDataDir>;

beforeEach(() => {
  tempSpool = useTempHookSpoolDataDir();
  loggerSpies = (['info', 'debug', 'warn', 'error', 'failure', 'dataIn'] as const)
    .map(level => spyOn(logger, level).mockImplementation(() => {}));
});

afterEach(() => {
  loggerSpies.forEach(spy => spy.mockRestore());
  tempSpool.restore();
});

afterAll(() => {
  mock.module('../../../src/shared/SettingsDefaultsManager.js', () => realSettingsSnapshot);
  mock.module('../../../src/shared/hook-settings.js', () => realHookSettingsSnapshot);
});

async function runStop(raw: Record<string, unknown>) {
  const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');
  const input = codexAdapter.normalizeInput(raw);
  input.platform = 'codex';
  const result = await summarizeHandler.execute(input);
  return codexAdapter.formatOutput(result);
}

describe('a Codex Stop hook', () => {
  it('asks for one summary of the turn, as a codex session, with the last message Codex handed over', async () => {
    expect(await runStop(stop())).toEqual({ continue: true });

    const requests = spooledEntries('summarize');
    expect(requests).toHaveLength(1);
    expect(requests[0].payload).toMatchObject({
      contentSessionId: SESSION_ID,
      platformSource: 'codex',
      lastAssistantMessage: 'Which shape should the test use, circle or square?',
    });
  });

  it('asks again only for a new turn: the Stop Codex repeats while a Stop hook holds the turn open asks nothing', async () => {
    await runStop(stop());
    expect(await runStop(stop({ stop_hook_active: true }))).toEqual({ continue: true });
    expect(await runStop(stop({ stop_hook_active: 'true' }))).toEqual({ continue: true });

    expect(spooledEntries('summarize')).toHaveLength(1);
  });

  it('asks nothing for a subagent thread or a turn with no final message', async () => {
    await runStop(stop({ agent_id: 'agent-1', agent_type: 'explorer' }));
    await runStop(stop({ last_assistant_message: '' }));
    await runStop(stop({ last_assistant_message: null }));

    expect(spooledEntries('summarize')).toHaveLength(0);
  });

  it('leaves nothing on disk for a later run to send', async () => {
    await runStop(stop());

    expect(new HookSpool().entries()).toEqual([]);
  });
});
