// Each claude-mem instruction reaches a Claude Code agent once. When the user's
// CLAUDE.md -> MY-RULES.md -> RULES-AND-TOOLS.md chain is in place, the MCP
// server instructions and the SessionStart pointer line stay quiet; anywhere
// else they keep delivering, so nothing is lost.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  claudeCodeAlreadyLoadsInstructions,
  claudeCodeImportLine,
  rulesAndToolsLoadedByClaudeCode,
  rulesAndToolsPointerLine,
  withoutLoadedRulesPointer,
  type RulesImportPaths,
} from '../../src/shared/claude-code-rules-import.js';

const INSTRUCTIONS = '# Work state: your to-do lists and working state\nUse work_state_write.';
const CLAUDE_CODE = { CLAUDECODE: '1' } as NodeJS.ProcessEnv;

let directory: string;
let paths: Required<RulesImportPaths>;

function writeChain(options: { claudeImportsRules?: boolean; rulesImportTools?: boolean; toolsText?: string | null } = {}): void {
  const { claudeImportsRules = true, rulesImportTools = true, toolsText = `# Claude-Mem Rules + Tools\n\n${INSTRUCTIONS}\n` } = options;
  writeFileSync(paths.claudeInstructionsPath, `# Mine\n${claudeImportsRules ? `${claudeCodeImportLine(paths.myRulesPath)}\n` : ''}`);
  writeFileSync(paths.myRulesPath, `# My Rules\n\n- Be plain.\n${rulesImportTools ? `\n${claudeCodeImportLine(paths.rulesAndToolsPath)}\n` : ''}`);
  if (toolsText !== null) writeFileSync(paths.rulesAndToolsPath, toolsText);
}

beforeEach(() => {
  // A space in the path: Claude Code ends an unescaped @path there.
  directory = mkdtempSync(join(tmpdir(), 'rules import test-'));
  mkdirSync(join(directory, 'claude'));
  paths = {
    claudeInstructionsPath: join(directory, 'claude', 'CLAUDE.md'),
    myRulesPath: join(directory, 'MY-RULES.md'),
    rulesAndToolsPath: join(directory, 'RULES-AND-TOOLS.md'),
  };
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe('Claude Code rules import chain', () => {
  it('is loaded only when every link and the final file are there', () => {
    writeChain();
    expect(rulesAndToolsLoadedByClaudeCode(paths)).toBe(true);
    writeChain({ claudeImportsRules: false });
    expect(rulesAndToolsLoadedByClaudeCode(paths)).toBe(false);
    writeChain({ rulesImportTools: false });
    expect(rulesAndToolsLoadedByClaudeCode(paths)).toBe(false);
    rmSync(paths.rulesAndToolsPath);
    writeChain({ toolsText: null });
    expect(rulesAndToolsLoadedByClaudeCode(paths)).toBe(false);
  });

  it('escapes spaces in the import line', () => {
    expect(claudeCodeImportLine(paths.myRulesPath)).toBe(`@${paths.myRulesPath.replaceAll(' ', '\\ ')}`);
  });
});

describe('MCP server instructions', () => {
  it('are skipped in Claude Code when the imported file holds the same text', () => {
    writeChain();
    expect(claudeCodeAlreadyLoadsInstructions(INSTRUCTIONS, CLAUDE_CODE, paths)).toBe(true);
  });

  it('are still sent to any other host', () => {
    writeChain();
    expect(claudeCodeAlreadyLoadsInstructions(INSTRUCTIONS, {} as NodeJS.ProcessEnv, paths)).toBe(false);
  });

  it('are still sent when the chain is incomplete or the file says something else', () => {
    writeChain({ rulesImportTools: false });
    expect(claudeCodeAlreadyLoadsInstructions(INSTRUCTIONS, CLAUDE_CODE, paths)).toBe(false);
    // A setting changed after the file was written, or another runtime's text.
    writeChain({ toolsText: '# Claude-Mem Rules + Tools\n\nolder text\n' });
    expect(claudeCodeAlreadyLoadsInstructions(INSTRUCTIONS, CLAUDE_CODE, paths)).toBe(false);
  });
});

describe('SessionStart pointer line', () => {
  it('is dropped when CLAUDE.md already loads the file it points to', () => {
    writeChain();
    const pointer = rulesAndToolsPointerLine(paths.rulesAndToolsPath);
    expect(withoutLoadedRulesPointer(`${pointer}\n\n# timeline`, paths)).toBe('# timeline');
    expect(withoutLoadedRulesPointer(pointer, paths)).toBe('');
  });

  it('stays when the chain is incomplete or the text starts differently', () => {
    writeChain({ claudeImportsRules: false });
    const pointer = rulesAndToolsPointerLine(paths.rulesAndToolsPath);
    expect(withoutLoadedRulesPointer(`${pointer}\n\n# timeline`, paths)).toBe(`${pointer}\n\n# timeline`);
    writeChain();
    expect(withoutLoadedRulesPointer(`# warning\n${pointer}`, paths)).toBe(`# warning\n${pointer}`);
  });
});
