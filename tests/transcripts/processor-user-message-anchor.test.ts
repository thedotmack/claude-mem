import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { TranscriptSchema, WatchTarget } from '../../src/services/transcripts/types.js';
import { TranscriptAnchorError, TranscriptEventProcessor } from '../../src/services/transcripts/processor.js';
import { TranscriptWatcher } from '../../src/services/transcripts/watcher.js';
import * as realSessionInit from '../../src/cli/handlers/session-init.js';
import * as realWorkerUtils from '../../src/shared/worker-utils.js';
import * as realProjectName from '../../src/utils/project-name.js';

const realSessionInitSnapshot = { ...realSessionInit };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };
const realProjectNameSnapshot = { ...realProjectName };

afterAll(() => {
  mock.module('../../src/cli/handlers/session-init.js', () => realSessionInitSnapshot);
  mock.module('../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
  mock.module('../../src/utils/project-name.js', () => realProjectNameSnapshot);
});

const sessionInitCalls: Array<{ sessionId?: string; prompt?: string; platform?: string }> = [];
// Set to make the next session-init call fail, as an unreachable worker does.
let failNextSessionInit = false;

const fakeSessionInit = async (input: { sessionId?: string; prompt?: string; platform?: string }) => {
  if (failNextSessionInit) {
    failNextSessionInit = false;
    throw new Error('Unable to connect (ECONNREFUSED)');
  }
  sessionInitCalls.push(input);
  return { continue: true, suppressOutput: true };
};
mock.module('../../src/cli/handlers/session-init.js', () => ({
  sessionInitHandler: { execute: fakeSessionInit },
  recordSessionPrompt: fakeSessionInit,
}));

mock.module('../../src/shared/worker-utils.js', () => ({
  ensureWorkerRunning: async () => true,
  workerHttpRequest: async () => new Response(''),
}));

mock.module('../../src/utils/project-name.js', () => ({
  getProjectContext: () => ({
    primary: 'repo-project',
    parent: null,
    isWorktree: false,
    allProjects: ['repo-project'],
  }),
}));

// A schema that maps the user turn to the `user_message` action — the shape
// that produced no user_prompts row before #3653 was fixed.
const schema: TranscriptSchema = {
  name: 'codex',
  events: [
    {
      name: 'user-message',
      match: { path: 'payload.type', equals: 'user_message' },
      action: 'user_message',
      fields: {
        sessionId: 'payload.session_id',
        cwd: 'payload.cwd',
        message: 'payload.message',
      },
    },
  ],
};

const watch: WatchTarget = {
  name: 'codex-legacy',
  path: join(tmpdir(), 'codex-export', '**', '*.jsonl'),
  schema: 'codex',
};

const userMessagePayload = (message: string) => ({
  type: 'event',
  payload: {
    type: 'user_message',
    session_id: 'session-anchor-1',
    cwd: join(tmpdir(), 'anchor-project'),
    message,
  },
});

describe('TranscriptEventProcessor user_message anchoring', () => {
  let processor: TranscriptEventProcessor;

  beforeEach(() => {
    processor = new TranscriptEventProcessor();
    sessionInitCalls.length = 0;
  });

  afterEach(() => {
    sessionInitCalls.length = 0;
  });

  it('anchors a user_message turn through the init endpoint so a prompt row exists', async () => {
    await processor.processEntry(userMessagePayload('Fix the login bug'), watch, schema);

    expect(sessionInitCalls).toHaveLength(1);
    expect(sessionInitCalls[0].sessionId).toBe('session-anchor-1');
    expect(sessionInitCalls[0].prompt).toBe('Fix the login bug');
    expect(sessionInitCalls[0].platform).toBe('codex');
  });

  it('reports a failed anchor as a TranscriptAnchorError', async () => {
    failNextSessionInit = true;
    await expect(processor.processEntry(userMessagePayload('Fix the login bug'), watch, schema))
      .rejects.toBeInstanceOf(TranscriptAnchorError);
  });
});

describe('TranscriptWatcher with a failed anchor (#3653)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    sessionInitCalls.length = 0;
    tmpRoot = mkdtempSync(join(tmpdir(), 'claude-mem-anchor-watch-'));
  });

  afterEach(() => {
    failNextSessionInit = false;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('does not checkpoint past an unanchored turn, so a restarted watcher replays it', async () => {
    const filePath = join(tmpRoot, 'rollout.jsonl');
    const statePath = join(tmpRoot, 'state.json');
    const fileWatch: WatchTarget = { name: 'codex-legacy', path: filePath, schema };
    writeFileSync(filePath, `${JSON.stringify(userMessagePayload('Ship the fix'))}\n`);

    failNextSessionInit = true;
    const watcher = new TranscriptWatcher({ version: 1, watches: [] }, statePath);
    await (watcher as any).addTailer(filePath, fileWatch, schema);
    await new Promise(resolve => setTimeout(resolve, 50));
    watcher.stop();

    expect(sessionInitCalls).toHaveLength(0);
    // Checkpointed AT the failed turn's line (the first line here), not past it.
    const offsets = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')).offsets : {};
    expect(offsets[filePath] ?? 0).toBe(0);

    const restarted = new TranscriptWatcher({ version: 1, watches: [] }, statePath);
    await (restarted as any).addTailer(filePath, fileWatch, schema);
    await new Promise(resolve => setTimeout(resolve, 50));
    restarted.stop();

    expect(sessionInitCalls.map(call => call.prompt)).toEqual(['Ship the fix']);
  });
});
