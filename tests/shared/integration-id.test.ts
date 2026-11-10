import { describe, expect, it } from 'bun:test';
import { canonicalIntegrationId } from '../../src/shared/integration-id.js';
import { detectInstalledIDEs } from '../../src/npx-cli/commands/ide-detection.js';

describe("'claude' is an alias for Claude Code (#2835)", () => {
  it('canonicalizes claude and leaves every other id alone', () => {
    expect(canonicalIntegrationId('claude')).toBe('claude-code');
    expect(canonicalIntegrationId('claude-code')).toBe('claude-code');
    expect(canonicalIntegrationId('cursor')).toBe('cursor');
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(canonicalIntegrationId(name)).toBe(name);
    }
  });

  it('names an IDE the installer knows, so --ide claude is not an unknown IDE', () => {
    const ids = detectInstalledIDEs().map((ide) => ide.id);
    expect(ids).not.toContain('claude');
    expect(ids).toContain(canonicalIntegrationId('claude'));
  });
});
