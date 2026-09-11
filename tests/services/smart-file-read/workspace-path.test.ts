import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveWithinWorkspace } from '../../../src/services/smart-file-read/workspace-path.js';

describe('resolveWithinWorkspace (#3861)', () => {
  const workspace = join(tmpdir(), `claude-mem-ws-${process.pid}-${Date.now()}`);
  const insideFile = join(workspace, 'src', 'app.ts');
  const outsideDir = join(tmpdir(), `claude-mem-outside-${process.pid}-${Date.now()}`);
  const outsideFile = join(outsideDir, 'secret.txt');
  const escapeLink = join(workspace, 'escape-link');

  beforeAll(() => {
    mkdirSync(join(workspace, 'src'), { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(insideFile, 'export const ok = 1;\n');
    writeFileSync(outsideFile, 'super-secret\n');
    symlinkSync(outsideFile, escapeLink);
  });

  afterAll(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it('allows a file inside the workspace', async () => {
    const resolved = await resolveWithinWorkspace('src/app.ts', workspace);
    expect(resolved).toBe(realpathSync(insideFile));
  });

  it('allows the workspace root itself', async () => {
    const resolved = await resolveWithinWorkspace(workspace, workspace);
    expect(resolved).toBe(realpathSync(workspace));
  });

  it('denies an absolute path outside the workspace', async () => {
    await expect(resolveWithinWorkspace(outsideFile, workspace))
      .rejects.toThrow(/Access denied/);
  });

  it('denies a parent-directory traversal', async () => {
    await expect(resolveWithinWorkspace('../secret.txt', workspace))
      .rejects.toThrow(/Access denied/);
  });

  it('denies an in-workspace symlink that realpaths outside', async () => {
    await expect(resolveWithinWorkspace('escape-link', workspace))
      .rejects.toThrow(/Access denied/);
  });

  it('denies a home-relative credential path', async () => {
    await expect(resolveWithinWorkspace('~/.ssh/id_rsa', workspace))
      .rejects.toThrow(/Access denied/);
  });

  it('rejects an empty path', async () => {
    await expect(resolveWithinWorkspace('   ', workspace))
      .rejects.toThrow(/file_path is required/);
  });
});
