import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  injectContextIntoMarkdownFile,
  CONTEXT_TAG_OPEN,
  CONTEXT_TAG_CLOSE,
} from '../src/utils/context-injection';

/**
 * Tests for the shared context injection utility.
 *
 * injectContextIntoMarkdownFile is used by MCP integrations and OpenCode
 * installer to inject or update a <claude-mem-context> section in markdown files.
 */

describe('Context Injection', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `context-injection-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('tag constants', () => {
    it('exports correct open and close tags', () => {
      expect(CONTEXT_TAG_OPEN).toBe('<claude-mem-context>');
      expect(CONTEXT_TAG_CLOSE).toBe('</claude-mem-context>');
    });
  });

  describe('inject into new file', () => {
    it('creates a new file with context tags when file does not exist', () => {
      const filePath = join(tempDir, 'CLAUDE.md');

      injectContextIntoMarkdownFile(filePath, 'Hello world');

      expect(existsSync(filePath)).toBe(true);
      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain(CONTEXT_TAG_OPEN);
      expect(content).toContain('Hello world');
      expect(content).toContain(CONTEXT_TAG_CLOSE);
    });

    it('creates parent directories if they do not exist', () => {
      const filePath = join(tempDir, 'nested', 'deep', 'CLAUDE.md');

      injectContextIntoMarkdownFile(filePath, 'test content');

      expect(existsSync(filePath)).toBe(true);
    });

    it('writes content wrapped in context tags', () => {
      const filePath = join(tempDir, 'CLAUDE.md');
      const contextContent = '# Recent Activity\n\nSome memory data here.';

      injectContextIntoMarkdownFile(filePath, contextContent);

      const content = readFileSync(filePath, 'utf-8');
      const expected = `${CONTEXT_TAG_OPEN}\n${contextContent}\n${CONTEXT_TAG_CLOSE}\n`;
      expect(content).toBe(expected);
    });
  });

  describe('headerLine support', () => {
    it('prepends headerLine when creating a new file', () => {
      const filePath = join(tempDir, 'AGENTS.md');
      const headerLine = '# Claude-Mem Memory Context';

      injectContextIntoMarkdownFile(filePath, 'context data', headerLine);

      const content = readFileSync(filePath, 'utf-8');
      expect(content.startsWith(headerLine)).toBe(true);
      expect(content).toContain(CONTEXT_TAG_OPEN);
      expect(content).toContain('context data');
    });

    it('places a blank line between headerLine and context tags', () => {
      const filePath = join(tempDir, 'AGENTS.md');
      const headerLine = '# My Header';

      injectContextIntoMarkdownFile(filePath, 'data', headerLine);

      const content = readFileSync(filePath, 'utf-8');
      expect(content).toBe(`${headerLine}\n\n${CONTEXT_TAG_OPEN}\ndata\n${CONTEXT_TAG_CLOSE}\n`);
    });

    it('does not use headerLine when file already exists', () => {
      const filePath = join(tempDir, 'AGENTS.md');
      writeFileSync(filePath, '# Existing Content\n\nSome stuff.\n');

      injectContextIntoMarkdownFile(filePath, 'new context', '# Should Not Appear');

      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('# Existing Content');
      expect(content).not.toContain('# Should Not Appear');
      expect(content).toContain('new context');
    });
  });

  describe('replace existing context section', () => {
    it('replaces content between existing context tags', () => {
      const filePath = join(tempDir, 'CLAUDE.md');
      const initialContent = [
        '# Project Instructions',
        '',
        `${CONTEXT_TAG_OPEN}`,
        'Old context data',
        `${CONTEXT_TAG_CLOSE}`,
        '',
        '## Other stuff',
      ].join('\n');
      writeFileSync(filePath, initialContent);

      injectContextIntoMarkdownFile(filePath, 'New context data');

      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('New context data');
      expect(content).not.toContain('Old context data');
      expect(content).toContain('# Project Instructions');
      expect(content).toContain('## Other stuff');
    });

    it('preserves content before and after the context section', () => {
      const filePath = join(tempDir, 'CLAUDE.md');
      const before = '# Header\n\nSome instructions.\n\n';
      const after = '\n\n## Footer\n\nMore content.\n';
      const initialContent = `${before}${CONTEXT_TAG_OPEN}\nold\n${CONTEXT_TAG_CLOSE}${after}`;
      writeFileSync(filePath, initialContent);

      injectContextIntoMarkdownFile(filePath, 'replaced');

      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('# Header');
      expect(content).toContain('Some instructions.');
      expect(content).toContain('## Footer');
      expect(content).toContain('More content.');
      expect(content).toContain('replaced');
      expect(content).not.toContain('old');
    });
  });

  describe('append to existing file', () => {
    it('appends context section to file without existing tags', () => {
      const filePath = join(tempDir, 'CLAUDE.md');
      writeFileSync(filePath, '# My Project\n\nInstructions here.\n');

      injectContextIntoMarkdownFile(filePath, 'appended context');

      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('# My Project');
      expect(content).toContain('Instructions here.');
      expect(content).toContain(CONTEXT_TAG_OPEN);
      expect(content).toContain('appended context');
      expect(content).toContain(CONTEXT_TAG_CLOSE);
    });

    it('separates appended section with a blank line', () => {
      const filePath = join(tempDir, 'CLAUDE.md');
      writeFileSync(filePath, '# Header');

      injectContextIntoMarkdownFile(filePath, 'data');

      const content = readFileSync(filePath, 'utf-8');
      // Should have double newline before the tag
      expect(content).toContain(`# Header\n\n${CONTEXT_TAG_OPEN}`);
    });

    it('trims trailing whitespace before appending', () => {
      const filePath = join(tempDir, 'CLAUDE.md');
      writeFileSync(filePath, '# Header\n\n\n   \n');

      injectContextIntoMarkdownFile(filePath, 'data');

      const content = readFileSync(filePath, 'utf-8');
      // Should not have excessive whitespace before the tag
      expect(content).toContain(`# Header\n\n${CONTEXT_TAG_OPEN}`);
    });
  });

  describe('idempotency', () => {
    it('produces same result when called twice with same content', () => {
      const filePath = join(tempDir, 'CLAUDE.md');

      injectContextIntoMarkdownFile(filePath, 'stable content');
      const firstWrite = readFileSync(filePath, 'utf-8');

      injectContextIntoMarkdownFile(filePath, 'stable content');
      const secondWrite = readFileSync(filePath, 'utf-8');

      expect(secondWrite).toBe(firstWrite);
    });

    it('updates content when called with different data', () => {
      const filePath = join(tempDir, 'CLAUDE.md');

      injectContextIntoMarkdownFile(filePath, 'version 1');
      injectContextIntoMarkdownFile(filePath, 'version 2');

      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('version 2');
      expect(content).not.toContain('version 1');
    });
  });
});
