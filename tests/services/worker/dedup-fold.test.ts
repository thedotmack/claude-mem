import { describe, it, expect } from 'bun:test';
import { computeFoldKey } from '../../../src/services/worker/dedup-fold.js';

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
