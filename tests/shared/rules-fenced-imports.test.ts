import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeCodeAlreadyLoadsInstructions, claudeCodeImportLine, rulesAndToolsLoadedByClaudeCode,
  rulesAndToolsPointerLine, withoutLoadedRulesPointer } from '../../src/shared/claude-code-rules-import.js';

const instructions = 'Use memory search before repeating previously completed work.';
const examples = [
  ['backticks', '```markdown\nIMPORT\n```'],
  ['tildes', '~~~markdown\nIMPORT\n~~~'],
  ['indented fence', '   ```\nIMPORT\n   ```'],
  ['CRLF', '```markdown\r\nIMPORT\r\n```'],
  ['longer outer fence', '````markdown\n```\nIMPORT\n```\n````'],
  ['different closing marker', '~~~markdown\n```\nIMPORT\n~~~'],
  ['text after a potential closer', '```markdown\n``` still an example\nIMPORT\n```'],
  ['unclosed fence', '```markdown\nIMPORT'],
] as const;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'rules fenced '));
  const paths = { claudeInstructionsPath: join(dir, 'CLAUDE.md'), myRulesPath: join(dir, 'MY-RULES.md'),
    rulesAndToolsPath: join(dir, 'RULES-AND-TOOLS.md') };
  writeFileSync(paths.claudeInstructionsPath, claudeCodeImportLine(paths.myRulesPath));
  writeFileSync(paths.myRulesPath, claudeCodeImportLine(paths.rulesAndToolsPath));
  writeFileSync(paths.rulesAndToolsPath, instructions);
  return { dir, paths };
}

describe('fenced examples do not load Claude Code rule files', () => {
  for (const link of ['claudeInstructionsPath', 'myRulesPath'] as const) {
    it.each(examples)(`${link}: %s keeps the MCP instructions and SessionStart pointer`, (_name, example) => {
      const { dir, paths } = fixture();
      try {
        const target = link === 'claudeInstructionsPath' ? paths.myRulesPath : paths.rulesAndToolsPath;
        writeFileSync(paths[link], example.replace('IMPORT', claudeCodeImportLine(target)));
        expect(rulesAndToolsLoadedByClaudeCode(paths)).toBe(false);
        expect(claudeCodeAlreadyLoadsInstructions(instructions, { CLAUDECODE: '1' }, paths)).toBe(false);
        const context = `${rulesAndToolsPointerLine(paths.rulesAndToolsPath)}\n\n# Timeline`;
        expect(withoutLoadedRulesPointer(context, paths)).toBe(context);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }

  it.each([
    '```markdown\nnot an import\n````\nIMPORT',
    '~~~markdown\nnot an import\n~~~~\nIMPORT',
    'This is not a fence: ```\nIMPORT',
    '``` invalid ` info string\nIMPORT',
  ])('still recognizes a live import after non-import text', text => {
    const { dir, paths } = fixture();
    try {
      writeFileSync(paths.claudeInstructionsPath, text.replace('IMPORT', claudeCodeImportLine(paths.myRulesPath)));
      expect(rulesAndToolsLoadedByClaudeCode(paths)).toBe(true);
      expect(claudeCodeAlreadyLoadsInstructions(instructions, { CLAUDECODE: '1' }, paths)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
