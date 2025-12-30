import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { writeContextFile, readContextFile } from '../src/utils/cursor-utils';

/**
 * Tests for Cursor Context Update functionality
 *
 * These tests validate that context files are correctly written to
 * .cursor/rules/claude-mem-context.mdc for registered projects.
 *
 * The context file uses Cursor's MDC format with frontmatter.
 */

describe('Cursor Context Update', () => {
  let tempDir: string;
  let workspacePath: string;

  beforeEach(() => {
    // Create unique temp directory for each test
    tempDir = join(tmpdir(), `cursor-context-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    workspacePath = join(tempDir, 'my-project');
    mkdirSync(workspacePath, { recursive: true });
  });

  afterEach(() => {
    // Clean up temp directory
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('writeContextFile', () => {
    it('creates .cursor/rules directory structure', () => {
      writeContextFile(workspacePath, 'test context');

      const rulesDir = join(workspacePath, '.cursor', 'rules');
      expect(existsSync(rulesDir)).toBe(true);
    });

    it('creates claude-mem-context.mdc file', () => {
      writeContextFile(workspacePath, 'test context');

      const rulesFile = join(workspacePath, '.cursor', 'rules', 'claude-mem-context.mdc');
      expect(existsSync(rulesFile)).toBe(true);
    });

    it('includes alwaysApply: true in frontmatter', () => {
      writeContextFile(workspacePath, 'test context');

      const content = readContextFile(workspacePath);
      expect(content).toContain('alwaysApply: true');
    });

    it('includes description in frontmatter', () => {
      writeContextFile(workspacePath, 'test context');

      const content = readContextFile(workspacePath);
      expect(content).toContain('description: "Claude-mem context from past sessions (auto-updated)"');
    });

    it('includes the provided context in the file body', () => {
      const testContext = `## Recent Session

- Fixed authentication bug
- Added new feature`;

      writeContextFile(workspacePath, testContext);

      const content = readContextFile(workspacePath);
      expect(content).toContain('Fixed authentication bug');
      expect(content).toContain('Added new feature');
    });

    it('includes Memory Context header', () => {
      writeContextFile(workspacePath, 'test');

      const content = readContextFile(workspacePath);
      expect(content).toContain('# Memory Context from Past Sessions');
    });

    it('includes footer with MCP tools mention', () => {
      writeContextFile(workspacePath, 'test');

      const content = readContextFile(workspacePath);
      expect(content).toContain("Use claude-mem's MCP search tools for more detailed queries");
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

    it('handles empty context gracefully', () => {
      writeContextFile(workspacePath, '');

      const content = readContextFile(workspacePath);
      expect(content).toBeDefined();
      expect(content).toContain('alwaysApply: true');
    });

    it('preserves multi-line context with proper formatting', () => {
      const multilineContext = `Line 1
Line 2
Line 3

Paragraph 2`;

      writeContextFile(workspacePath, multilineContext);

      const content = readContextFile(workspacePath);
      expect(content).toContain('Line 1\nLine 2\nLine 3');
      expect(content).toContain('Paragraph 2');
    });
  });

  describe('MDC format validation', () => {
    it('has valid YAML frontmatter delimiters', () => {
      writeContextFile(workspacePath, 'test');

      const content = readContextFile(workspacePath)!;
      const lines = content.split('\n');

      // First line should be ---
      expect(lines[0]).toBe('---');

      // Should have closing --- for frontmatter
      const secondDashIndex = lines.indexOf('---', 1);
      expect(secondDashIndex).toBeGreaterThan(0);
    });

    it('frontmatter is parseable as YAML', () => {
      writeContextFile(workspacePath, 'test');

      const content = readContextFile(workspacePath)!;
      const lines = content.split('\n');
      const frontmatterEnd = lines.indexOf('---', 1);

      const frontmatter = lines.slice(1, frontmatterEnd).join('\n');

      // Should contain valid YAML key-value pairs
      expect(frontmatter).toMatch(/alwaysApply:\s*true/);
      expect(frontmatter).toMatch(/description:\s*"/);
    });

    it('content after frontmatter is proper markdown', () => {
      writeContextFile(workspacePath, 'test');

      const content = readContextFile(workspacePath)!;

      // Should have markdown header
      expect(content).toMatch(/^# Memory Context/m);

      // Should have horizontal rule (---)
      // Note: The footer uses --- which is also a horizontal rule in markdown
      const bodyPart = content.split('---')[2]; // After frontmatter
      expect(bodyPart).toBeDefined();
    });
  });

  describe('edge cases', () => {
    it('handles special characters in context', () => {
      const specialContext = '`code` **bold** _italic_ <html> $variable @mention #tag';

      writeContextFile(workspacePath, specialContext);

      const content = readContextFile(workspacePath);
      expect(content).toContain('`code`');
      expect(content).toContain('**bold**');
      expect(content).toContain('<html>');
    });

    it('handles unicode in context', () => {
      const unicodeContext = 'Emoji: 🚀 Japanese: 日本語 Arabic: العربية';

      writeContextFile(workspacePath, unicodeContext);

      const content = readContextFile(workspacePath);
      expect(content).toContain('🚀');
      expect(content).toContain('日本語');
      expect(content).toContain('العربية');
    });

    it('handles very long context', () => {
      // 100KB of context
      const longContext = 'x'.repeat(100 * 1024);

      writeContextFile(workspacePath, longContext);

      const content = readContextFile(workspacePath);
      expect(content).toContain(longContext);
    });

    it('works when .cursor directory already exists', () => {
      // Pre-create .cursor with other content
      mkdirSync(join(workspacePath, '.cursor', 'other'), { recursive: true });
      writeFileSync(join(workspacePath, '.cursor', 'other', 'file.txt'), 'existing');

      writeContextFile(workspacePath, 'new context');

      // Should not destroy existing content
      expect(existsSync(join(workspacePath, '.cursor', 'other', 'file.txt'))).toBe(true);
      expect(readContextFile(workspacePath)).toContain('new context');
    });
  });
});
