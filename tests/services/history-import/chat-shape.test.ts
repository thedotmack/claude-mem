import { describe, expect, it } from 'bun:test';
import { activeBranch, messageTime, type ChatNode } from '../../../src/services/history-import/chat-shape.js';

// Date and graph invariants can be tested without copying or inventing any user's messages.
describe('source dates', () => {
  it('preserves the instant including a timezone offset and fractional second', () => {
    const ms = Date.parse('2025-12-17T16:42:43.456Z');
    expect(messageTime('2025-12-17T08:42:43.456-08:00')).toBe(ms);
    expect(messageTime(ms / 1000)).toBe(ms);
  });

  it('rejects missing timezones and invalid calendar dates instead of moving observations to import day', () => {
    for (const date of [undefined, null, '2025-12-03', '2025-12-17T16:42:43', '2026-02-29T10:00:00Z']) {
      expect(messageTime(date)).toBeNaN();
    }
  });
});

describe('active branch', () => {
  const node = (id: string, parent = ''): ChatNode => ({ id, parent, data: {} });
  it('follows explicit parent links and rejects an ambiguous or incomplete graph', () => {
    const fork = [node('root'), node('one', 'root'), node('two', 'root')];
    expect(activeBranch(fork, 'two')?.map(n => n.id)).toEqual(['root', 'two']);
    expect(activeBranch(fork, '')).toBeNull();
    expect(activeBranch([node('tip', 'missing')], 'tip')).toBeNull();
    expect(activeBranch([node('tip', 'tip')], 'tip')).toBeNull();
  });
});
