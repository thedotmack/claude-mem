import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import path from 'path';
import { extractLastMessageFromJsonl } from '../../src/shared/transcript-parser.js';

const fixture = readFileSync(
  path.join(import.meta.dir, '..', 'fixtures', 'kimi-wire.sample.jsonl'),
  'utf-8'
);

describe('kimi wire.jsonl extraction', () => {
  test('extracts last assistant text part, skipping think parts', () => {
    expect(extractLastMessageFromJsonl(fixture, 'assistant', false)).toBe('Final answer text');
  });

  test('extracts last user message text', () => {
    expect(extractLastMessageFromJsonl(fixture, 'user', false)).toBe('Second user question');
  });

  test('returns empty string for wire content with no matching role', () => {
    const onlyTool = '{"type":"context.append_loop_event","event":{"type":"tool.call","toolName":"Bash","callId":"c1","input":{}}}\n';
    expect(extractLastMessageFromJsonl(onlyTool, 'assistant', false)).toBe('');
  });

  test('claude-format lines still work alongside the kimi branch', () => {
    const claude = '{"type":"assistant","message":{"content":[{"type":"text","text":"claude text"}]}}\n';
    expect(extractLastMessageFromJsonl(claude, 'assistant', false)).toBe('claude text');
  });
});
