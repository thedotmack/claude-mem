import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The Aider sync contract against the real worker routes: `aider sync`
// fetches GET /api/context/inject (the same endpoint Cursor's context refresh
// uses) and writes it into `.claude-mem/aider-memory.md`. The scenario runs
// in a child process (tests/integrations/aider-sync-child.ts) so
// CLAUDE_MEM_DATA_DIR is set before any module freezes DATA_DIR/DB_PATH at
// import: a file-backed store seeded with a real session observation, a stub
// HTTP worker mounting the real SearchRoutes + MemoryRoutes, an explicit save
// over HTTP, then the default-fetch sync a user runs before a session.
//
// Known boundary, verified while building this test: a note saved only via
// POST /api/memory/save (a `manual-<project>` session with no concepts)
// never reaches /api/context/inject — the SessionStart compiler filters by
// the mode's observation concepts, and only GrokBotIndexWriter opts into
// manual saves. The child therefore also seeds a concept-tagged session
// observation, the shape the observer writes after a real agent session.
// A second boundary: inject renders the SessionStart index — decision
// titles and timeline, not full narratives (the full-observation set
// defaults to zero) — so the assertion is on the title, and full text is
// retrieved via search. The docs state both honestly: sync refreshes
// session memory; manual notes are searchable immediately and land in the
// file only as session memory, never as manual saves.
describe('Aider sync against the real worker routes', () => {
  let tmp: string | undefined;
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  it('saves a note via POST /api/memory/save and retrieves session memory via aider sync', async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'aider-sync-'));
    const projectDir = path.join(tmp, 'project');
    const dataDir = path.join(tmp, 'data');
    const configPath = path.join(projectDir, '.aider.conf.yml');
    const memoryFile = path.join(projectDir, '.claude-mem', 'aider-memory.md');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(configPath, 'model: openai/gpt-4o\n');

    const child = path.resolve(import.meta.dir, 'aider-sync-child.ts');
    const run = Bun.spawnSync([process.execPath, child], {
      cwd: path.resolve(import.meta.dir, '../..'),
      env: {
        ...process.env,
        CLAUDE_MEM_DATA_DIR: dataDir,
        AIDER_SYNC_PROJECT_DIR: projectDir,
        AIDER_SYNC_DATA_DIR: dataDir,
      } as Record<string, string>,
    });
    const stdout = run.stdout.toString();
    const result = JSON.parse(stdout.trim().split('\n').pop()!) as {
      seededId: number;
      saveOk: boolean;
      saveSuccess: boolean;
      saveId: number | null;
      syncCode: number;
      memoryFileExists: boolean;
      memoryContainsTitle: boolean;
      searchOk: boolean;
      searchFoundTitle: boolean;
    };
    expect(run.exitCode).toBe(0);
    expect(result.saveOk).toBe(true);
    expect(result.saveSuccess).toBe(true);
    expect(typeof result.saveId).toBe('number');
    expect(result.syncCode).toBe(0);
    expect(result.memoryFileExists).toBe(true);
    expect(result.memoryContainsTitle).toBe(true);
    expect(result.searchOk).toBe(true);
    expect(result.searchFoundTitle).toBe(true);

    // The file on disk — not just the child's word for it — holds the
    // seeded session observation.
    expect(existsSync(memoryFile)).toBe(true);
    expect(readFileSync(memoryFile, 'utf-8')).toContain('Local persistence choice');
  }, 30_000);
});
