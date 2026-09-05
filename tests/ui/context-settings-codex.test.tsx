import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import ts from 'typescript';
import { DEFAULT_SETTINGS } from '../../src/ui/viewer/constants/settings';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager';

describe('Codex viewer settings', () => {
  it('retains public Luna/low defaults shared with the worker', () => {
    const defaults = SettingsDefaultsManager.getAllDefaults();
    expect(DEFAULT_SETTINGS.CLAUDE_MEM_CODEX_MODEL).toBe('gpt-5.6-luna');
    expect(DEFAULT_SETTINGS.CLAUDE_MEM_CODEX_REASONING_EFFORT).toBe('low');
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      if (key.startsWith('CLAUDE_MEM_CODEX_')) expect(defaults[key as keyof typeof defaults]).toBe(value);
    }
  });

  it('preserves explicit reasoning values including model default and offers none', () => {
    const source = readFileSync(join(__dirname, '../../src/ui/viewer/components/ContextSettingsModal.tsx'), 'utf8');
    const tree = ts.createSourceFile('modal.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const values: string[] = [];
    const reasoningValues: ts.Expression[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isJsxAttribute(node) && node.name.getText(tree) === 'value' && node.initializer) {
        if (ts.isStringLiteral(node.initializer)) values.push(node.initializer.text);
        if (ts.isJsxExpression(node.initializer) && node.initializer.expression?.getText(tree).includes('formState.CLAUDE_MEM_CODEX_REASONING_EFFORT')) {
          reasoningValues.push(node.initializer.expression);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
    expect(reasoningValues).toHaveLength(1);
    const expression = reasoningValues[0];
    expect(ts.isBinaryExpression(expression)).toBe(true);
    if (ts.isBinaryExpression(expression)) {
      expect(expression.operatorToken.kind).toBe(ts.SyntaxKind.QuestionQuestionToken);
      expect(expression.right.getText(tree)).toBe("'low'");
    }
    for (const value of ['claude', 'codex', 'gemini', 'openrouter', '', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh']) {
      expect(values).toContain(value);
    }
    expect(source).toContain('native Codex app-server');
    expect(source).not.toContain('codex exec');
    expect(source).not.toContain('label="Codex Context Messages"');
    expect(source).not.toContain('label="Codex Observations Per Prompt"');
  });
});
