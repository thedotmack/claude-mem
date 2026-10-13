import { describe, it, expect, beforeEach, afterEach, afterAll, spyOn, mock } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';

// Capture real exports before mock.module mutates the live namespace, then
// re-register the snapshots in afterAll so these mocks do not leak into later
// test files (bun's mock.module is process-global; mock.restore() does NOT undo it).
import * as realSettingsDefaultsManager from '../../../src/shared/SettingsDefaultsManager.js';
import * as realHookSettings from '../../../src/shared/hook-settings.js';
import * as realTranscriptParser from '../../../src/shared/transcript-parser.js';
import * as realWorkerUtils from '../../../src/shared/worker-utils.js';
const realSettingsSnapshot = { ...realSettingsDefaultsManager };
const realHookSettingsSnapshot = { ...realHookSettings };
const realTranscriptParserSnapshot = { ...realTranscriptParser };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };

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

let mockExtractedMessage: string = '';
// Counts transcript reads: the Stop hook reads the transcript exactly once via
// extractLastAssistantTurn (text + model together), never via extractLastMessage.
let extractCallCount = 0;
mock.module('../../../src/shared/transcript-parser.js', () => ({
  extractLastMessage: () => mockExtractedMessage,
  extractLastAssistantTurn: () => {
    extractCallCount += 1;
    return { text: mockExtractedMessage, model: 'claude-test-model' };
  },
  extractLastAssistantModel: () => 'claude-test-model',
}));

// Awaited worker calls (must stay empty: Stop spools and exits) vs. the
// fire-and-forget spool nudge.
const awaitedWorkerCallLog: Array<{ path: string; method: string; body: any }> = [];
const nudgeLog: string[] = [];
mock.module('../../../src/shared/worker-utils.js', () => ({
  ...realWorkerUtilsSnapshot,
  ensureWorkerRunning: () => {
    awaitedWorkerCallLog.push({ path: 'ensureWorkerRunning', method: '', body: null });
    return Promise.resolve(true);
  },
  workerHttpRequest: (apiPath: string) => {
    nudgeLog.push(apiPath);
    return Promise.resolve(new Response('{"status":"draining"}', { status: 202 }));
  },
  executeWithWorkerFallback: async (apiPath: string, method: string, body: unknown) => {
    awaitedWorkerCallLog.push({ path: apiPath, method, body });
    return { status: 'queued' };
  },
}));

import { logger } from '../../../src/utils/logger.js';
import { spooledEntries, useTempHookSpoolDataDir } from '../../helpers/temp-hook-spool.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];
let tempSpool: ReturnType<typeof useTempHookSpoolDataDir>;

beforeEach(() => {
  tempSpool = useTempHookSpoolDataDir();
  awaitedWorkerCallLog.length = 0;
  nudgeLog.length = 0;
  mockExtractedMessage = '';
  extractCallCount = 0;
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
  tempSpool.restore();
});

