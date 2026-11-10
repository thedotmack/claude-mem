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

  it('does not treat a code fence after a first-line BOM as plain text', () => {
    const example = `﻿\`\`\`md\n${CONTEXT_TAG_OPEN}\nexample only\n${CONTEXT_TAG_CLOSE}\n\`\`\`\n`;
    expect(rangeOf(`${example}\n${block}\n`)).toBe(block);
  });

  it('does not take a delimiter indented four spaces, which is indented code', () => {
    const example = `    ${CONTEXT_TAG_OPEN}\n    example only\n    ${CONTEXT_TAG_CLOSE}\n`;
    expect(rangeOf(`${example}\n${block}\n`)).toBe(block);
    expect(findContextBlockRange(example)).toBeNull();
  });

  it('leaves both tags on one line alone, since no writer produces that form', () => {
    expect(findContextBlockRange(`${CONTEXT_TAG_OPEN}example${CONTEXT_TAG_CLOSE}\n`)).toBeNull();
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

  describe('inject into new file', () => {

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
    it.each(['- - -', '* * *', '___', '  -  -  -', '-\t-\t-'])('preserves an authored fence after thematic break %j', (divider) => {
      const filePath = join(tempDir, 'CLAUDE.md');
      const before = `${divider}\n  ~~~md\n${CONTEXT_TAG_OPEN}\nexample only\n${CONTEXT_TAG_CLOSE}\n  ~~~\n\n`;
      writeFileSync(filePath, `${before}${CONTEXT_TAG_OPEN}\nold memory\n${CONTEXT_TAG_CLOSE}\n`);

      injectContextIntoMarkdownFile(filePath, 'current memory');
      injectContextIntoMarkdownFile(filePath, 'current memory');

      expect(readFileSync(filePath, 'utf-8')).toBe(
        `${before}${CONTEXT_TAG_OPEN}\ncurrent memory\n${CONTEXT_TAG_CLOSE}\n`,
      );
    });

    it.each(['- - - -', '- * * *', '- outer\n  - - -'])('preserves list-owned code after a nested divider %j', (divider) => {
      const filePath = join(tempDir, 'CLAUDE.md');
      const before = `${divider}\n  ~~~md\n  ${CONTEXT_TAG_OPEN}\n  example only\n  ${CONTEXT_TAG_CLOSE}\n  ~~~\n\n`;
      writeFileSync(filePath, `${before}${CONTEXT_TAG_OPEN}\nold memory\n${CONTEXT_TAG_CLOSE}\n`);

      injectContextIntoMarkdownFile(filePath, 'current memory');
      injectContextIntoMarkdownFile(filePath, 'current memory');

      expect(readFileSync(filePath, 'utf-8')).toBe(
        `${before}${CONTEXT_TAG_OPEN}\ncurrent memory\n${CONTEXT_TAG_CLOSE}\n`,
      );
    });

    it.each([
      '- ~~~sh\n  npm test\n  ~~~\n\n',
      '- ```sh\n  npm test\n  ```\n\n',
      '1) ~~~sh\n   npm test\n   ~~~\n\n',
      '1. ```sh\n   npm test\n   ```\n\n',
      '10. ~~~sh\n    npm test\n      ~~~\n\n',
      '- - ~~~sh\n    npm test\n    ~~~\n\n',
      '- parent\n  - ~~~sh\n    npm test\n    ~~~\n\n',
      '- ~~~sh\n  unfinished command\n\n',
      '-     ~~~sh\n      indented code\n  ~~~\n\n',
      '-\t~~~sh\n\tnpm test\n\t~~~\n\n',
    ])('preserves list-owned code and refreshes one managed block twice: %j', (before) => {
      const filePath = join(tempDir, 'CLAUDE.md');
      const after = '\n\nKeep this footer.\n';
      writeFileSync(filePath, `${before}${CONTEXT_TAG_OPEN}\nold memory\n${CONTEXT_TAG_CLOSE}${after}`);

      injectContextIntoMarkdownFile(filePath, 'current memory');
      injectContextIntoMarkdownFile(filePath, 'current memory');

      expect(readFileSync(filePath, 'utf-8')).toBe(
        `${before}${CONTEXT_TAG_OPEN}\ncurrent memory\n${CONTEXT_TAG_CLOSE}${after}`,
      );
    });

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

    it.each([
      ['an unclosed top-level fence', '# Notes\n\n```sh\nnpm test\n\n'],
      ['a lone fence inside an HTML comment', '<!--\n```\n-->\n\n'],
      ['a list fence closed flush left', '- ```sh\n  npm test\n```\n\n'],
      ['a shorter closer inside a longer fence', '````md\ncode\n```\n\n'],
    ])('keeps exactly one block across refreshes after %s', (_name, before) => {
      const filePath = join(tempDir, 'CLAUDE.md');
      writeFileSync(filePath, `${before}${CONTEXT_TAG_OPEN}\nold memory\n${CONTEXT_TAG_CLOSE}\n`);

      for (let refresh = 0; refresh < 3; refresh++) {
        injectContextIntoMarkdownFile(filePath, 'current memory');
      }

      expect(readFileSync(filePath, 'utf-8')).toBe(
        `${before}${CONTEXT_TAG_OPEN}\ncurrent memory\n${CONTEXT_TAG_CLOSE}\n`,
      );
    });

    it('appends once and then replaces when an unclosed fence comes before no block at all', () => {
      const filePath = join(tempDir, 'CLAUDE.md');
      writeFileSync(filePath, '```sh\nnpm test\n');

      for (let refresh = 0; refresh < 3; refresh++) {
        injectContextIntoMarkdownFile(filePath, 'current memory');
      }

      expect(readFileSync(filePath, 'utf-8')).toBe(
        `\`\`\`sh\nnpm test\n\n${CONTEXT_TAG_OPEN}\ncurrent memory\n${CONTEXT_TAG_CLOSE}\n`,
      );
    });

    it.each([
      ['a BOM before the opening tag', '﻿', '', '', ''],
      ['trailing spaces on both delimiters', '', '  ', '', ' \t'],
      ['a two-space indent on both delimiters', '  ', '', '  ', ''],
    ])('keeps replacing a block with %s', (_name, openPrefix, openSuffix, closePrefix, closeSuffix) => {
      const filePath = join(tempDir, 'CLAUDE.md');
      writeFileSync(filePath, `${openPrefix}${CONTEXT_TAG_OPEN}${openSuffix}\nold memory\n${closePrefix}${CONTEXT_TAG_CLOSE}${closeSuffix}\nKeep this.\n`);

      for (let refresh = 0; refresh < 3; refresh++) {
        injectContextIntoMarkdownFile(filePath, 'current memory');
      }

      expect(readFileSync(filePath, 'utf-8')).toBe(
        `${openPrefix}${CONTEXT_TAG_OPEN}\ncurrent memory\n${CONTEXT_TAG_CLOSE}${closeSuffix}\nKeep this.\n`,
      );
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

  });

  describe('append to existing file', () => {
    it('trims trailing whitespace and appends exactly one separated context block', () => {
      const filePath = join(tempDir, 'CLAUDE.md');
      writeFileSync(filePath, '# Header\n\n\n   \n');

      injectContextIntoMarkdownFile(filePath, 'data');

      expect(readFileSync(filePath, 'utf-8')).toBe(
        `# Header\n\n${CONTEXT_TAG_OPEN}\ndata\n${CONTEXT_TAG_CLOSE}\n`,
      );
    });
  });

});
