import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { appendFileSync, mkdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { TranscriptSchema, WatchTarget } from '../../src/services/transcripts/types.js';
import { CODEX_SUBAGENT_SOURCE } from '../../src/services/transcripts/config.js';
import * as realSessionInit from '../../src/cli/handlers/session-init.js';
import * as realIngest from '../../src/services/worker/http/shared.js';
import * as realProjectName from '../../src/utils/project-name.js';
import * as realWorkerUtils from '../../src/shared/worker-utils.js';

// R4-12: Codex marks a subagent rollout only on its first (session_meta) line.
// A tail that resumes past it (a worker restart, or startAtEnd on a rollout
// already running at startup) never read the marker, so the subagent-only
// watch dropped the rest of the rollout.

const realSessionInitSnapshot = { ...realSessionInit };
const realIngestSnapshot = { ...realIngest };
const realProjectNameSnapshot = { ...realProjectName };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };

afterAll(() => {
  mock.module('../../src/cli/handlers/session-init.js', () => realSessionInitSnapshot);
  mock.module('../../src/services/worker/http/shared.js', () => realIngestSnapshot);
  mock.module('../../src/utils/project-name.js', () => realProjectNameSnapshot);
  mock.module('../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
});

const prompts: string[] = [];
const commands: unknown[] = [];
const cwds: string[] = [];

mock.module('../../src/cli/handlers/session-init.js', () => ({
  sessionInitHandler: {
    execute: async (input: { prompt: string; cwd: string }) => {
      prompts.push(input.prompt);
      cwds.push(input.cwd);
      return { continue: true, suppressOutput: true };
    },
  },
}));
mock.module('../../src/services/worker/http/shared.js', () => ({
  ingestObservation: async (payload: { toolInput: unknown }) => {
    commands.push(payload.toolInput);
    return { ok: true };
  },
}));
mock.module('../../src/utils/project-name.js', () => ({
  getProjectContext: () => ({ primary: 'repo', parent: null, isWorktree: false, allProjects: ['repo'] }),
}));
mock.module('../../src/shared/worker-utils.js', () => ({
  ...realWorkerUtilsSnapshot,
  ensureWorkerRunning: async () => false,
}));

import { logger } from '../../src/utils/logger.js';
import { TranscriptWatcher } from '../../src/services/transcripts/watcher.js';

const waitForAsyncTail = () => new Promise(resolve => setTimeout(resolve, 50));

const SESSION_ID = '01a0f592-bd36-7311-9d49-62ebfe754e30';

const schema: TranscriptSchema = {
  name: 'codex',
  events: [
    { name: 'session-meta', match: { path: 'type', equals: 'session_meta' }, action: 'session_context',
      fields: { sessionId: 'payload.id', cwd: 'payload.cwd' } },
    { name: 'user-message', match: { path: 'payload.type', equals: 'user_message' }, action: 'session_init',
      fields: { prompt: 'payload.message' } },
    { name: 'exec', match: { path: 'payload.type', equals: 'exec_command_end' }, action: 'observation',
      fields: { toolName: { value: 'exec_command' }, toolInput: 'payload.command', toolResponse: 'payload.aggregated_output' } },
  ],
};

const line = (entry: unknown) => `${JSON.stringify(entry)}\n`;
const meta = (source: unknown, cwd: string) => line({ type: 'session_meta', payload: { id: SESSION_ID, cwd, source } });
const user = (message: string) => line({ type: 'event_msg', payload: { type: 'user_message', message } });
const exec = (command: string) => line({ type: 'event_msg', payload: { type: 'exec_command_end', command, aggregated_output: 'ok' } });

const SUBAGENT = { subagent: { thread_spawn: { parent_thread_id: 'parent', depth: 1 } } };

describe('a resumed subagent-only tail learns the marker from the first line', () => {
  let tmpRoot: string;
  let rolloutCwd: string;
  let filePath: string;
  let loggerSpies: ReturnType<typeof spyOn>[] = [];

  beforeEach(() => {
    prompts.length = 0;
    commands.length = 0;
    cwds.length = 0;
    tmpRoot = join(tmpdir(), `claude-mem-subagent-resume-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    rolloutCwd = join(tmpRoot, 'repo');
    mkdirSync(rolloutCwd, { recursive: true });
    filePath = join(tmpRoot, `rollout-2026-09-30T20-47-09-${SESSION_ID}.jsonl`);
    loggerSpies = (['info', 'debug', 'warn', 'error'] as const)
      .map(level => spyOn(logger, level).mockImplementation(() => {}));
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  const watchFor = (): WatchTarget => ({
    name: 'codex',
    path: join(tmpRoot, '*.jsonl'),
    schema,
    startAtEnd: true,
    subagentOnly: true,
    subagentSource: { ...CODEX_SUBAGENT_SOURCE },
  });

  async function resumeAndAppend(watcher: TranscriptWatcher, watch: WatchTarget): Promise<void> {
    await (watcher as any).addTailer(filePath, watch, schema);
    await waitForAsyncTail();
    appendFileSync(filePath, user('live follow-up') + exec('live-cmd'), 'utf8');
    (watcher as any).tailers.get(filePath)?.poke();
    await waitForAsyncTail();
    watcher.stop();
  }

  it('captures the live turns of a subagent rollout already running at startup', async () => {
    writeFileSync(filePath, meta(SUBAGENT, rolloutCwd) + user('historical task') + exec('historical-cmd'), 'utf8');
    const watch = watchFor();
    const watcher = new TranscriptWatcher({ version: 1, watches: [watch], schemas: { codex: schema } }, join(tmpRoot, 'state.json'));

    await resumeAndAppend(watcher, watch);

    expect(prompts).toEqual(['live follow-up']);
    expect(commands).toEqual(['live-cmd']);
    // The first line also restores the rollout's cwd, so the turn is filed
    // under its own project rather than the watcher's working directory.
    expect(cwds).toEqual([rolloutCwd]);
  });

  it('captures a subagent rollout resumed from a saved offset after a restart', async () => {
    writeFileSync(filePath, meta(SUBAGENT, rolloutCwd) + user('first task') + exec('first-cmd'), 'utf8');
    const statePath = join(tmpRoot, 'state.json');
    writeFileSync(statePath, JSON.stringify({ offsets: { [filePath]: statSync(filePath).size } }), 'utf8');
    const watch = { ...watchFor(), startAtEnd: false };
    const watcher = new TranscriptWatcher({ version: 1, watches: [watch], schemas: { codex: schema } }, statePath);

    await resumeAndAppend(watcher, watch);

    expect(prompts).toEqual(['live follow-up']);
    expect(commands).toEqual(['live-cmd']);
  });

  it('still suppresses a resumed top-level rollout', async () => {
    writeFileSync(filePath, meta('cli', rolloutCwd) + user('historical task'), 'utf8');
    const watch = watchFor();
    const watcher = new TranscriptWatcher({ version: 1, watches: [watch], schemas: { codex: schema } }, join(tmpRoot, 'state.json'));

    await resumeAndAppend(watcher, watch);

    expect(prompts).toEqual([]);
    expect(commands).toEqual([]);
  });
});
