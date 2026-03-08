/**
 * Project Name Tests
 *
 * Tests project name extraction with git root detection.
 * Source: src/utils/project-name.ts
 */
import { describe, it, expect } from 'bun:test';
import { getProjectName } from '../../src/utils/project-name.js';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';

describe('getProjectName', () => {
  describe('with null/empty input', () => {
    it('returns unknown-project for null', () => {
      expect(getProjectName(null)).toBe('unknown-project');
    });

    it('returns unknown-project for empty string', () => {
      expect(getProjectName('')).toBe('unknown-project');
    });
  });

  describe('with git repo', () => {
    it('uses git root name when in repo root', () => {
      const tmp = mkdtempSync(path.join(os.tmpdir(), 'my-project-'));
      try {
        mkdirSync(path.join(tmp, '.git'));
        expect(getProjectName(tmp)).toBe(path.basename(tmp));
      } finally {
        rmSync(tmp, { recursive: true });
      }
    });

    it('uses git root name when in subdirectory', () => {
      const tmp = mkdtempSync(path.join(os.tmpdir(), 'my-project-'));
      try {
        mkdirSync(path.join(tmp, '.git'));
        const subdir = path.join(tmp, 'src', 'utils');
        mkdirSync(subdir, { recursive: true });
        expect(getProjectName(subdir)).toBe(path.basename(tmp));
      } finally {
        rmSync(tmp, { recursive: true });
      }
    });
  });

  describe('without git repo', () => {
    it('falls back to basename of cwd', () => {
      const tmp = mkdtempSync(path.join(os.tmpdir(), 'claude-mem-test-'));
      try {
        expect(getProjectName(tmp)).toBe(path.basename(tmp));
      } finally {
        rmSync(tmp, { recursive: true });
      }
    });
  });
});
