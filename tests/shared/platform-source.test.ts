import { describe, expect, it } from 'bun:test';
import { resolvePlatformSourceForSession } from '../../src/shared/platform-source';

describe('platform source resolution', () => {
  it('keeps OpenClaw agent sessions sourced as openclaw even when provider hints mention Codex', () => {
    expect(resolvePlatformSourceForSession('openai-codex', {
      contentSessionId: 'openclaw-agent:researcher:telegram:group-123',
      project: 'openclaw-researcher',
    })).toBe('openclaw');
  });

  it('keeps non-OpenClaw Codex sessions sourced as codex', () => {
    expect(resolvePlatformSourceForSession('openai-codex', {
      contentSessionId: 'codex-session-123',
      project: 'seedsearch',
    })).toBe('codex');
  });

  it('does not classify repos whose names start with openclaw as OpenClaw sessions', () => {
    expect(resolvePlatformSourceForSession('openai-codex', {
      contentSessionId: 'codex-session-456',
      project: 'openclaw-fork-manager',
    })).toBe('codex');
  });
});
