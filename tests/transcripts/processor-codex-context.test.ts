import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { tmpdir } from 'os';
import { join } from 'path';
import type { TranscriptSchema, WatchTarget } from '../../src/services/transcripts/types.js';
import { TranscriptEventProcessor } from '../../src/services/transcripts/processor.js';
import * as realSessionInit from '../../src/cli/handlers/session-init.js';
import * as realWorkerUtils from '../../src/shared/worker-utils.js';
import * as realAgentsMdUtils from '../../src/utils/agents-md-utils.js';
import * as realProjectName from '../../src/utils/project-name.js';

const realSessionInitSnapshot = { ...realSessionInit };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };
const realAgentsMdUtilsSnapshot = { ...realAgentsMdUtils };
const realProjectNameSnapshot = { ...realProjectName };

afterAll(() => {
  mock.module('../../src/cli/handlers/session-init.js', () => realSessionInitSnapshot);
  mock.module('../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
  mock.module('../../src/utils/agents-md-utils.js', () => realAgentsMdUtilsSnapshot);
  mock.module('../../src/utils/project-name.js', () => realProjectNameSnapshot);
});

mock.module('../../src/cli/handlers/session-init.js', () => ({
  sessionInitHandler: {
    execute: async () => ({
      continue: true,
      suppressOutput: true,
    }),
  },
}));

const workerHttpRequestCalls: string[] = [];
const writeAgentsCalls: Array<{ agentsPath: string; content: string }> = [];

mock.module('../../src/shared/worker-utils.js', () => ({
  ensureWorkerRunning: async () => true,
  workerHttpRequest: async (apiPath: string) => {
    workerHttpRequestCalls.push(apiPath);
    return new Response('injected-context');
  },
}));

mock.module('../../src/utils/agents-md-utils.js', () => ({
  writeAgentsMd: (agentsPath: string, context: string) => {
    writeAgentsCalls.push({ agentsPath, content: context });
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
      name: 'user-message',
      match: { path: 'payload.type', equals: 'user_message' },
      action: 'session_init',
      fields: {
        sessionId: 'payload.session_id',
        cwd: 'payload.cwd',
        prompt: 'payload.prompt',
      },
    },
  ],
};

const makeWatch = (overrides: Partial<WatchTarget>): WatchTarget => ({
  name: 'codex',
  path: join(tmpdir(), 'transcripts', '**', '*.jsonl'),
  schema: 'codex',
  context: {
    mode: 'agents',
    updateOn: ['session_start'],
  },
  ...overrides,
});

const sessionPayload = (cwd: string) => ({
  type: 'event',
  payload: {
    type: 'user_message',
    session_id: 'session-codex-1',
    cwd,
    prompt: 'Hi',
  },
});

describe('TranscriptEventProcessor AGENTS context', () => {
  let processor: TranscriptEventProcessor;

  beforeEach(() => {
    processor = new TranscriptEventProcessor();
    workerHttpRequestCalls.length = 0;
    writeAgentsCalls.length = 0;
  });

  afterEach(() => {
    workerHttpRequestCalls.length = 0;
    writeAgentsCalls.length = 0;
    mock.restore();
  });

  it('suppresses AGENTS writes for native-hook-backed Codex transcript watches', async () => {
    const cwd = join(tmpdir(), 'native-codex-context');
    const watch = makeWatch({
      name: 'codex',
      path: '~/.codex/sessions/**/*.jsonl',
    });

    await processor.processEntry(sessionPayload(cwd), watch, schema);

    expect(writeAgentsCalls).toHaveLength(0);
    expect(workerHttpRequestCalls).toHaveLength(0);
  });

  it('still writes AGENTS context for non-native Codex transcript watches', async () => {
    const cwd = join(tmpdir(), 'non-native-codex-context');
    const agentsPath = join(cwd, 'AGENTS.md');
    const watch = makeWatch({
      name: 'codex-legacy',
      path: join(tmpdir(), 'codex-export', '**', '*.jsonl'),
      context: {
        mode: 'agents',
        path: agentsPath,
        updateOn: ['session_start'],
      },
    });

    await processor.processEntry(sessionPayload(cwd), watch, schema);

    expect(writeAgentsCalls).toHaveLength(1);
    expect(writeAgentsCalls[0].agentsPath).toBe(agentsPath);
    expect(workerHttpRequestCalls).toContain('/api/context/inject?projects=repo-project');
    expect(writeAgentsCalls[0].content).toBe('injected-context');
  });
});
