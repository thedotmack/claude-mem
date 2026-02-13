import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { extractThinkingBlocks, type ThinkingBlock } from '../../../src/hooks/handlers/thinking.js';
import { logger } from '../../../src/utils/logger.js';

const TEST_DIR = join(tmpdir(), 'thinking-parser-test-' + process.pid);

function makeTranscriptLine(entry: Record<string, unknown>): string {
  return JSON.stringify(entry);
}

function writeTranscript(filename: string, lines: string[]): string {
  const filepath = join(TEST_DIR, filename);
  writeFileSync(filepath, lines.join('\n'), 'utf-8');
  return filepath;
}

let loggerSpies: ReturnType<typeof spyOn>[] = [];

describe('extractThinkingBlocks', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('extracts thinking blocks from assistant messages', () => {
    const transcript = writeTranscript('basic.jsonl', [
      makeTranscriptLine({
        type: 'assistant',
        timestamp: '2026-02-07T12:00:00Z',
        message: {
          content: [
            { type: 'thinking', thinking: 'Let me analyze this problem...' },
            { type: 'text', text: 'Here is my answer.' },
          ],
        },
      }),
    ]);

    const blocks = extractThinkingBlocks(transcript);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].thinking).toBe('Let me analyze this problem...');
    expect(blocks[0].messageIndex).toBe(0);
    expect(blocks[0].timestamp).toBe(new Date('2026-02-07T12:00:00Z').getTime());
  });

  it('extracts multiple thinking blocks from multiple assistant messages', () => {
    const transcript = writeTranscript('multi.jsonl', [
      makeTranscriptLine({
        type: 'user',
        timestamp: '2026-02-07T12:00:00Z',
        message: { content: 'Hello' },
      }),
      makeTranscriptLine({
        type: 'assistant',
        timestamp: '2026-02-07T12:01:00Z',
        message: {
          content: [
            { type: 'thinking', thinking: 'First thought' },
            { type: 'text', text: 'Response 1' },
          ],
        },
      }),
      makeTranscriptLine({
        type: 'assistant',
        timestamp: '2026-02-07T12:02:00Z',
        message: {
          content: [
            { type: 'thinking', thinking: 'Second thought' },
            { type: 'text', text: 'Response 2' },
          ],
        },
      }),
    ]);

    const blocks = extractThinkingBlocks(transcript);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].thinking).toBe('First thought');
    expect(blocks[0].messageIndex).toBe(1);
    expect(blocks[1].thinking).toBe('Second thought');
    expect(blocks[1].messageIndex).toBe(2);
  });

  it('returns empty array for empty transcript file', () => {
    const transcript = writeTranscript('empty.jsonl', []);
    // File exists but is empty
    writeFileSync(join(TEST_DIR, 'empty.jsonl'), '', 'utf-8');
    const blocks = extractThinkingBlocks(transcript);
    expect(blocks).toEqual([]);
  });

  it('returns empty array for transcript with no thinking blocks', () => {
    const transcript = writeTranscript('no-thinking.jsonl', [
      makeTranscriptLine({
        type: 'assistant',
        timestamp: '2026-02-07T12:00:00Z',
        message: {
          content: [{ type: 'text', text: 'Just text, no thinking.' }],
        },
      }),
    ]);

    const blocks = extractThinkingBlocks(transcript);
    expect(blocks).toEqual([]);
  });

  it('skips malformed JSON lines without throwing', () => {
    const filepath = join(TEST_DIR, 'malformed.jsonl');
    writeFileSync(
      filepath,
      [
        'not valid json',
        makeTranscriptLine({
          type: 'assistant',
          timestamp: '2026-02-07T12:00:00Z',
          message: {
            content: [{ type: 'thinking', thinking: 'Valid block after bad line' }],
          },
        }),
        '{broken json',
      ].join('\n'),
      'utf-8'
    );

    const blocks = extractThinkingBlocks(filepath);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].thinking).toBe('Valid block after bad line');
  });

  it('returns empty array for non-existent file path', () => {
    const blocks = extractThinkingBlocks('/nonexistent/path/file.jsonl');
    expect(blocks).toEqual([]);
  });

  it('returns empty array for empty string path', () => {
    const blocks = extractThinkingBlocks('');
    expect(blocks).toEqual([]);
  });

  it('skips thinking blocks where thinking is falsy', () => {
    const transcript = writeTranscript('falsy-thinking.jsonl', [
      makeTranscriptLine({
        type: 'assistant',
        timestamp: '2026-02-07T12:00:00Z',
        message: {
          content: [
            { type: 'thinking', thinking: '' },
            { type: 'thinking', thinking: 'Valid thinking' },
          ],
        },
      }),
    ]);

    const blocks = extractThinkingBlocks(transcript);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].thinking).toBe('Valid thinking');
  });

  it('ignores user and system entries', () => {
    const transcript = writeTranscript('mixed-types.jsonl', [
      makeTranscriptLine({
        type: 'user',
        timestamp: '2026-02-07T12:00:00Z',
        message: { content: 'User message' },
      }),
      makeTranscriptLine({
        type: 'system',
        timestamp: '2026-02-07T12:00:01Z',
        content: 'System message',
      }),
      makeTranscriptLine({
        type: 'summary',
        summary: 'A summary',
        leafUuid: 'test',
      }),
    ]);

    const blocks = extractThinkingBlocks(transcript);
    expect(blocks).toEqual([]);
  });

  it('uses Date.now() as fallback when timestamp is missing', () => {
    const beforeTime = Date.now();
    const transcript = writeTranscript('no-timestamp.jsonl', [
      makeTranscriptLine({
        type: 'assistant',
        message: {
          content: [{ type: 'thinking', thinking: 'No timestamp thinking' }],
        },
      }),
    ]);

    const blocks = extractThinkingBlocks(transcript);
    const afterTime = Date.now();

    expect(blocks).toHaveLength(1);
    expect(blocks[0].timestamp).toBeGreaterThanOrEqual(beforeTime);
    expect(blocks[0].timestamp).toBeLessThanOrEqual(afterTime);
  });

  it('handles assistant messages without content array', () => {
    const transcript = writeTranscript('no-content.jsonl', [
      makeTranscriptLine({
        type: 'assistant',
        timestamp: '2026-02-07T12:00:00Z',
        message: {},
      }),
      makeTranscriptLine({
        type: 'assistant',
        timestamp: '2026-02-07T12:01:00Z',
        message: { content: 'string content' },
      }),
    ]);

    const blocks = extractThinkingBlocks(transcript);
    expect(blocks).toEqual([]);
  });
});
