import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  injectContextIntoMarkdownFile,
  findContextBlockRange,
  CONTEXT_TAG_OPEN,
  CONTEXT_TAG_CLOSE,
} from '../src/utils/context-injection';

// Every writer and cleaner of the managed block pairs its tags through this one
// helper: the inject and folder CLAUDE.md writers, `claude-mem generate`, and
// the Codex and OpenCode AGENTS.md cleanups.
describe('findContextBlockRange', () => {
  const block = `${CONTEXT_TAG_OPEN}\nold\n${CONTEXT_TAG_CLOSE}`;
  const rangeOf = (content: string) => {
    const range = findContextBlockRange(content);
    return range && content.slice(range.start, range.end);
  };

  it('finds the block on its own', () => {
    expect(rangeOf(`# Notes\n\n${block}\n`)).toBe(block);
  });

  it('skips a closing tag that comes before the block', () => {
    expect(rangeOf(`Mentions ${CONTEXT_TAG_CLOSE} in prose.\n\n${block}\n`)).toBe(block);
  });

  it('pairs the closing tag with its nearest opening tag, so a dangling one earlier keeps the text after it', () => {
    expect(rangeOf(`Mentions ${CONTEXT_TAG_OPEN} in prose.\n\nKeep this.\n\n${block}\n`)).toBe(block);
  });

  it('does not treat a balanced inline-code example as the managed block', () => {
    const example = `Preserve the \`${CONTEXT_TAG_OPEN} ... ${CONTEXT_TAG_CLOSE}\` marker names in examples.`;
    expect(rangeOf(`${example}\n\n${block}\n`)).toBe(block);
    expect(findContextBlockRange(`${example}\n`)).toBeNull();
  });

  it('does not mistake a complete triple-backtick code span for an opening fence', () => {
    const example = `\`\`\`${CONTEXT_TAG_OPEN} ... ${CONTEXT_TAG_CLOSE}\`\`\``;
    expect(rangeOf(`${example}\n\n${block}\n`)).toBe(block);
  });

  it.each(['```md', '~~~md', '   ````markdown'])('skips managed-tag examples in a %s fence', (fence) => {
    const delimiter = fence.trimStart().match(/^[`~]+/)![0];
    const example = `${fence}\n${CONTEXT_TAG_OPEN}\nexample only\n${CONTEXT_TAG_CLOSE}\n${delimiter}\n`;
    expect(rangeOf(`${example}\n${block}\n`)).toBe(block);
    expect(findContextBlockRange(example)).toBeNull();
  });

  it('does not close a code fence at a delimiter followed by a non-breaking space', () => {
    const example = `\`\`\`md\n\`\`\`\u00a0\n${CONTEXT_TAG_OPEN}\nexample only\n${CONTEXT_TAG_CLOSE}\n\`\`\`\n`;
    expect(rangeOf(`${example}\n${block}\n`)).toBe(block);
  });

  it('closes a code fence at a delimiter followed only by tabs and spaces', () => {
    const example = `\`\`\`md\n${CONTEXT_TAG_OPEN}\nexample only\n${CONTEXT_TAG_CLOSE}\n\`\`\` \t \n`;
    expect(rangeOf(`${example}\n${block}\n`)).toBe(block);
  });

  it('retains canonical standalone delimiters with CRLF and no final newline', () => {
    const crlfBlock = `${CONTEXT_TAG_OPEN}\r\nold\r\n${CONTEXT_TAG_CLOSE}`;
    expect(rangeOf(`# Notes\r\n\r\n${crlfBlock}`)).toBe(crlfBlock);
  });

  it('is null without a complete block', () => {
    expect(findContextBlockRange('# Notes\n')).toBeNull();
    expect(findContextBlockRange(`${CONTEXT_TAG_OPEN}\nnever closed\n`)).toBeNull();
    expect(findContextBlockRange(`${CONTEXT_TAG_CLOSE}\nbefore any opening tag\n`)).toBeNull();
  });
});

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
    it('replaces managed memory even when its content has an unclosed code fence', () => {
      const filePath = join(tempDir, 'CLAUDE.md');
      injectContextIntoMarkdownFile(filePath, '```ts\nold partial code');

      injectContextIntoMarkdownFile(filePath, 'current memory');

      expect(readFileSync(filePath, 'utf-8')).toBe(
        `${CONTEXT_TAG_OPEN}\ncurrent memory\n${CONTEXT_TAG_CLOSE}\n`,
      );
    });

    it('preserves authored marker examples and refreshes the real block exactly once', () => {
      const filePath = join(tempDir, 'CLAUDE.md');
      const before = `# Project instructions\nPreserve \`${CONTEXT_TAG_OPEN} ... ${CONTEXT_TAG_CLOSE}\` in examples.\n\n` +
        `\`\`\`md\n${CONTEXT_TAG_OPEN}\nexample only\n${CONTEXT_TAG_CLOSE}\n\`\`\`\n\n`;
      const after = '\n\n## User-owned footer\nKeep this byte for byte.\n';
      writeFileSync(filePath, `${before}${CONTEXT_TAG_OPEN}\nold managed memory\n${CONTEXT_TAG_CLOSE}${after}`);

      injectContextIntoMarkdownFile(filePath, 'current managed memory');
      const expected = `${before}${CONTEXT_TAG_OPEN}\ncurrent managed memory\n${CONTEXT_TAG_CLOSE}${after}`;
      expect(readFileSync(filePath, 'utf-8')).toBe(expected);

      injectContextIntoMarkdownFile(filePath, 'current managed memory');
      expect(readFileSync(filePath, 'utf-8')).toBe(expected);
    });

    it('ignores a closing tag before the context section', () => {
      const filePath = join(tempDir, 'GEMINI.md');
      const before = `# Tag example\n${CONTEXT_TAG_CLOSE}\nKeep this line.\n`;
      const after = '\n## Other instructions\n';
      writeFileSync(filePath, `${before}${CONTEXT_TAG_OPEN}\nold\n${CONTEXT_TAG_CLOSE}${after}`);

      injectContextIntoMarkdownFile(filePath, 'new');

      expect(readFileSync(filePath, 'utf-8')).toBe(
        `${before}${CONTEXT_TAG_OPEN}\nnew\n${CONTEXT_TAG_CLOSE}${after}`,
      );
    });

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
      expect(content).toContain(`# Header\n\n${CONTEXT_TAG_OPEN}`);
    });

    it('trims trailing whitespace before appending', () => {
      const filePath = join(tempDir, 'CLAUDE.md');
      writeFileSync(filePath, '# Header\n\n\n   \n');

      injectContextIntoMarkdownFile(filePath, 'data');

      const content = readFileSync(filePath, 'utf-8');
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
