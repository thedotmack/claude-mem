import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import * as workerUtils from '../../src/shared/worker-utils.js';
import { runMemoryCommand } from '../../src/services/memory/cli.js';
import type { MemoryIngestReport } from '../../src/services/memory/ingest.js';

describe('memory ingest CLI', () => {
  const spies: Array<{ mockRestore(): void }> = [];

  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  it('names every skipped note and its reason', async () => {
    const report: MemoryIngestReport = {
      source: '/projects/-home-u-repo/memory',
      all: false,
      dirs: 1,
      found: 3,
      stored: 1,
      deduped: 1,
      skipped: 1,
      failed: 0,
      cwdUnresolvedDirs: 0,
      files: [
        { project: 'repo', file: 'kept.md', status: 'stored', observationId: 7 },
        { project: 'repo', file: 'seen.md', status: 'deduped' },
        { project: 'repo', file: 'notes.md', status: 'skipped', reason: 'symlink (not followed)' },
      ],
    };
    const lines: string[] = [];
    spies.push(
      spyOn(workerUtils, 'ensureWorkerRunning').mockResolvedValue(true),
      spyOn(workerUtils, 'workerHttpRequest').mockResolvedValue(new Response(JSON.stringify(report))),
      spyOn(console, 'log').mockImplementation((line: unknown) => {
        lines.push(String(line));
      }),
    );

    expect(await runMemoryCommand('ingest', ['--source', report.source])).toBe(0);

    expect(lines).toContain('repo/notes.md: skipped (symlink (not followed))');
    expect(lines).toContain('repo/kept.md: stored -> obs #7');
    expect(lines.some(line => line.includes('seen.md'))).toBe(false);
  });
});
