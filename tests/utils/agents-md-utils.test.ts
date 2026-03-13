import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { writeAgentsMd, isPathWithinHomeDirectory } from '../../src/utils/agents-md-utils.js';
import { logger } from '../../src/utils/logger.js';
import { homedir } from 'os';
import { existsSync, readFileSync, unlinkSync, mkdirSync, rmdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

describe('agents-md-utils', () => {
  beforeEach(() => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
  });

  describe('isPathWithinHomeDirectory', () => {
    const home = homedir();

    it('accepts paths within home directory', () => {
      expect(isPathWithinHomeDirectory(join(home, '.codex', 'AGENTS.md'))).toBe(true);
      expect(isPathWithinHomeDirectory(join(home, 'project', 'AGENTS.md'))).toBe(true);
      expect(isPathWithinHomeDirectory(join(home, '.claude-mem', 'data'))).toBe(true);
    });

    it('rejects paths outside home directory', () => {
      expect(isPathWithinHomeDirectory('/etc/passwd')).toBe(false);
      expect(isPathWithinHomeDirectory('/tmp/evil')).toBe(false);
      expect(isPathWithinHomeDirectory('/var/log/syslog')).toBe(false);
    });

    it('rejects paths that are prefixes of home but not subdirectories', () => {
      // e.g., if home is /Users/alex, reject /Users/alexevil
      expect(isPathWithinHomeDirectory(home + 'evil')).toBe(false);
    });

    it('accepts the home directory itself', () => {
      expect(isPathWithinHomeDirectory(home)).toBe(true);
    });
  });

  describe('writeAgentsMd', () => {
    it('blocks writes to paths outside home directory', () => {
      writeAgentsMd('/etc/evil-agents.md', 'malicious content');

      const warnSpy = loggerSpies.find(s => s.getMockImplementation !== undefined);
      expect(logger.warn).toHaveBeenCalledWith(
        'AGENTS_MD',
        'Blocked write to path outside home directory',
        expect.objectContaining({ agentsPath: '/etc/evil-agents.md' })
      );
    });

    it('blocks writes to /tmp paths', () => {
      writeAgentsMd('/tmp/agents.md', 'content');
      expect(logger.warn).toHaveBeenCalled();
    });

    it('allows writes within home directory', () => {
      const testDir = join(homedir(), '.claude-mem', 'test-agents-md');
      const testFile = join(testDir, 'AGENTS.md');

      try {
        writeAgentsMd(testFile, 'test context');
        expect(existsSync(testFile)).toBe(true);
        const content = readFileSync(testFile, 'utf-8');
        expect(content).toContain('test context');
      } finally {
        try { unlinkSync(testFile); } catch {}
        try { rmdirSync(testDir); } catch {}
      }
    });

    it('still blocks .git paths', () => {
      const gitPath = join(homedir(), 'project', '.git', 'refs', 'AGENTS.md');
      writeAgentsMd(gitPath, 'content');
      // Should silently return without writing — no warn for .git, it's a known block
      expect(existsSync(gitPath)).toBe(false);
    });
  });
});
