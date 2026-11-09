import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { cleanSingleFile } from '../../src/cli/claude-md-commands.js';
import { findTextBlock, removeTextBlock } from '../../src/services/wire-gateway/library/text-block.js';

const OPEN = '<claude-mem-context>';
const CLOSE = '</claude-mem-context>';

// Agent uninstalls (Antigravity's GEMINI.md and rules file among them) take
// the block out through the Library's text blocks, as library-engine does.
function removeContextTagBlock(file: string): boolean {
  const text = readFileSync(file, 'utf8');
  const range = findTextBlock(text, OPEN, CLOSE);
  if (!range) return false;
  writeFileSync(file, removeTextBlock(text, range));
  return true;
}

const authored = `# Notes\n\nKeep the \`${OPEN} ... ${CLOSE}\` markers in examples.\n\n\`\`\`md\n${OPEN}\nexample only\n${CLOSE}\n\`\`\`\n`;

const sandboxes: string[] = [];
afterEach(() => { for (const root of sandboxes.splice(0)) rmSync(root, { recursive: true, force: true }); });

function writeFixture(content: string): string {
  const root = mkdtempSync(join(tmpdir(), 'context-block-removal-'));
  sandboxes.push(root);
  const file = join(root, 'CLAUDE.md');
  writeFileSync(file, content);
  return file;
}

describe('removing the managed context block keeps authored examples', () => {
  it('claude-md clean removes every managed block and keeps authored examples', () => {
    const file = writeFixture(`${authored}\n${OPEN}\nfirst\n${CLOSE}\n\n${OPEN}\nsecond\n${CLOSE}\n`);
    expect(cleanSingleFile(file, 'CLAUDE.md', false)).toBe('cleaned');
    expect(readFileSync(file, 'utf8')).toBe(authored.trim());
  });

  it('claude-md clean deletes a file that held only the managed block', () => {
    const file = writeFixture(`${OPEN}\nonly\n${CLOSE}\n`);
    expect(cleanSingleFile(file, 'CLAUDE.md', false)).toBe('deleted');
  });

  it('Antigravity uninstall removes the managed block, not an earlier example', () => {
    const file = writeFixture(`${authored}\n${OPEN}\nmemory\n${CLOSE}\n\nFooter.\n`);
    expect(removeContextTagBlock(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(`${authored}\nFooter.\n`);
  });

  it('Antigravity uninstall leaves a file with only authored examples unchanged', () => {
    const file = writeFixture(authored);
    expect(removeContextTagBlock(file)).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(authored);
  });
});