afterAll(() => {
  mock.module('../../../src/shared/SettingsDefaultsManager.js', () => realSettingsSnapshot);
  mock.module('../../../src/shared/hook-settings.js', () => realHookSettingsSnapshot);
  mock.module('../../../src/shared/transcript-parser.js', () => realTranscriptParserSnapshot);
  mock.module('../../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
});

const baseInput = {
  sessionId: 'sess-tag-strip',
  cwd: '/tmp',
  platform: 'claude-code' as const,
  transcriptPath: '/tmp/fake.jsonl',
};

function spooledSummarize(): any {
  expect(awaitedWorkerCallLog).toHaveLength(0);
  expect(nudgeLog).toEqual(['/api/spool/nudge']);
  const entries = spooledEntries('summarize');
  expect(entries).toHaveLength(1);
  return entries[0].payload;
}

function nothingSpooled(): void {
  expect(awaitedWorkerCallLog).toHaveLength(0);
  expect(spooledEntries()).toHaveLength(0);
}

describe('summarizeHandler — privacy tag stripping', () => {
  it('uses Codex lastAssistantMessage directly without reading a transcript', async () => {
    const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');
    const result = await summarizeHandler.execute({
      sessionId: 'sess-codex',
      cwd: '/tmp',
      platform: 'codex',
      lastAssistantMessage: 'Codex answer <private>SECRET</private>',
    });

    expect(result.continue).toBe(true);
    expect(extractCallCount).toBe(0);
    const body = spooledSummarize();
    expect(body.lastAssistantMessage).toBe('Codex answer');
    expect(body.platformSource).toBe('codex');
  });

  it('summarizes a Claude Code turn that continued after another plugin blocked the stop', async () => {
    // Claude Code sends stop_hook_active: true once ANY Stop hook blocked the
    // stop. claude-mem's never does, so the turn Claude kept working on still
    // needs its summary (and the advisor capture that runs before it).
    const { claudeCodeAdapter } = await import('../../../src/cli/adapters/claude-code.js');
    const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');
    mockExtractedMessage = 'Finished the work the other plugin asked for';
    const input = {
      ...claudeCodeAdapter.normalizeInput({
        session_id: 'sess-cc-continued',
        cwd: '/tmp',
        transcript_path: '/tmp/fake.jsonl',
        stop_hook_active: true,
      }),
      platform: 'claude-code' as const,
    };

    const result = await summarizeHandler.execute(input);

    expect(result.continue).toBe(true);
    expect(extractCallCount).toBe(1);
    expect(spooledSummarize().lastAssistantMessage).toBe('Finished the work the other plugin asked for');
  });

  it('short-circuits Codex stop hook re-entry', async () => {
    const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');
    const result = await summarizeHandler.execute({
      sessionId: 'sess-codex',
      cwd: '/tmp',
      platform: 'codex',
      stopHookActive: true,
      lastAssistantMessage: 'ignored',
    });

    expect(result.continue).toBe(true);
    expect(result.suppressOutput).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(extractCallCount).toBe(0);
    nothingSpooled();
  });

  it('strips <private> tags and their content from last_assistant_message', async () => {
    mockExtractedMessage = 'Hello <private>SECRET-VALUE-42</private> world';

    const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');
    const result = await summarizeHandler.execute(baseInput as any);

    expect(result.continue).toBe(true);
    expect(extractCallCount).toBe(1);
    const body = spooledSummarize();
    expect(body.lastAssistantMessage).not.toContain('SECRET-VALUE-42');
    expect(body.lastAssistantMessage).not.toContain('<private>');
    expect(body.lastAssistantMessage).toBe('Hello  world');
  });

  it('preserves surrounding content when stripping privacy tags', async () => {
    mockExtractedMessage =
      'Before tag. <private>leak</private> Middle. <private>another</private> After.';

    const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');
    await summarizeHandler.execute(baseInput as any);

    const body = spooledSummarize();
    expect(body.lastAssistantMessage).not.toContain('leak');
    expect(body.lastAssistantMessage).not.toContain('another');
    expect(body.lastAssistantMessage).toContain('Before tag.');
    expect(body.lastAssistantMessage).toContain('Middle.');
    expect(body.lastAssistantMessage).toContain('After.');
  });

  it('skips the worker POST when the entire turn is wrapped in a privacy tag', async () => {
    mockExtractedMessage = '<private>everything is private</private>';

    const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');
    const result = await summarizeHandler.execute(baseInput as any);

    expect(result.continue).toBe(true);
    expect(result.suppressOutput).toBe(true);
    nothingSpooled();
  });

  it('skips the worker POST when stripping leaves only whitespace', async () => {
    mockExtractedMessage = '   <private>x</private>\n\t<private>y</private>  ';

    const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');
    await summarizeHandler.execute(baseInput as any);

    nothingSpooled();
  });

  it('does not modify content that contains no privacy tags', async () => {
    mockExtractedMessage = 'Just a normal assistant turn with no privacy markers.';

    const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');
    await summarizeHandler.execute(baseInput as any);

    const body = spooledSummarize();
    expect(body.lastAssistantMessage).toBe(
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

      const body = spooledSummarize();
      expect(body.lastAssistantMessage).not.toContain(secret);
      expect(body.lastAssistantMessage).toContain('before');
      expect(body.lastAssistantMessage).toContain('after');
    });
  }
});

// Migrated from the now-deleted Gemini CLI host-integration compat test file
// (Phase A removal) — these two checks are unrelated to that integration, they
// just happened to live in the same file. Preserved here so the platformSource
// plumbing in summarize.ts keeps regression coverage.
describe('Summarize handler - platformSource in request body', () => {
  it('should include platformSource import in summarize.ts', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/cli/handlers/summarize.ts', 'utf-8');
    expect(src).toContain('normalizePlatformSource');
    expect(src).toContain('platform-source');
  });

  it('should pass platformSource in the spooled summarize payload', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/cli/handlers/summarize.ts', 'utf-8');
    expect(src).toContain('platformSource');
    expect(src).toContain("spoolHookEvent('summarize'");
  });
});
