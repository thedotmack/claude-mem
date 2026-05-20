import { describe, expect, it } from 'bun:test';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  buildSessionStartOutput,
  extractContext,
} = require('../plugin/scripts/codex-sessionstart-wrapper.cjs');

describe('codex-sessionstart-wrapper', () => {
  it('extracts context from Codex SessionStart hook output', () => {
    const raw = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: '  recent context  ',
      },
    });

    expect(extractContext(raw)).toBe('recent context');
  });

  it('ignores worker status JSON that Codex SessionStart cannot consume', () => {
    expect(extractContext(JSON.stringify({ status: 'ready', suppressOutput: true }))).toBe('');
  });

  it('emits empty stdout when no context exists', () => {
    expect(buildSessionStartOutput('')).toBe('');
  });

  it('wraps context in Codex SessionStart hookSpecificOutput', () => {
    expect(JSON.parse(buildSessionStartOutput('ctx'))).toEqual({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'ctx',
      },
    });
  });
});
