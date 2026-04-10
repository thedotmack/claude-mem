/**
 * Tests for isSafeContextPath — guards against path traversal via watch.context.path.
 * Fixes #1204: watch.context.path can write AGENTS.md content to arbitrary file paths.
 */

import { describe, it, expect } from 'bun:test';
import { homedir } from 'os';
import { resolve } from 'path';
import { isSafeContextPath } from '../../src/utils/agents-md-utils.js';

const HOME = homedir();
const PROJECT = resolve(HOME, 'projects', 'my-app');
const DATA_DIR = resolve(HOME, '.claude-mem');

describe('isSafeContextPath', () => {
  describe('allowed paths', () => {
    it('allows AGENTS.md directly in project root', () => {
      expect(isSafeContextPath(resolve(PROJECT, 'AGENTS.md'), PROJECT)).toBe(true);
    });

    it('allows a nested path within the project', () => {
      expect(isSafeContextPath(resolve(PROJECT, 'docs', 'AGENTS.md'), PROJECT)).toBe(true);
    });

    it('allows path within ~/.claude-mem/', () => {
      expect(isSafeContextPath(resolve(DATA_DIR, 'context.md'), PROJECT)).toBe(true);
    });

    it('allows nested path within ~/.claude-mem/', () => {
      expect(isSafeContextPath(resolve(DATA_DIR, 'projects', 'my-app', 'AGENTS.md'), PROJECT)).toBe(true);
    });
  });

  describe('path traversal attacks — must be rejected', () => {
    it('rejects ../../.bashrc relative traversal', () => {
      // ../../.bashrc from PROJECT resolves to HOME/.bashrc
      const traversal = resolve(PROJECT, '../../.bashrc');
      expect(isSafeContextPath(traversal, PROJECT)).toBe(false);
    });

    it('rejects ~/.ssh/authorized_keys', () => {
      expect(isSafeContextPath(resolve(HOME, '.ssh', 'authorized_keys'), PROJECT)).toBe(false);
    });

    it('rejects /etc/passwd', () => {
      expect(isSafeContextPath('/etc/passwd', PROJECT)).toBe(false);
    });

    it('rejects /tmp/evil.sh', () => {
      expect(isSafeContextPath('/tmp/evil.sh', PROJECT)).toBe(false);
    });

    it('rejects a sibling directory that shares the project prefix', () => {
      // e.g. projectRoot = /home/user/projects/my-app
      // attack path = /home/user/projects/my-app-evil/AGENTS.md
      const sibling = resolve(HOME, 'projects', 'my-app-evil', 'AGENTS.md');
      expect(isSafeContextPath(sibling, PROJECT)).toBe(false);
    });

    it('rejects the home directory itself', () => {
      expect(isSafeContextPath(HOME, PROJECT)).toBe(false);
    });

    it('rejects ~/.gitconfig', () => {
      expect(isSafeContextPath(resolve(HOME, '.gitconfig'), PROJECT)).toBe(false);
    });
  });
});
