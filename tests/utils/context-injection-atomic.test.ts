import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { injectContextIntoMarkdownFile } from '../../src/utils/context-injection.js';

const roots: string[] = [];
afterEach(() => {
  mock.restore();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; file: string; original: string } {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'context-atomic-')));
  roots.push(root);
  const file = join(root, 'CLAUDE.md');
  const original = '# Authored instructions\nKeep this text.\n\n<claude-mem-context>\nold\n</claude-mem-context>\nAfter the block.\n';
  fs.writeFileSync(file, original);
  return { root, file, original };
}

function failAfterPartialWrite(): void {
  const writeFile = fs.writeFileSync;
  const write = fs.writeSync;
  const diskFull = () => Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
    writeFile(file, String(data).slice(0, 8), options);
    throw diskFull();
  });
  let partial = false;
  spyOn(fs, 'writeSync').mockImplementation(((fd: number, data: Uint8Array) => {
    if (partial) throw diskFull();
    partial = true;
    return write(fd, data.subarray(0, 8));
  }) as typeof fs.writeSync);
}

describe('atomic context injection', () => {
  it('keeps authored instructions and the old block after a partial write fails', () => {
    const { root, file, original } = fixture();
    failAfterPartialWrite();
    expect(() => injectContextIntoMarkdownFile(file, 'new context')).toThrow('disk full');
    mock.restore();
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(fs.readdirSync(root)).toEqual(['CLAUDE.md']);
    injectContextIntoMarkdownFile(file, 'new context');
    expect(fs.readFileSync(file, 'utf8')).toBe(original.replace('\nold\n', '\nnew context\n'));
  });

  it('keeps the previous contents when flushing the staged file fails', () => {
    const { root, file, original } = fixture();
    spyOn(fs, 'fsyncSync').mockImplementation(() => { throw new Error('flush failed'); });
    expect(() => injectContextIntoMarkdownFile(file, 'new context')).toThrow('flush failed');
    mock.restore();
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(fs.readdirSync(root)).toEqual(['CLAUDE.md']);
  });

  it('does not publish an incomplete newly created context file', () => {
    const { root } = fixture();
    const file = join(root, 'new', 'GEMINI.md');
    failAfterPartialWrite();
    expect(() => injectContextIntoMarkdownFile(file, 'new context', '# Project')).toThrow('disk full');
    mock.restore();
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readdirSync(join(root, 'new'))).toEqual([]);
  });

  it('creates nested files with headers and preserves the existing output format', () => {
    const { root } = fixture();
    const file = join(root, 'nested', 'GEMINI.md');
    injectContextIntoMarkdownFile(file, 'fresh context', '# Project');
    expect(fs.readFileSync(file, 'utf8')).toBe('# Project\n\n<claude-mem-context>\nfresh context\n</claude-mem-context>\n');
  });

  it.skipIf(process.platform === 'win32')('preserves linked instructions and their permissions on failure and retry', () => {
    const { root, file, original } = fixture();
    const link = join(root, 'AGENTS.md');
    fs.symlinkSync('CLAUDE.md', link);
    fs.chmodSync(file, 0o640);
    failAfterPartialWrite();
    expect(() => injectContextIntoMarkdownFile(link, 'new context')).toThrow('disk full');
    mock.restore();
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(fs.readlinkSync(link)).toBe('CLAUDE.md');
    injectContextIntoMarkdownFile(link, 'new context');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o640);
    expect(fs.readFileSync(file, 'utf8')).toBe(original.replace('\nold\n', '\nnew context\n'));
  });
});
