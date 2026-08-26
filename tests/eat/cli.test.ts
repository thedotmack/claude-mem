import { describe, expect, it } from 'bun:test';
import { parseEatArgs } from '../../src/services/worker/eat/cli.js';

describe('parseEatArgs', () => {
  it('parses a bare positional with defaults', () => {
    expect(parseEatArgs(['README.md'])).toEqual({
      positional: 'README.md',
      project: null,
      dryRun: false,
      json: false,
      recursive: false,
    });
  });

  it('parses all flags around the positional', () => {
    expect(parseEatArgs(['--project', 'demo', 'README.md', '--dry-run', '--json', '--recursive'])).toEqual({
      positional: 'README.md',
      project: 'demo',
      dryRun: true,
      json: true,
      recursive: true,
    });
  });

  it('treats "-" as the positional (explicit stdin)', () => {
    expect(parseEatArgs(['-', '--dry-run']).positional).toBe('-');
  });

  it('does not mistake the --project value for the positional', () => {
    const parsed = parseEatArgs(['--project', 'demo', '--json']);
    expect(parsed.positional).toBeUndefined();
    expect(parsed.project).toBe('demo');
  });

  it('returns undefined positional and null project for empty args', () => {
    expect(parseEatArgs([])).toEqual({
      positional: undefined,
      project: null,
      dryRun: false,
      json: false,
      recursive: false,
    });
  });

  it('handles a trailing --project with no value', () => {
    const parsed = parseEatArgs(['README.md', '--project']);
    expect(parsed.positional).toBe('README.md');
    expect(parsed.project).toBeNull();
  });

  it('parses the mcp subcommand with url, resource, and repeated headers', () => {
    const parsed = parseEatArgs([
      'mcp', 'https://mcp.example.com/mcp',
      '--resource', 'doc://readme',
      '--header', 'Authorization: Bearer token',
      '--header', 'X-Team: memory',
      '--project', 'demo',
      '--dry-run',
    ]);
    expect(parsed.mcp).toEqual({
      url: 'https://mcp.example.com/mcp',
      resource: 'doc://readme',
      headers: { Authorization: 'Bearer token', 'X-Team': 'memory' },
    });
    expect(parsed.positional).toBe('https://mcp.example.com/mcp');
    expect(parsed.project).toBe('demo');
    expect(parsed.dryRun).toBe(true);
  });

  it('parses a bare mcp subcommand with no url or extras', () => {
    const parsed = parseEatArgs(['mcp']);
    expect(parsed.mcp).toEqual({ url: undefined, resource: null, headers: {} });
    expect(parsed.positional).toBeUndefined();
  });

  it('does not mistake --resource or --header values for the mcp url', () => {
    const parsed = parseEatArgs(['mcp', '--resource', 'doc://readme', '--header', 'X-Team: memory']);
    expect(parsed.mcp?.url).toBeUndefined();
  });

  it('leaves mcp undefined for non-mcp invocations', () => {
    expect(parseEatArgs(['README.md']).mcp).toBeUndefined();
  });
});
