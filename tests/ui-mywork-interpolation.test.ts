import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { interpolate } from '../src/ui/i18n/locale.ts';
import { myworkZh } from '../src/ui/i18n/mywork-zh.ts';
import { OTHER_FOCUS_AREA_ID, type FocusArea, type FocusChange, type Request } from '../src/ui/my-work/src/data.ts';
import { focusAreaLabel, resolveFocusAreaId } from '../src/ui/my-work/src/live/to-focus-model.ts';

const components = new URL('../src/ui/my-work/src/components/', import.meta.url);
const source = ts.createSourceFile('focus-changes.tsx', readFileSync(new URL('focus-changes.tsx', components), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
// Exercise the private formatter without loading React, the store or browser-only components.
const formatter = source.statements.filter(node =>
  (ts.isFunctionDeclaration(node) && ['backTo', 'describeFocusChange'].includes(node.name?.text ?? '')) ||
  (ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText(source) === 'STATUS_ACTION'))
).map(node => node.getText(source)).join('\n');
const describeFocusChange = new Function('interpolate', 'focusAreaLabel', 'resolveFocusAreaId', 'OTHER_FOCUS_AREA_ID',
  ts.transpileModule(formatter, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + '\nreturn describeFocusChange;'
)(interpolate, focusAreaLabel, resolveFocusAreaId, OTHER_FOCUS_AREA_ID) as (
  change: FocusChange, areas: FocusArea[], requests: Request[], t?: (text: string) => string
) => { text: string; undo: FocusChange[] | null };

const area = (id: string, name: string): FocusArea => ({
  id, name, goal: null, status: 'kept', ownerRank: null, priorityRank: null,
  source: 'owner', mergedInto: null, evidence: null, timesAsked: null, latestAt: null, quotes: [], asks: [],
});

test('My Work interpolation preserves replacement syntax, inserted placeholders and repeated slots', () => {
  const title = "$& $$ $` $' {area}";
  assert.equal(interpolate('{title} / {area} / {title}', { title, area: 'Target' }), `${title} / Target / ${title}`);
});

for (const language of ['en', 'zh-CN']) {
  const t = (text: string) => language === 'en' ? text : myworkZh[text] ?? text;
  test(`focus rename and merge preserve user placeholders and dollars (${language})`, () => {
    const name = '$& {newName} {into}';
    const newName = '$$ {name}';
    const areas = [area('source', name), area('target', newName)];
    const renamed = describeFocusChange({ action: 'rename', focusAreaId: 'source', name: ` ${newName} ` }, areas, [], t);
    assert.equal(renamed.text, language === 'en' ? `Renamed “${name}” to “${newName}”` : `已将“${name}”重命名为“${newName}”`);
    assert.deepEqual(renamed.undo, [{ action: 'rename', focusAreaId: 'source', name }]);
    const merged = describeFocusChange({ action: 'merge', focusAreaId: 'source', intoFocusAreaId: 'target' }, areas, [], t);
    assert.equal(merged.text, language === 'en' ? `Merged “${name}” into “${newName}”` : `已将“${name}”合并入“${newName}”`);
  });

  test(`focus moves translate only the Other ID, not a user area named Other (${language})`, () => {
    const title = '$& {area}';
    const areas = [area('source', 'Source'), area('custom-other', 'Other')];
    const requests = [{ id: 'request', title, focusAreaId: 'source' }] as Request[];
    for (const [id, label] of [[OTHER_FOCUS_AREA_ID, t('Other')], ['custom-other', 'Other']]) {
      const moved = describeFocusChange({ action: 'move-request', requestId: 'request', focusAreaId: id }, areas, requests, t);
      assert.equal(moved.text, language === 'en' ? `Moved “${title}” to ${label}` : `已将“${title}”移至 ${label}`);
      assert.deepEqual(moved.undo, [{ action: 'move-request', requestId: 'request', focusAreaId: 'source' }]);
    }
  });
}

test('My Work components do not use string replacement for placeholder interpolation', () => {
  function scan(directory: URL) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
      if (entry.isDirectory()) { scan(url); continue; }
      if (!/\.tsx?$/.test(entry.name)) continue;
      const source = ts.createSourceFile(entry.name, readFileSync(url, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      function visit(node: ts.Node) {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
          && ['replace', 'replaceAll'].includes(node.expression.name.text)
          && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
          assert.doesNotMatch(node.arguments[0].text, /\{\w+\}/, `${url}: use interpolate instead`);
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
  scan(components);
});
