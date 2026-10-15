import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { writeClaudeMdToFolder } from '../../src/utils/claude-md-utils.js';
import { writeAgentsMd } from '../../src/utils/agents-md-utils.js';

// A CLAUDE.md / AGENTS.md that is a symlink (dotfiles repo, shared rules file)
// must stay a symlink when claude-mem refreshes its context block.
describe.skipIf(process.platform === 'win32')('context file refresh keeps symlinks', () => {
  let tmp: string;
  let folder: string;
  let store: string;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'md-symlink-')));
    folder = path.join(tmp, 'project');
    store = path.join(tmp, 'dotfiles');
    mkdirSync(folder, { recursive: true });
    mkdirSync(store, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  for (const [label, filename, write] of [
    ['writeClaudeMdToFolder', 'CLAUDE.md', (dir: string, f: string) => writeClaudeMdToFolder(dir, 'fresh context', f)],
    ['writeAgentsMd', 'AGENTS.md', (dir: string, f: string) => writeAgentsMd(path.join(dir, f), 'fresh context')],
  ] as const) {
    it(`${label}: writes through a symlink to the real file`, () => {
      const real = path.join(store, 'shared.md');
      writeFileSync(real, '# my rules\n');
      const link = path.join(folder, filename);
      symlinkSync(real, link);

      write(folder, filename);

      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(real);
      const content = readFileSync(real, 'utf-8');
      expect(content).toContain('# my rules');
      expect(content).toContain('fresh context');
      expect(existsSync(`${real}.tmp`)).toBe(false);
      expect(existsSync(`${link}.tmp`)).toBe(false);
    });

    it(`${label}: creates the target of a dangling symlink instead of replacing the link`, () => {
      const real = path.join(store, 'not-yet.md');
      const link = path.join(folder, filename);
      symlinkSync(real, link);

      write(folder, filename);

      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readFileSync(real, 'utf-8')).toContain('fresh context');
    });
  }
});
