import { expect, test } from 'bun:test';
import { chronologicalConversations, conversationKey } from '../../../src/services/history-import/replay.js';

test('counts a conversation once across project moves and keeps the project for each chronological event', () => {
  // Structural inputs carry only ordering and identity fields; no dialogue or observer output is fabricated.
  const groups = [
    { source: 'claude-code' as const, id: '1', project: 'first', messages: [{timestampMs: 1}, {timestampMs: 3}] },
    { source: 'claude-code' as const, id: '1', project: 'second', messages: [{timestampMs: 2}] },
    { source: 'codex' as const, id: '1', project: 'first', messages: [{timestampMs: 4}] },
  ];
  expect(new Set(groups.map(conversationKey)).size).toBe(2);
  const chronological = [...chronologicalConversations(groups)];
  expect(chronological.map(turns => turns.map(({chat, message}) => [chat.project, message.timestampMs]))).toEqual([
    [['first', 1], ['second', 2], ['first', 3]],
    [['first', 4]],
  ]);
});
