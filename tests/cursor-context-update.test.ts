import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { writeContextFile } from '../src/utils/cursor-utils';

// Read-back helper for verifying writeContextFile output.
function readContextFile(workspacePath: string): string | null {
  const rulesFile = join(workspacePath, '.cursor', 'rules', 'claude-mem-context.mdc');
  if (!existsSync(rulesFile)) return null;
  return readFileSync(rulesFile, 'utf-8');
}

describe('Cursor Context Update', () => {
  let tempDir: string;
  let workspacePath: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `cursor-context-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    workspacePath = join(tempDir, 'my-project');
    mkdirSync(workspacePath, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('writeContextFile', () => {
    it('writes the complete context rule', () => {
      writeContextFile(workspacePath, 'test context');

      expect(readContextFile(workspacePath)).toBe(`---
alwaysApply: true
description: "Claude-mem context from past sessions (auto-updated)"
---

# Memory Context from Past Sessions

The following context is from claude-mem, a persistent memory system that tracks your coding sessions.

test context

---
*Updated after last session. Use claude-mem's MCP search tools for more detailed queries.*
`);
    });

    it('uses atomic write (no temp file left behind)', () => {
      writeContextFile(workspacePath, 'test context');

      const tempFile = join(workspacePath, '.cursor', 'rules', 'claude-mem-context.mdc.tmp');
      expect(existsSync(tempFile)).toBe(false);
    });

    it('overwrites existing context file', () => {
      writeContextFile(workspacePath, 'first context');
      writeContextFile(workspacePath, 'second context');

      const content = readContextFile(workspacePath);
      expect(content).not.toContain('first context');
      expect(content).toContain('second context');
    });

  });

  describe('edge cases', () => {

    it('preserves BMP unicode and strips astral emoji (issue #2787)', () => {
      const unicodeContext = 'Emoji: 🚀 Japanese: 日本語 Arabic: العربية';

      writeContextFile(workspacePath, unicodeContext);

      const content = readContextFile(workspacePath);
      // BMP scripts must survive untouched.
      expect(content).toContain('日本語');
      expect(content).toContain('العربية');
      // Astral emoji are sanitized to BMP so a Claude Code context truncation
      // can't split a surrogate pair and brick the session.
      expect(content).not.toContain('🚀');
      for (let i = 0; i < content!.length; i++) {
        const code = content!.charCodeAt(i);
        expect(code < 0xd800 || code > 0xdfff).toBe(true);
      }
    });

    it('works when .cursor directory already exists', () => {
      mkdirSync(join(workspacePath, '.cursor', 'other'), { recursive: true });
      writeFileSync(join(workspacePath, '.cursor', 'other', 'file.txt'), 'existing');

      writeContextFile(workspacePath, 'new context');

      expect(existsSync(join(workspacePath, '.cursor', 'other', 'file.txt'))).toBe(true);
      expect(readContextFile(workspacePath)).toContain('new context');
    });
  });
});
