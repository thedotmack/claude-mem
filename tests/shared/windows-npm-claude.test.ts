import { describe, it, expect } from 'bun:test';
import { withNpmClaudeExe } from '../../src/shared/windows-npm-claude.js';

describe('withNpmClaudeExe (#5163)', () => {
  const NPM = 'C:\\Users\\u\\AppData\\Roaming\\npm';
  const PACKAGE_EXE = `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;

  it('drops the extension-less sh shim and adds the package claude.exe after claude.cmd', () => {
    const hits = [`${NPM}\\claude`, `${NPM}\\claude.cmd`];
    expect(withNpmClaudeExe(hits, (path) => path === PACKAGE_EXE)).toEqual([`${NPM}\\claude.cmd`, PACKAGE_EXE]);
  });

  it('leaves other installs alone', () => {
    const hits = ['C:\\tools\\claude.exe', 'C:\\Users\\u\\.local\\bin\\claude.exe'];
    expect(withNpmClaudeExe(hits, () => false)).toEqual(hits);
  });

  it('keeps claude.cmd when the package has no claude.exe', () => {
    expect(withNpmClaudeExe([`${NPM}\\claude.cmd`], () => false)).toEqual([`${NPM}\\claude.cmd`]);
  });
});
