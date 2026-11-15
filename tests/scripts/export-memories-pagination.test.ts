import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MAX_LISTING_LIMIT, MAX_LISTING_OFFSET } from '../../src/shared/listing-offset-cap.js';

// `/api/search` now bounds `limit` like the listing feeds. The exporter used to
// ask for `limit=999999` once and treat that single response as the complete
// history, so the ceiling would have truncated an export silently while it
// still printed "Export complete!".

const originalFetch = globalThis.fetch;
const originalDataDir = process.env.CLAUDE_MEM_DATA_DIR;
const originalNoMain = process.env.CLAUDE_MEM_EXPORT_MEMORIES_NO_MAIN;

interface Row { id: number; memory_session_id: string }

function rows(count: number, prefix: string): Row[] {
  return Array.from({ length: count }, (_, index) => ({ id: index + 1, memory_session_id: `${prefix}-${index}` }));
}

describe('export-memories search paging', () => {
  let tempDir: string | undefined;
  const consoleSpies: ReturnType<typeof spyOn>[] = [];

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
    else process.env.CLAUDE_MEM_DATA_DIR = originalDataDir;
    if (originalNoMain === undefined) delete process.env.CLAUDE_MEM_EXPORT_MEMORIES_NO_MAIN;
    else process.env.CLAUDE_MEM_EXPORT_MEMORIES_NO_MAIN = originalNoMain;
    consoleSpies.splice(0).forEach(spy => spy.mockRestore());
    if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
    mock.restore();
  });

  function setup(): string {
    tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-export-paging-'));
    process.env.CLAUDE_MEM_DATA_DIR = tempDir;
    process.env.CLAUDE_MEM_EXPORT_MEMORIES_NO_MAIN = '1';
    writeFileSync(join(tempDir, 'settings.json'), JSON.stringify({ CLAUDE_MEM_WORKER_PORT: '45678' }));
    consoleSpies.push(
      spyOn(console, 'log').mockImplementation(() => {}),
      spyOn(console, 'warn').mockImplementation(() => {}),
      spyOn(console, 'error').mockImplementation(() => {}),
    );
    return tempDir;
  }

  function servePages(
    dataset: { observations: Row[]; sessions: Row[]; prompts: Row[] },
    requested: URL[],
  ) {
    return mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('http://127.0.0.1:45678/api/search?')) {
        const parsed = new URL(url);
        requested.push(parsed);
        const limit = Number(parsed.searchParams.get('limit'));
        const offset = Number(parsed.searchParams.get('offset') ?? '0');
        const slice = (list: Row[]) => list.slice(offset, offset + limit);
        return new Response(JSON.stringify({
          observations: slice(dataset.observations),
          sessions: slice(dataset.sessions),
          prompts: slice(dataset.prompts),
        }), { status: 200 });
      }
      if (url === 'http://127.0.0.1:45678/api/sdk-sessions/batch') {
        return new Response('[]', { status: 200 });
      }
      return new Response('unexpected url', { status: 500 });
    });
  }

  it('exports every memory across bounded pages instead of truncating at one page', async () => {
    const dir = setup();
    const requested: URL[] = [];
    const dataset = { observations: rows(250, 'obs'), sessions: rows(120, 'sum'), prompts: rows(3, 'prompt') };
    globalThis.fetch = servePages(dataset, requested) as typeof fetch;

    const { exportMemories } = await import('../../scripts/export-memories.ts');
    const outputFile = join(dir, 'export.json');
    await exportMemories('needle', outputFile);

    const exported = JSON.parse(readFileSync(outputFile, 'utf-8'));
    expect(exported.totalObservations).toBe(250);
    expect(exported.totalSummaries).toBe(120);
    expect(exported.totalPrompts).toBe(3);
    expect(exported.observations).toHaveLength(250);
    expect(exported.searchTruncated).toBeUndefined();

    // 0 -> 100 -> 200, and every request stays inside the route's ceiling.
    expect(requested.map(url => url.searchParams.get('offset') ?? '0')).toEqual(['0', '100', '200']);
    expect(requested.every(url => Number(url.searchParams.get('limit')) <= MAX_LISTING_LIMIT)).toBe(true);

    const logs = consoleSpies[0].mock.calls.map(call => String(call[0])).join('\n');
    expect(logs).not.toContain('ceiling');
  });

  it('stops at the offset ceiling and says the export is truncated', async () => {
    const dir = setup();
    const requested: URL[] = [];
    const bulk = MAX_LISTING_OFFSET + MAX_LISTING_LIMIT + 50;
    const dataset = { observations: rows(bulk, 'obs'), sessions: [], prompts: [] };
    globalThis.fetch = servePages(dataset, requested) as typeof fetch;

    const { exportMemories } = await import('../../scripts/export-memories.ts');
    const outputFile = join(dir, 'export.json');
    await exportMemories('needle', outputFile);

    const exported = JSON.parse(readFileSync(outputFile, 'utf-8'));
    expect(exported.totalObservations).toBe(MAX_LISTING_OFFSET + MAX_LISTING_LIMIT);
    expect(exported.searchTruncated).toBe(true);
    expect(requested).toHaveLength(MAX_LISTING_OFFSET / MAX_LISTING_LIMIT + 1);
    expect(requested[requested.length - 1].searchParams.get('offset')).toBe(String(MAX_LISTING_OFFSET));

    const logs = consoleSpies[0].mock.calls.map(call => String(call[0])).join('\n');
    expect(logs).toContain('ceiling');
  });
});