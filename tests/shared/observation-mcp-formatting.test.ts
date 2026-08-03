import { describe, expect, it } from 'bun:test';
import {
  formatObservationContext,
  formatObservationDetails,
} from '../../src/shared/observation-mcp-formatting.js';

describe('observation MCP formatting', () => {
  it('keeps useful worker observation content and drops persistence metadata', () => {
    const observation = {
      id: 42,
      memory_session_id: 'memory-session-that-should-not-leak',
      project: 'claude-mem/cleanup',
      text: 'legacy duplicate text',
      type: 'bugfix',
      title: 'Compact MCP observation output',
      subtitle: 'Removed the raw SQLite row from tool results',
      narrative: 'The MCP boundary now renders only the fields an agent needs.',
      facts: JSON.stringify(['Batch fetch still works', 'REST consumers keep the raw response']),
      concepts: JSON.stringify(['progressive-disclosure', 'token-efficiency']),
      files_read: JSON.stringify(['src/old-reader.ts', 'src/shared.ts']),
      files_modified: JSON.stringify(['src/shared.ts', 'src/mcp.ts']),
      prompt_number: 17,
      discovery_tokens: 912,
      created_at: '2026-08-03T18:20:00.000Z',
      created_at_epoch: Date.parse('2026-08-03T18:20:00.000Z'),
      content_hash: 'deadbeef',
      generated_by_model: 'expensive-model-label',
      relevance_count: 9,
      merged_into_project: null,
      agent_type: 'subagent',
      agent_id: 'agent-123',
      metadata: JSON.stringify({ internal: 'rot' }),
      synced_at: 1_775_000_000_000,
      origin_device_id: 'device-123',
      origin_local_id: '42',
      sync_rev: '8',
    };

    const rawJson = JSON.stringify([observation], null, 2);
    const formatted = formatObservationDetails([observation]);

    expect(formatted).toContain('# 1 observation · `claude-mem/cleanup`');
    expect(formatted).toContain('## #42 — Compact MCP observation output');
    expect(formatted).toContain('`bugfix` · 2026-08-03 18:20Z');
    expect(formatted).toContain('The MCP boundary now renders only the fields an agent needs.');
    expect(formatted).toContain('- Batch fetch still works');
    expect(formatted).toContain('Concepts: progressive-disclosure, token-efficiency');
    expect(formatted).toContain('Modified: `src/shared.ts`, `src/mcp.ts`');
    expect(formatted).toContain('Read: `src/old-reader.ts`');

    for (const noisyValue of [
      'memory_session_id',
      'legacy duplicate text',
      'content_hash',
      'generated_by_model',
      'relevance_count',
      'agent-123',
      'device-123',
      'sync_rev',
      '"internal"',
    ]) {
      expect(formatted).not.toContain(noisyValue);
    }
    expect(formatted.length).toBeLessThan(rawJson.length * 0.5);
  });

  it('uses structured server metadata once instead of repeating rendered content', () => {
    const formatted = formatObservationDetails({
      observations: [{
        id: 'obs-1',
        projectId: 'project-1',
        teamId: 'team-secret',
        serverSessionId: 'session-noise',
        kind: 'decision',
        content: 'Choose compact Markdown\n\nOne useful copy\n\n- Drop raw JSON',
        metadata: {
          title: 'Choose compact Markdown',
          narrative: 'One useful copy',
          facts: ['Drop raw JSON'],
          concepts: ['mcp'],
        },
        createdAtEpoch: Date.parse('2026-08-03T19:00:00.000Z'),
        updatedAtEpoch: Date.parse('2026-08-03T20:00:00.000Z'),
      }],
    });

    expect(formatted.match(/Choose compact Markdown/g)).toHaveLength(1);
    expect(formatted.match(/One useful copy/g)).toHaveLength(1);
    expect(formatted.match(/Drop raw JSON/g)).toHaveLength(1);
    expect(formatted).not.toContain('team-secret');
    expect(formatted).not.toContain('session-noise');
    expect(formatted).not.toContain('updatedAtEpoch');
  });

  it('keeps manual server content when a title is the only structured field', () => {
    const formatted = formatObservationDetails([{
      id: 'manual-1',
      kind: 'manual',
      content: 'The actual manual memory body.',
      metadata: { title: 'Pinned note' },
    }]);

    expect(formatted).toContain('Pinned note');
    expect(formatted).toContain('The actual manual memory body.');
  });

  it('renders context as content only, without an observations JSON wrapper', () => {
    const formatted = formatObservationContext([
      { id: 'o1', content: 'alpha', teamId: 'team-secret' },
      { id: 'o2', content: 'beta', metadata: { internal: 'rot' } },
    ]);

    expect(formatted).toBe('alpha\n\n---\n\nbeta');
  });

  it('handles empty and malformed payloads without leaking JSON', () => {
    expect(formatObservationDetails([])).toBe('No observations found.');
    expect(formatObservationDetails({ observations: 'not-an-array' })).toBe('No observations found.');
    expect(formatObservationContext(null)).toBe('No observations found.');

    const staleLists = formatObservationDetails([{
      id: 1,
      title: 'Old row',
      facts: 'null',
      concepts: '{}',
      files_read: '[]',
    }]);
    expect(staleLists).not.toContain('- null');
    expect(staleLists).not.toContain('Concepts:');
  });
});
