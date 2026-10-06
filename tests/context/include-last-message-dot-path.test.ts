// #2401 — "Include last message" silently no-ops when a cwd component contains
// a ".". Claude Code encodes its per-project transcript directory by replacing
// BOTH path separators AND dots with dashes (e.g. /Users/john.doe/proj ->
// -Users-john-doe-proj). cwdToDashed used to replace only "/", leaving a literal
// "." in the directory name, so the transcript file was never found.
//
// The transcript lookup for a dotted cwd runs against an isolated config dir in
// include-last-message-underscore-path.test.ts.

import { describe, it, expect } from 'bun:test';

describe('cwdToDashed (#2401)', () => {
  it('replaces both slashes and dots with dashes (matches Claude Code encoding)', async () => {
    const { cwdToDashed } = await import('../../src/services/context/ObservationCompiler.js');
    expect(cwdToDashed('/Users/john.doe/my-project')).toBe('-Users-john-doe-my-project');
  });

  it('still handles paths with no dots', async () => {
    const { cwdToDashed } = await import('../../src/services/context/ObservationCompiler.js');
    expect(cwdToDashed('/Users/jane/app')).toBe('-Users-jane-app');
  });

  it('encodes dotted directory components (e.g. version dirs)', async () => {
    const { cwdToDashed } = await import('../../src/services/context/ObservationCompiler.js');
    expect(cwdToDashed('/srv/app.v2.1/src')).toBe('-srv-app-v2-1-src');
  });
});
