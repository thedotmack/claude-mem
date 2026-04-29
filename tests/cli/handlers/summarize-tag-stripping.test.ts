/**
 * Tests for privacy-tag stripping in summarizeHandler.
 *
 * Validates that the Stop hook strips memory tags (<private>, <claude-mem-context>,
 * <system-instruction>, <system_instruction>, <persisted-output>) from the assistant's
 * last message before POSTing to /api/sessions/summarize. This is the fix for the bug
 * where private content was leaking into the summarize queue and downstream summary LLM.
 *
 * Sources:
 * - Handler: src/cli/handlers/summarize.ts
 * - Stripping utility: src/utils/tag-stripping.ts
 * - Mock pattern: tests/cli/handlers/summarize-subagent-skip.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';

mock.module('../../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    get: (key: string) => {
      if (key === 'CLAUDE_MEM_DATA_DIR') return join(homedir(), '.claude-mem');
      return '';
    },
    getInt: () => 0,
    loadFromFile: () => ({ CLAUDE_MEM_EXCLUDED_PROJECTS: '' }),
  },
}));

mock.module('../../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => ({ CLAUDE_MEM_EXCLUDED_PROJECTS: '' }),
}));

// Per-test control over what the transcript parser "extracts".
let mockExtractedMessage: string = '';
mock.module('../../../src/shared/transcript-parser.js', () => ({
  extractLastMessage: () => mockExtractedMessage,
}));

// Capture every executeWithWorkerFallback call. Resolve successfully so the
// handler completes its normal path — the assertions inspect what got POSTed.
const workerCallLog: Array<{ path: string; method: string; body: any }> = [];
mock.module('../../../src/shared/worker-utils.js', () => ({
  ensureWorkerRunning: () => Promise.resolve(true),
  getWorkerPort: () => 37777,
  workerHttpRequest: (apiPath: string, options?: any) => {
    workerCallLog.push({ path: apiPath, method: options?.method ?? 'GET', body: options?.body });
    return Promise.resolve(new Response('{"status":"queued"}', { status: 200 }));
  },
  executeWithWorkerFallback: async (apiPath: string, method: string, body: unknown) => {
    workerCallLog.push({ path: apiPath, method, body });
    return { status: 'queued' };
  },
  isWorkerFallback: (_result: unknown) => false,
}));

import { logger } from '../../../src/utils/logger.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  workerCallLog.length = 0;
  mockExtractedMessage = '';
  loggerSpies = [
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
    spyOn(logger, 'failure').mockImplementation(() => {}),
    spyOn(logger, 'dataIn').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  loggerSpies.forEach(spy => spy.mockRestore());
});

const baseInput = {
  sessionId: 'sess-tag-strip',
  cwd: '/tmp',
  platform: 'claude-code' as const,
  transcriptPath: '/tmp/fake.jsonl',
};

function postedBody(): any {
  expect(workerCallLog).toHaveLength(1);
  const { body } = workerCallLog[0];
  // executeWithWorkerFallback receives the body as a plain object; the legacy
  // workerHttpRequest path receives a JSON string. Support both for forward-compat.
  return typeof body === 'string' ? JSON.parse(body) : body;
}

describe('summarizeHandler — privacy tag stripping', () => {
  it('strips <private> tags and their content from last_assistant_message', async () => {
    mockExtractedMessage = 'Hello <private>SECRET-VALUE-42</private> world';

    const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');
    const result = await summarizeHandler.execute(baseInput as any);

    expect(result.continue).toBe(true);
    const body = postedBody();
    expect(body.last_assistant_message).not.toContain('SECRET-VALUE-42');
    expect(body.last_assistant_message).not.toContain('<private>');
    expect(body.last_assistant_message).toBe('Hello  world');
  });

  it('preserves surrounding content when stripping privacy tags', async () => {
    mockExtractedMessage =
      'Before tag. <private>leak</private> Middle. <private>another</private> After.';

    const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');
    await summarizeHandler.execute(baseInput as any);

    const body = postedBody();
    expect(body.last_assistant_message).not.toContain('leak');
    expect(body.last_assistant_message).not.toContain('another');
    expect(body.last_assistant_message).toContain('Before tag.');
    expect(body.last_assistant_message).toContain('Middle.');
    expect(body.last_assistant_message).toContain('After.');
  });

  it('skips the worker POST when the entire turn is wrapped in a privacy tag', async () => {
    // After stripping, the message is empty — handler should hit the
    // "no assistant message" guard and return without POSTing.
    mockExtractedMessage = '<private>everything is private</private>';

    const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');
    const result = await summarizeHandler.execute(baseInput as any);

    expect(result.continue).toBe(true);
    expect(result.suppressOutput).toBe(true);
    expect(workerCallLog).toHaveLength(0);
  });

  it('skips the worker POST when stripping leaves only whitespace', async () => {
    mockExtractedMessage = '   <private>x</private>\n\t<private>y</private>  ';

    const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');
    await summarizeHandler.execute(baseInput as any);

    expect(workerCallLog).toHaveLength(0);
  });

  it('does not modify content that contains no privacy tags', async () => {
    mockExtractedMessage = 'Just a normal assistant turn with no privacy markers.';

    const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');
    await summarizeHandler.execute(baseInput as any);

    const body = postedBody();
    expect(body.last_assistant_message).toBe(
      'Just a normal assistant turn with no privacy markers.'
    );
  });

  const taggedPayloads: Array<[string, string]> = [
    ['<private>', '<private>SECRET-PRIVATE</private>'],
    ['<claude-mem-context>', '<claude-mem-context>SECRET-CTX</claude-mem-context>'],
    ['<system-instruction>', '<system-instruction>SECRET-SI-DASH</system-instruction>'],
    ['<system_instruction>', '<system_instruction>SECRET-SI-UNDER</system_instruction>'],
    ['<persisted-output>', '<persisted-output>SECRET-PO</persisted-output>'],
  ];

  for (const [label, payload] of taggedPayloads) {
    it(`strips ${label} tags from last_assistant_message`, async () => {
      const secret = payload.match(/SECRET-[A-Z-]+/)![0];
      mockExtractedMessage = `before ${payload} after`;

      const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');
      await summarizeHandler.execute(baseInput as any);

      const body = postedBody();
      expect(body.last_assistant_message).not.toContain(secret);
      expect(body.last_assistant_message).toContain('before');
      expect(body.last_assistant_message).toContain('after');
    });
  }
});
