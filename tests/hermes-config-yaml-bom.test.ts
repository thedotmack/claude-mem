import { describe, expect, it } from 'bun:test';
import {
  HermesConfigShapeError,
  putMcpServer,
  removeMcpServer,
  restoreMemoryProvider,
  selectMemoryProvider,
} from '../src/services/integrations/hermes-config-yaml.js';

describe('Hermes config edits on files other editors wrote', () => {
  it('edits beside a leading byte-order mark instead of adding a second memory block', () => {
    const original = '﻿memory:\n  memory_enabled: true\n';
    const { text, receipt } = selectMemoryProvider(original, 'claude-mem');
    expect(text).toBe('﻿memory:\n  provider: claude-mem\n  memory_enabled: true\n');
    expect(text.match(/^memory:/gm)).toBeNull();
    expect(text.split('memory:').length - 1).toBe(1);
    expect(restoreMemoryProvider(text, 'claude-mem', receipt)).toBe(original);
  });

  it('keeps the mark and the CRLF endings when it adds an MCP server', () => {
    const original = '﻿mcp_servers:\r\n  other:\r\n    command: x\r\n';
    const { text } = putMcpServer(original, 'claude-mem', { command: 'node', args: ['mcp-server.cjs'] });
    expect(text.startsWith('﻿mcp_servers:\r\n')).toBe(true);
    expect(text.split('mcp_servers:').length - 1).toBe(1);
  });

  it('refuses a file whose root keys are all indented, and changes nothing', () => {
    const original = '  memory:\n    memory_enabled: true\n';
    expect(() => selectMemoryProvider(original, 'claude-mem')).toThrow(HermesConfigShapeError);
  });

  it('refuses an indented root that follows a document marker or a directive', () => {
    for (const original of ['---\n  memory:\n    provider: old\n', '%YAML 1.2\n---\n  memory:\n    provider: old\n']) {
      expect(() => selectMemoryProvider(original, 'claude-mem')).toThrow(HermesConfigShapeError);
    }
  });

  it('still edits a normal root that follows a document marker', () => {
    const { text } = selectMemoryProvider('---\nmemory:\n  memory_enabled: true\n', 'claude-mem');
    expect(text).toBe('---\nmemory:\n  provider: claude-mem\n  memory_enabled: true\n');
  });

  it('gives back a file that held only the mark once the added block is removed', () => {
    const selected = selectMemoryProvider('\uFEFF', 'claude-mem');
    expect(restoreMemoryProvider(selected.text, 'claude-mem', selected.receipt)).toBe('\uFEFF');
    const put = putMcpServer('\uFEFF', 'claude-mem', { command: 'node', args: ['mcp-server.cjs'] });
    expect(removeMcpServer(put.text, 'claude-mem', put.receipt)).toBe('\uFEFF');
  });
});
