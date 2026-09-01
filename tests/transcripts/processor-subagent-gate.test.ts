import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { tmpdir } from 'os';
import { join } from 'path';
import type { TranscriptSchema, WatchTarget } from '../../src/services/transcripts/types.js';
import { TranscriptEventProcessor } from '../../src/services/transcripts/processor.js';
import * as realSessionInit from '../../src/cli/handlers/session-init.js';
import * as realIngest from '../../src/services/worker/http/shared.js';
import * as realProjectName from '../../src/utils/project-name.js';

const realSessionInitSnapshot = { ...realSessionInit };
const realIngestSnapshot = { ...realIngest };
const realProjectNameSnapshot = { ...realProjectName };

afterAll(() => {
  mock.module('../../src/cli/handlers/session-init.js', () => realSessionInitSnapshot);
  mock.module('../../src/services/worker/http/shared.js', () => realIngestSnapshot);
  mock.module('../../src/utils/project-name.js', () => realProjectNameSnapshot);
});

const sessionInitIds: string[] = [];
const observationSessionIds: string[] = [];

mock.module('../../src/cli/handlers/session-init.js', () => ({
  sessionInitHandler: {
    execute: async (input: { sessionId: string }) => {
      sessionInitIds.push(input.sessionId);
      return { continue: true, suppressOutput: true };
    },
  },
}));

mock.module('../../src/services/worker/http/shared.js', () => ({
  ingestObservation: async (payload: { contentSessionId: string }) => {
    observationSessionIds.push(payload.contentSessionId);
    return { ok: true };
  },
}));

mock.module('../../src/utils/project-name.js', () => ({
  getProjectContext: () => ({
    primary: 'repo-project',
    parent: null,
    isWorktree: false,
    allProjects: ['repo-project'],
  }),
}));

const schema: TranscriptSchema = {
  name: 'codex',
  events: [
    {
      name: 'session-meta',
      match: { path: 'type', equals: 'session_meta' },
      action: 'session_context',
      fields: { sessionId: 'payload.id', cwd: 'payload.cwd' },
    },
    {
      name: 'user-message',
      match: { path: 'payload.type', equals: 'user_message' },
      action: 'session_init',
      fields: { sessionId: 'payload.id', prompt: 'payload.message' },
    },
    {
      name: 'observation',
      match: { path: 'payload.type', equals: 'exec_command_end' },
      action: 'observation',
      fields: {
        sessionId: 'payload.id',
        toolName: { value: 'exec_command' },
        toolInput: 'payload.command',
        toolResponse: 'payload.aggregated_output',
      },
    },
  ],
};

const codexWatchPath = '~/.codex/sessions/**/*.jsonl';

const makeWatch = (overrides: Partial<WatchTarget>): WatchTarget => ({
  name: 'codex',
  path: codexWatchPath,
  schema: 'codex',
  ...overrides,
});

const metaEntry = (source: string | undefined) => ({
  type: 'session_meta',
  payload: { id: 's1', cwd: join(tmpdir(), 'repo'), ...(source ? { source } : {}) },
});
const userEntry = { type: 'event', payload: { type: 'user_message', id: 's1', message: 'hi' } };
const obsEntry = {
  type: 'event',
  payload: { type: 'exec_command_end', id: 's1', call_id: 'c1', command: 'ls', aggregated_output: 'files' },
};
const endEntry = { type: 'event', payload: { type: 'turn_completed', id: 's1' } };

const schemaWithEnd: TranscriptSchema = {
  ...schema,
  events: [
    ...schema.events,
    { name: 'session-end', match: { path: 'payload.type', equals: 'turn_completed' }, action: 'session_end', fields: { sessionId: 'payload.id' } },
  ],
};

async function replay(processor: TranscriptEventProcessor, watch: WatchTarget, source?: string): Promise<void> {
  await processor.processEntry(metaEntry(source), watch, schema);
  await processor.processEntry(userEntry, watch, schema);
  await processor.processEntry(obsEntry, watch, schema);
}

describe('TranscriptEventProcessor subagent gating', () => {
  let processor: TranscriptEventProcessor;

  beforeEach(() => {
    processor = new TranscriptEventProcessor();
    sessionInitIds.length = 0;
    observationSessionIds.length = 0;
  });

  afterEach(() => {
    sessionInitIds.length = 0;
    observationSessionIds.length = 0;
  });

  const subagentSource = { path: 'payload.source', value: 'thread_spawn' };

  it('ingests a subagent session under a subagent-only watch', async () => {
    const watch = makeWatch({ subagentOnly: true, subagentSource });
    await replay(processor, watch, 'thread_spawn');

    expect(sessionInitIds).toEqual(['s1']);
    expect(observationSessionIds).toEqual(['s1']);
  });

  it('suppresses a top-level session under a subagent-only watch', async () => {
    const watch = makeWatch({ subagentOnly: true, subagentSource });
    await replay(processor, watch, 'cli');

    expect(sessionInitIds).toEqual([]);
    expect(observationSessionIds).toEqual([]);
  });

  it('suppresses a session whose source is missing under a subagent-only watch', async () => {
    const watch = makeWatch({ subagentOnly: true, subagentSource });
    await replay(processor, watch, undefined);

    expect(sessionInitIds).toEqual([]);
    expect(observationSessionIds).toEqual([]);
  });

  it('ingests every session when the watch is not scoped (opt-in)', async () => {
    const watch = makeWatch({});
    await replay(processor, watch, 'cli');

    expect(sessionInitIds).toEqual(['s1']);
    expect(observationSessionIds).toEqual(['s1']);
  });

  it('drops a suppressed top-level session from the map on session_end', async () => {
    const watch = makeWatch({ subagentOnly: true, subagentSource });
    await processor.processEntry(metaEntry('cli'), watch, schemaWithEnd);
    await processor.processEntry(userEntry, watch, schemaWithEnd);
    expect((processor as any).sessions.size).toBe(1);

    await processor.processEntry(endEntry, watch, schemaWithEnd);

    expect(sessionInitIds).toEqual([]);
    expect((processor as any).sessions.size).toBe(0);
  });
});
