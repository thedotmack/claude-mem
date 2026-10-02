import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  extractLastMessage,
  extractLastAssistantTurn,
  extractLastAssistantModel,
  findLastMessageInJsonl,
  TRANSCRIPT_TAIL_INITIAL_BYTES,
  TRANSCRIPT_TAIL_MAX_CHUNK_BYTES,
} from '../../src/shared/transcript-parser.js';

/**
 * The Stop hook used to `readFileSync(transcriptPath, 'utf-8')` the whole
 * transcript to find the last assistant turn. A 2.16 GB Claude Code session
 * pushed that past JavaScriptCore's 2^31-1 string cap (Bun reports it as
 * ENOMEM; Node as ERR_STRING_TOO_LONG) and every Stop summary for the session
 * was dropped. The parser now scans backwards in growing windows. These tests
 * force the multi-window path with a tiny `initialBytes` instead of a giant
 * fixture. The walk is bounded in memory by one chunk plus one carried line,
 * so there is NO cap on how far back the answer may sit - a regression to a
 * capped window is what the far-back tests below would catch.
 */

function assistantLine(text: string, model = 'claude-opus-4-1'): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', model, content: [{ type: 'text', text }] },
  });
}

function toolOnlyAssistantLine(toolName: string, model = 'claude-opus-4-1'): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      model,
      content: [{ type: 'tool_use', id: `toolu_${toolName}`, name: toolName, input: { command: 'ls' } }],
    },
  });
}

function userLine(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
}

function toolResultLine(sizeBytes: number): string {
  // A big tool_result user entry: the realistic filler between assistant turns.
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'x'.repeat(sizeBytes) }],
    },
  });
}

