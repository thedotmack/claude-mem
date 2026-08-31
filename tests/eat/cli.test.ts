import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { parseEatArgs, runEatCommand } from '../../src/services/worker/eat/cli.js';

const originalFetch = global.fetch;
const tempDirs: string[] = [];

afterEach(() => {
  global.fetch = originalFetch;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  mock.restore();
});

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

describe('runEatCommand local file transport', () => {
  it('uploads file bytes and provenance instead of sending a worker-local path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-mem-eat-cli-'));
    tempDirs.push(dir);
    const filePath = join(dir, 'README.md');
    writeFileSync(filePath, '# Local file', 'utf8');
    let requestBody: Record<string, unknown> | null = null;
    global.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          request_id: 'request-1',
          source: { kind: 'file', locator: resolve(filePath) },
          chunks: 1,
          observation_ids: [1],
          rejected: 0,
        }),
      } as Response;
    }) as unknown as typeof fetch;
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});

    expect(await runEatCommand([filePath, '--project', 'demo'])).toBe(0);
    expect(requestBody).toEqual({
      project: 'demo',
      content: '# Local file',
      content_source: { kind: 'file', locator: resolve(filePath) },
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
  });
});
