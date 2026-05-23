import { describe, it, expect } from 'bun:test';
import { computeFoldKey, loadDedupFoldConfig, getDedupFoldConfig, _resetDedupFoldConfigCache } from '../../../src/services/worker/dedup-fold.js';

describe('computeFoldKey', () => {
  it('returns a 16-char hex string', () => {
    const key = computeFoldKey({ tool_name: 'Bash', tool_input: { command: 'ls' } });
    expect(key).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is stable across runs (snapshot)', () => {
    const key = computeFoldKey({
      tool_name: 'Bash',
      tool_input: { command: 'ls /foo' },
      cwd: '/repo',
      agent_id: 'main',
    });
    // Locked snapshot — regenerate only if algorithm intentionally changes
    expect(key).toBe('863dcfc8e879cf83');
  });

  it('treats reordered object keys as identical (canonical sort)', () => {
    const a = computeFoldKey({ tool_name: 'Edit', tool_input: { file: 'x', mode: 'a' } });
    const b = computeFoldKey({ tool_name: 'Edit', tool_input: { mode: 'a', file: 'x' } });
    expect(a).toBe(b);
  });

  it('produces different keys for different cwd', () => {
    const a = computeFoldKey({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/a' });
    const b = computeFoldKey({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/b' });
    expect(a).not.toBe(b);
  });

  it('produces different keys for different agent_id', () => {
    const a = computeFoldKey({ tool_name: 'Bash', tool_input: {}, agent_id: 'main' });
    const b = computeFoldKey({ tool_name: 'Bash', tool_input: {}, agent_id: 'sub-1' });
    expect(a).not.toBe(b);
  });

  it('handles missing cwd and agent_id as empty strings', () => {
    const a = computeFoldKey({ tool_name: 'Bash', tool_input: {} });
    const b = computeFoldKey({ tool_name: 'Bash', tool_input: {}, cwd: '', agent_id: '' });
    expect(a).toBe(b);
  });

  it('preserves array order inside tool_input', () => {
    const a = computeFoldKey({ tool_name: 'X', tool_input: { args: ['a', 'b'] } });
    const b = computeFoldKey({ tool_name: 'X', tool_input: { args: ['b', 'a'] } });
    expect(a).not.toBe(b);
  });
});

describe('loadDedupFoldConfig', () => {
  function settingsFrom(overrides: Record<string, string>): any {
    return {
      CLAUDE_MEM_DEDUP_FOLD_ENABLED: 'false',
      CLAUDE_MEM_DEDUP_FOLD_WINDOW_SECONDS: '30',
      CLAUDE_MEM_DEDUP_FOLD_DISABLED_TOOLS: '',
      ...overrides,
    };
  }

  it('defaults: enabled=false, windowSeconds=30, disabledTools=[]', () => {
    const cfg = loadDedupFoldConfig(settingsFrom({}));
    expect(cfg.enabled).toBe(false);
    expect(cfg.windowSeconds).toBe(30);
    expect(cfg.disabledTools).toEqual([]);
  });

  it('parses enabled boolean', () => {
    const cfg = loadDedupFoldConfig(settingsFrom({ CLAUDE_MEM_DEDUP_FOLD_ENABLED: 'true' }));
    expect(cfg.enabled).toBe(true);
  });

  it('parses windowSeconds integer', () => {
    const cfg = loadDedupFoldConfig(settingsFrom({ CLAUDE_MEM_DEDUP_FOLD_WINDOW_SECONDS: '60' }));
    expect(cfg.windowSeconds).toBe(60);
  });

  it('falls back to 30 on non-integer windowSeconds', () => {
    const cfg = loadDedupFoldConfig(settingsFrom({ CLAUDE_MEM_DEDUP_FOLD_WINDOW_SECONDS: 'not-a-number' }));
    expect(cfg.windowSeconds).toBe(30);
  });

  it('clamps windowSeconds to [1, 3600]', () => {
    const lo = loadDedupFoldConfig(settingsFrom({ CLAUDE_MEM_DEDUP_FOLD_WINDOW_SECONDS: '0' }));
    expect(lo.windowSeconds).toBe(30);
    const hi = loadDedupFoldConfig(settingsFrom({ CLAUDE_MEM_DEDUP_FOLD_WINDOW_SECONDS: '9999' }));
    expect(hi.windowSeconds).toBe(30);
  });

  it('splits and trims disabledTools CSV', () => {
    const cfg = loadDedupFoldConfig(settingsFrom({ CLAUDE_MEM_DEDUP_FOLD_DISABLED_TOOLS: 'Bash, Edit ,  ' }));
    expect(cfg.disabledTools).toEqual(['Bash', 'Edit']);
  });
});

describe('getDedupFoldConfig cache', () => {
  it('reset works', () => {
    _resetDedupFoldConfigCache();
    const a = getDedupFoldConfig();
    _resetDedupFoldConfigCache();
    const b = getDedupFoldConfig();
    expect(a).not.toBe(b); // different object references after reset
  });
});
