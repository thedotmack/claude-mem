import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('preserves changed native notes with title dedup enabled and still skips exact replays', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'native-memory-revisions-'));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // paths.ts freezes CLAUDE_CONFIG_DIR at import: isolate the real HTTP/file
    // ingestion chain in a child instead of touching the user's memory files.
    child = Bun.spawn([process.execPath, '--preload', './tests/preload.ts', 'tests/fixtures/worker/native-memory-revisions.ts'], {
      cwd: join(import.meta.dir, '../..'),
      env: {
        ...process.env,
        CLAUDE_MEM_DATA_DIR: dataDir,
        CLAUDE_CONFIG_DIR: join(dataDir, 'claude'),
        CLAUDE_MEM_DEDUP_ENABLED: 'true',
      },
      stdout: 'pipe', stderr: 'pipe',
    });
    const exitCode = await Promise.race([child.exited, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Native memory revision fixture exceeded 8 seconds')), 8000);
    })]);
    const output = await new Response(child.stdout).text() + await new Response(child.stderr).text();
    expect(exitCode, output).toBe(0);
  } finally {
    if (timer) clearTimeout(timer);
    if (child && child.exitCode === null) { child.kill(); await child.exited; }
    rmSync(dataDir, { recursive: true, force: true });
  }
}, 10000);