describe('transcript-parser tail read', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'claude-mem-tail-'));
    path = join(dir, 'transcript.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exports sane chunk constants (initial ≤ max chunk, max chunk far below the 2^31-1 string cap)', () => {
    expect(TRANSCRIPT_TAIL_INITIAL_BYTES).toBeGreaterThan(0);
    expect(TRANSCRIPT_TAIL_INITIAL_BYTES).toBeLessThanOrEqual(TRANSCRIPT_TAIL_MAX_CHUNK_BYTES);
    expect(TRANSCRIPT_TAIL_MAX_CHUNK_BYTES).toBeLessThan(0x1fffffe8); // V8 cap, the lower of the two
  });

  it('finds the last assistant text from the final window when it is small', () => {
    writeFileSync(path, [userLine('hi'), assistantLine('first'), userLine('more'), assistantLine('last answer')].join('\n') + '\n');
    expect(extractLastMessage(path, 'assistant')).toBe('last answer');
    expect(extractLastAssistantTurn(path)).toEqual({ text: 'last answer', model: 'claude-opus-4-1' });
    expect(extractLastAssistantModel(path)).toBe('claude-opus-4-1');
  });

  it('grows the window when the last assistant text sits past the first tail window', () => {
    // 3 KB of tool_result filler AFTER the last text turn; first window is 512 B.
    writeFileSync(path, [assistantLine('buried answer', 'claude-sonnet-4-5'), toolResultLine(3000), userLine('tail')].join('\n') + '\n');
    const opts = { initialBytes: 512, maxChunkBytes: 1024 * 1024 };
    expect(extractLastMessage(path, 'assistant', false, opts)).toBe('buried answer');
    expect(extractLastAssistantTurn(path, false, opts)).toEqual({ text: 'buried answer', model: 'claude-sonnet-4-5' });
    expect(extractLastAssistantModel(path, opts)).toBe('claude-sonnet-4-5');
  });

  it('does not return a tool-only synthesis from a partial window when real text lies further back', () => {
    // Tail: real text, then 3 KB filler, then a tool-only assistant turn at the very end.
    // A 512 B first window sees ONLY the tool-only turn. The pure parser would
    // synthesize "[Session ended mid-task. Last tools used: Bash(ls)]" for it —
    // the tail scanner must keep growing instead and surface the real text.
    writeFileSync(path, [assistantLine('real text before the tool run'), toolResultLine(3000), toolOnlyAssistantLine('Bash')].join('\n') + '\n');
    const opts = { initialBytes: 512, maxChunkBytes: 1024 * 1024 };

    // Sanity: the pure parser on just the last line really does synthesize.
    const lastLineOnly = toolOnlyAssistantLine('Bash');
    expect(findLastMessageInJsonl(lastLineOnly, 'assistant', false)).toEqual({
      kind: 'synthesized',
      text: '[Session ended mid-task. Last tools used: Bash(ls)]',
    });

    expect(extractLastMessage(path, 'assistant', false, opts)).toBe('real text before the tool run');
    expect(extractLastAssistantTurn(path, false, opts).text).toBe('real text before the tool run');
  });

  it('still synthesizes a tool description when the WHOLE transcript is tool-only (final window)', () => {
    writeFileSync(path, [userLine('go'), toolOnlyAssistantLine('Read'), toolResultLine(3000), toolOnlyAssistantLine('Bash')].join('\n') + '\n');
    const opts = { initialBytes: 512, maxChunkBytes: 1024 * 1024 };
    expect(extractLastMessage(path, 'assistant', false, opts)).toBe('[Session ended mid-task. Last tools used: Bash(ls)]');
  });

  it('reaches an answer arbitrarily far back: the chunk size is a memory bound, not a search cap', () => {
    // Greptile P1 on the first revision: a capped window could not reach an
    // answer buried under more trailing tool output than the cap, and the hook
    // posted a tool-only description instead. Here the only text is behind
    // ~3 MB of filler and the max chunk is 64 KB, so the walk must cross ~50
    // chunk boundaries - and must NOT return the tool-only synthesis it sees
    // in the very first chunk.
    const filler = Array.from({ length: 30 }, () => toolResultLine(100_000));
    writeFileSync(path, [assistantLine('far back answer', 'claude-haiku-4-5'), ...filler, toolOnlyAssistantLine('Grep')].join('\n') + '\n');
    const opts = { initialBytes: 4096, maxChunkBytes: 64 * 1024 };
    expect(extractLastMessage(path, 'assistant', false, opts)).toBe('far back answer');
    // Model is the NEWEST assistant model (the tool-only turn's), as a whole-file read would report.
    expect(extractLastAssistantTurn(path, false, opts)).toEqual({ text: 'far back answer', model: 'claude-opus-4-1' });
    expect(extractLastAssistantModel(path, opts)).toBe('claude-opus-4-1');
    // And with NO later tool-use turn at all (Greptile's third artifact): still found, never empty.
    writeFileSync(path, [assistantLine('far back answer'), ...filler].join('\n') + '\n');
    expect(extractLastMessage(path, 'assistant', false, opts)).toBe('far back answer');
  });

  it('carries a single line that spans many chunks without tearing it', () => {
    // One 1 MB tool_result line walked with 16 KB chunks: the line is torn
    // across ~64 chunk boundaries and must be reassembled, and the assistant
    // text before it must still parse.
    writeFileSync(path, [assistantLine('before the giant line'), toolResultLine(1_000_000), userLine('tail')].join('\n') + '\n');
    const opts = { initialBytes: 16 * 1024, maxChunkBytes: 16 * 1024 };
    expect(extractLastMessage(path, 'assistant', false, opts)).toBe('before the giant line');
    expect(extractLastMessage(path, 'user', false, opts)).toBe('tail');
  });

  it('drops the partial first line of a window instead of parsing a torn JSON line', () => {
    // Window boundary deliberately lands inside the filler line. The torn
    // fragment must not be mistaken for an entry, and the real last text must
    // still be found on the next window.
    const lines = [assistantLine('ok'), toolResultLine(700), assistantLine('final')];
    writeFileSync(path, lines.join('\n') + '\n');
    const total = statSync(path).size;
    // Window that cuts the 700-byte filler line in half.
    const initialBytes = total - Buffer.byteLength(lines[0]) - 1 - 350;
    expect(extractLastMessage(path, 'assistant', false, { initialBytes, maxChunkBytes: 1024 * 1024 })).toBe('final');
  });

  it('handles a transcript without a trailing newline and a single-line transcript', () => {
    writeFileSync(path, assistantLine('only line'));
    expect(extractLastMessage(path, 'assistant', false, { initialBytes: 16, maxChunkBytes: 4096 })).toBe('only line');
    expect(extractLastAssistantModel(path, { initialBytes: 16, maxChunkBytes: 4096 })).toBe('claude-opus-4-1');
  });

  it('returns empty results for a missing or empty transcript without throwing', () => {
    expect(extractLastMessage(join(dir, 'nope.jsonl'), 'assistant')).toBe('');
    expect(extractLastAssistantTurn(join(dir, 'nope.jsonl'))).toEqual({ text: '' });
    expect(extractLastAssistantModel(join(dir, 'nope.jsonl'))).toBeUndefined();
    writeFileSync(path, '');
    expect(extractLastMessage(path, 'assistant')).toBe('');
    expect(extractLastAssistantModel(path)).toBeUndefined();
    writeFileSync(path, '\n\n  \n');
    expect(extractLastMessage(path, 'assistant')).toBe('');
  });

  it('finds the last USER message through the same window walk', () => {
    writeFileSync(path, [userLine('first ask'), assistantLine('a'), toolResultLine(3000), userLine('final ask')].join('\n') + '\n');
    expect(extractLastMessage(path, 'user', false, { initialBytes: 64, maxChunkBytes: 1024 * 1024 })).toBe('final ask');
    // And a user text that is only reachable by growing past the filler.
    writeFileSync(path, [userLine('buried ask'), assistantLine('a'), toolResultLine(3000)].join('\n') + '\n');
    expect(extractLastMessage(path, 'user', false, { initialBytes: 64, maxChunkBytes: 1024 * 1024 })).toBe('buried ask');
  });
});
