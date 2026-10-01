import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { NormalizedHookInput } from '../../src/cli/types.js';
import type { TranscriptSchema, WatchTarget } from '../../src/services/transcripts/types.js';

const sessionInitCalls: NormalizedHookInput[] = [];

// Snapshot the real module BEFORE mock.module mutates the live namespace, then
// re-register it in afterAll. bun's mock.module is process-global and
// mock.restore() does NOT undo it, so this partial session-init stub would
// otherwise leak into other test files in the same `bun test` run.
import * as realSessionInit from '../../src/cli/handlers/session-init.js';
const realSessionInitSnapshot = { ...realSessionInit };

mock.module('../../src/cli/handlers/session-init.js', () => ({
  sessionInitHandler: {
    execute: async (input: NormalizedHookInput) => {
      sessionInitCalls.push(input);
      return { continue: true, suppressOutput: true };
    },
  },
}));

afterAll(() => {
  mock.module('../../src/cli/handlers/session-init.js', () => realSessionInitSnapshot);
});

import { logger } from '../../src/utils/logger.js';
import { TranscriptWatcher } from '../../src/services/transcripts/watcher.js';

interface ExampleConfig {
  schemas: Record<string, TranscriptSchema>;
}

const exampleConfig = JSON.parse(
  readFileSync(join(import.meta.dir, '..', '..', 'transcript-watch.example.json'), 'utf8'),
) as ExampleConfig;
const codexSchema = exampleConfig.schemas.codex;

const waitForAsyncTail = () => new Promise(resolve => setTimeout(resolve, 50));

const responseItem = (role: string, text: string) =>
  JSON.stringify({ type: 'response_item', payload: { type: 'message', role, content: [{ text }] } });

// Rule matching and field extraction are covered in match-rule-multi-field.test.ts.
// This asserts the stronger claim #4211 actually makes: that the prompt which
// reaches session-init (and therefore sdk_sessions.user_prompt) is the real user
// prompt. Codex 0.155 injects a role:user preamble ahead of it, and the shipped
// schema has to drop the preamble without dropping the user's own message.
describe('shipped codex schema: prompt delivery to session-init', () => {
  let tmpRoot: string;
  let loggerSpies: Array<ReturnType<typeof spyOn>> = [];

  beforeEach(() => {
    sessionInitCalls.length = 0;
    tmpRoot = mkdtempSync(join(tmpdir(), 'claude-mem-codex-delivery-'));
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function rollout(sessionId: string, ...conversation: Array<[string, string]>): string[] {
    return [
      JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: tmpRoot } }),
      ...conversation.map(([role, text]) => responseItem(role, text)),
    ];
  }

  async function deliver(lines: string[], sessionId: string): Promise<void> {
    const filePath = join(tmpRoot, `${sessionId}.jsonl`);
    writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');

    const watch: WatchTarget = {
      name: 'codex',
      path: join(tmpRoot, '*.jsonl'),
      schema: 'codex',
    };
    const watcher = new TranscriptWatcher(
      { version: 1, schemas: exampleConfig.schemas, watches: [watch] },
      join(tmpRoot, 'state.json'),
    );

    await (watcher as any).addTailer(filePath, watch, codexSchema);
    await waitForAsyncTail();
    watcher.stop();
  }

  it('delivers the real user prompt and never the injected preamble', async () => {
    const sessionId = '019e050e-7ae0-71b2-b19f-6cc428e57601';
    await deliver(rollout(
      sessionId,
      ['developer', '<skills_instructions> ...'],
      ['user', '<recommended_plugins>\nHere is a list of plugins that are available but not installed'],
      ['user', 'Repeat this token back exactly once: ZORBAX-QQ-7731'],
      ['assistant', 'ZORBAX-QQ-7731'],
    ), sessionId);

    expect(sessionInitCalls).toHaveLength(1);
    expect(sessionInitCalls[0].prompt).toBe('Repeat this token back exactly once: ZORBAX-QQ-7731');
    expect(sessionInitCalls[0].sessionId).toBe(sessionId);
  });

  it('still delivers a user prompt that merely mentions the marker', async () => {
    // Regression guard: rejecting the preamble by substring would silently drop
    // this prompt, because it contains the marker without being one.
    const sessionId = '019e050e-7ae0-71b2-b19f-6cc428e57602';
    const ask = 'why does <recommended_plugins> show up before my message?';

    await deliver(rollout(
      sessionId,
      ['user', '<recommended_plugins>\nHere is a list of plugins'],
      ['user', ask],
    ), sessionId);

    expect(sessionInitCalls.map(call => call.prompt)).toEqual([ask]);
  });

  it('ignores developer and assistant turns in the same rollout', async () => {
    const sessionId = '019e050e-7ae0-71b2-b19f-6cc428e57603';
    await deliver(rollout(
      sessionId,
      ['developer', '<skills_instructions> ...'],
      ['developer', '<multi_agent_mode> ...'],
      ['assistant', 'working on it'],
    ), sessionId);

    expect(sessionInitCalls).toHaveLength(0);
  });
});