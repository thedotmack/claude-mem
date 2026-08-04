import { describe, expect, it } from 'bun:test';

import { codexAdapter } from '../../../src/cli/adapters/codex.js';

function normalize(source: unknown) {
  return codexAdapter.normalizeInput({
    hook_event_name: 'SessionStart',
    session_id: 'session-source-test',
    cwd: process.cwd(),
    source,
  }).sessionSource;
}

describe('codex adapter sessionSource', () => {
  it('carries compact through so compaction can re-inject the timeline', () => {
    // Codex does emit a compact source; the adapter used to drop it, so a
    // compacted Codex session silently lost its memory injection.
    expect(normalize('compact')).toBe('compact');
  });

  it.each(['startup', 'resume', 'clear'])('still carries %s', (source) => {
    expect(normalize(source)).toBe(source);
  });

  it('ignores an unrecognized source', () => {
    expect(normalize('teleported')).toBeUndefined();
    expect(normalize(undefined)).toBeUndefined();
  });
});
