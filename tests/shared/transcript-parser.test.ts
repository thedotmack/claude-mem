import { describe, it, expect, mock, beforeEach } from 'bun:test';

let mockExistsSync: (path: string) => boolean = () => false;
let mockReadFileSync: (path: string) => string = () => '';

mock.module('fs', () => ({
  existsSync: (path: string) => mockExistsSync(path),
  readFileSync: (path: string) => mockReadFileSync(path),
}));

mock.module('../../src/utils/logger.js', () => ({
  logger: { warn: () => {}, debug: () => {}, info: () => {}, error: () => {} },
}));

import { extractLastMessage } from '../../src/shared/transcript-parser.ts';

describe('extractLastMessage', () => {
  beforeEach(() => {
    mockExistsSync = () => false;
    mockReadFileSync = () => '';
  });

  it('returns string content from a valid JSONL line', () => {
    mockExistsSync = () => true;
    mockReadFileSync = () => '{"type":"assistant","message":{"content":"hello world"}}';

    const result = extractLastMessage('/tmp/transcript.jsonl', 'assistant');

    expect(result).toBe('hello world');
  });

  it('returns text from array content format', () => {
    mockExistsSync = () => true;
    mockReadFileSync = () => '{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}';

    const result = extractLastMessage('/tmp/transcript.jsonl', 'assistant');

    expect(result).toBe('hello');
  });

  it('skips malformed JSON lines and returns the last valid match', () => {
    mockExistsSync = () => true;
    mockReadFileSync = () => [
      '{"type":"assistant","message":{"content":"first"}}',
      '{broken',
      '{"type":"assistant","message":{"content":"third"}}',
    ].join('\n');

    const result = extractLastMessage('/tmp/transcript.jsonl', 'assistant');

    expect(result).toBe('third');
  });

  it('returns empty string when all lines are malformed', () => {
    mockExistsSync = () => true;
    mockReadFileSync = () => '{broken\n{also broken\n{still broken';

    const result = extractLastMessage('/tmp/transcript.jsonl', 'assistant');

    expect(result).toBe('');
  });

  it('returns empty string for unknown content format without throwing', () => {
    mockExistsSync = () => true;
    mockReadFileSync = () => '{"type":"assistant","message":{"content":42}}';

    const result = extractLastMessage('/tmp/transcript.jsonl', 'assistant');

    expect(result).toBe('');
  });

  it('returns empty string for an empty file', () => {
    mockExistsSync = () => true;
    mockReadFileSync = () => '';

    const result = extractLastMessage('/tmp/transcript.jsonl', 'assistant');

    expect(result).toBe('');
  });

  it('returns empty string when file does not exist', () => {
    mockExistsSync = () => false;

    const result = extractLastMessage('/tmp/transcript.jsonl', 'assistant');

    expect(result).toBe('');
  });

  it('returns empty string when no lines match the requested role', () => {
    mockExistsSync = () => true;
    mockReadFileSync = () => '{"type":"user","message":{"content":"a user message"}}';

    const result = extractLastMessage('/tmp/transcript.jsonl', 'assistant');

    expect(result).toBe('');
  });

  it('skips malformed JSON and falls back to earlier valid match', () => {
    mockExistsSync = () => true;
    mockReadFileSync = () => [
      '{"type":"assistant","message":{"content":"earlier valid"}}',
      '{broken json line',
    ].join('\n');

    const result = extractLastMessage('/tmp/transcript.jsonl', 'assistant');

    expect(result).toBe('earlier valid');
  });

  it('skips unknown content format and falls back to earlier valid match', () => {
    mockExistsSync = () => true;
    mockReadFileSync = () => [
      '{"type":"assistant","message":{"content":"real data"}}',
      '{"type":"assistant","message":{"content":42}}',
    ].join('\n');

    const result = extractLastMessage('/tmp/transcript.jsonl', 'assistant');

    expect(result).toBe('real data');
  });

  it('strips system-reminder tags when stripSystemReminders is true', () => {
    mockExistsSync = () => true;
    mockReadFileSync = () => '{"type":"assistant","message":{"content":"before <system-reminder>secret stuff</system-reminder> after"}}';

    const result = extractLastMessage('/tmp/transcript.jsonl', 'assistant', true);

    expect(result).toBe('before  after');
  });
});
