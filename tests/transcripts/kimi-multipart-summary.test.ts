import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { kimiAdapter } from '../../src/cli/adapters/kimi.js';
import { summarizeHandler } from '../../src/cli/handlers/summarize.js';
import {
  extractLastAssistantTurn,
  extractLastMessage,
  extractLastMessageFromJsonl,
} from '../../src/shared/transcript-parser.js';
import { spooledEntries, useTempHookSpoolDataDir } from '../helpers/temp-hook-spool.js';

// Native Kimi records: loopService writes one content.part per content block;
// replayBuilder/fold.ts attaches those parts to the step.begin with stepUuid.
// turnId and the numeric step can repeat after resuming a session.
const loop = (event: Record<string, unknown>) => ({ type: 'context.append_loop_event', event });
const begin = (uuid: string) => loop({ type: 'step.begin', uuid, turnId: '0', step: 1 });
const part = (stepUuid: string, block: number, text: string) => loop({
  type: 'content.part', uuid: `${stepUuid}-part-${block}`, stepUuid, turnId: '0', step: 1, block,
  part: { type: 'text', text },
});
const end = (uuid: string) => loop({ type: 'step.end', uuid, turnId: '0', step: 1 });
const jsonl = (records: unknown[]) => records.map(record => JSON.stringify(record)).join('\n') + '\n';

function multipartTurn(parts: string[]): string {
  return jsonl([
    begin('previous-step'), part('previous-step', 0, 'Previous answer must stay separate.'), end('previous-step'),
    { type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: 'What changed?' }] } },
    begin('current-step'),
    ...parts.flatMap((text, block) => [
      part('current-step', block, text),
      loop({ type: 'content.part', stepUuid: 'current-step', block: block + 10, part: { type: 'think', think: 'private reasoning' } }),
    ]),
    end('current-step'),
    { type: 'turn.ended', turnId: '0' },
  ]);
}

describe('Kimi multipart assistant summaries', () => {
  let root: string;
  let wirePath: string;
  let tempSpool: ReturnType<typeof useTempHookSpoolDataDir>;
  const savedHome = process.env.KIMI_CODE_HOME;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kimi-multipart-summary-'));
    process.env.KIMI_CODE_HOME = root;
    wirePath = join(root, 'sessions', 'project', 'session_multipart', 'agents', 'main', 'wire.jsonl');
    mkdirSync(dirname(wirePath), { recursive: true });
    tempSpool = useTempHookSpoolDataDir();
  });

  afterEach(() => {
    tempSpool.restore();
    if (savedHome === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = savedHome;
    rmSync(root, { recursive: true, force: true });
  });

  it('joins all text blocks in the newest step without joining a previous step with the same counters', () => {
    const transcript = multipartTurn(['Implemented the redirect.', '\n\n', 'Verified the regression.']);
    expect(extractLastMessageFromJsonl(transcript, 'assistant', false))
      .toBe('Implemented the redirect.\n\nVerified the regression.');
    expect(extractLastMessageFromJsonl(transcript, 'user', false)).toBe('What changed?');
  });

  it('carries the same step across backward disk chunks and preserves Unicode and spacing', () => {
    const parts = ['修复登录 redirect. ', '证据 '.repeat(180), '\nAll checks passed.'];
    writeFileSync(wirePath, multipartTurn(parts));
    const tail = { initialBytes: 128, maxChunkBytes: 256, modelSearchBudgetBytes: 0 };
    expect(extractLastMessage(wirePath, 'assistant', false, tail)).toBe(parts.join(''));
    expect(extractLastAssistantTurn(wirePath, false, tail)).toEqual({ text: parts.join('') });
  });

  it('strips a system reminder after joining its text blocks', () => {
    const transcript = multipartTurn(['Done.<system-reminder>hidden ', 'instructions</system-reminder>\nTests pass.']);
    expect(extractLastMessageFromJsonl(transcript, 'assistant', true)).toBe('Done.\nTests pass.');
  });

  it('retains the text already written by an unfinished step', () => {
    const transcript = jsonl([begin('interrupted'), part('interrupted', 0, 'First paragraph. '), part('interrupted', 1, 'Second paragraph.')]);
    expect(extractLastMessageFromJsonl(transcript, 'assistant', false)).toBe('First paragraph. Second paragraph.');
  });

  it('hands the complete answer to the observer through the real Kimi Stop adapter', async () => {
    writeFileSync(wirePath, multipartTurn(['Implemented the redirect.\n', 'Verified the regression.']));
    const input = kimiAdapter.normalizeInput({
      hook_event_name: 'Stop', session_id: 'session_multipart', cwd: root,
      client_type: 'cli', stop_hook_active: false,
    });
    input.platform = 'kimi';
    expect(input.transcriptPath).toBe(wirePath);
    const result = await summarizeHandler.execute(input);
    expect(result.exitCode).toBe(0);
    const summaries = spooledEntries('summarize');
    expect(summaries).toHaveLength(1);
    expect(summaries[0].payload).toMatchObject({
      contentSessionId: 'session_multipart', platformSource: 'kimi',
      lastAssistantMessage: 'Implemented the redirect.\nVerified the regression.',
    });
  });
});
