import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { tmpdir } from 'os';
import { join } from 'path';
import type { TranscriptSchema, WatchTarget } from '../../src/services/transcripts/types.js';
import { TranscriptEventProcessor } from '../../src/services/transcripts/processor.js';
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

mock.module('../../src/cli/handlers/session-init.js', () => ({
  sessionInitHandler: {
    execute: async (input: { sessionId?: string; prompt?: string; platform?: string }) => {
      sessionInitCalls.push(input);
      return { continue: true, suppressOutput: true };
    },
  },
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
});
