import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { writeClaudeMdToFolder } from '../../src/utils/claude-md-utils.js';
import { writeAgentsMd } from '../../src/utils/agents-md-utils.js';
import { logger } from '../../src/utils/logger.js';

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

    it(`${label}: resolves a dangling relative link against the physical directory`, () => {
      // project/rules -> dotfiles/rules, and dotfiles/rules/<file> -> ../shared.md
      // (dangling). The link lives in dotfiles/rules, so the write belongs in
      // dotfiles/shared.md; project/shared.md must never be created or clobbered.
      mkdirSync(path.join(store, 'rules'), { recursive: true });
      symlinkSync(path.join(store, 'rules'), path.join(folder, 'rules'));
      symlinkSync('../shared.md', path.join(store, 'rules', filename));
      const bystander = path.join(folder, 'shared.md');
      writeFileSync(bystander, 'not yours\n');

      write(path.join(folder, 'rules'), filename);

      expect(readFileSync(path.join(store, 'shared.md'), 'utf-8')).toContain('fresh context');
      expect(readFileSync(bystander, 'utf-8')).toBe('not yours\n');
      expect(lstatSync(path.join(store, 'rules', filename)).isSymbolicLink()).toBe(true);
    });

    it(`${label}: creates the missing directory of a dangling symlink's target`, () => {
      const real = path.join(store, 'nested', 'deeper', 'rules.md');
      const link = path.join(folder, filename);
      symlinkSync(real, link);

      write(folder, filename);

      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readFileSync(real, 'utf-8')).toContain('fresh context');
    });
  }

  for (const [loopLabel, makeLoop] of [
    ['a self-loop', (link: string) => symlinkSync(path.basename(link), link)],
    ['a two-link loop', (link: string) => {
      symlinkSync('other.md', link);
      symlinkSync(path.basename(link), path.join(path.dirname(link), 'other.md'));
    }],
  ] as const) {
    it(`writeClaudeMdToFolder throws on ${loopLabel} and leaves the link in place`, () => {
      const link = path.join(folder, 'CLAUDE.md');
      makeLoop(link);

      expect(() => writeClaudeMdToFolder(folder, 'fresh context', 'CLAUDE.md')).toThrow();

      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(existsSync(`${link}.tmp`)).toBe(false);
    });

    it(`writeAgentsMd logs on ${loopLabel} and leaves the link in place`, () => {
      const link = path.join(folder, 'AGENTS.md');
      makeLoop(link);
      const errorSpy = spyOn(logger, 'error').mockImplementation(() => {});
      try {
        expect(() => writeAgentsMd(link, 'fresh context')).not.toThrow();
        expect(errorSpy).toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
      }

      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(existsSync(`${link}.tmp`)).toBe(false);
    });
  }
});
