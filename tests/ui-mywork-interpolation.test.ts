import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { buildSync } from 'esbuild';
import { interpolate } from '../src/ui/i18n/locale.ts';
import { myworkZh } from '../src/ui/i18n/mywork-zh.ts';
import { OTHER_FOCUS_AREA_ID, type FocusArea, type FocusChange, type Request } from '../src/ui/my-work/src/data.ts';
import { RULE_TIERS, type OwnerRule, type RuleScope } from '../src/ui/my-work/src/data-rules.ts';
import { renderRulesFile, type SavedRule } from '../src/services/work-view/my-rules.mjs';

const components = new URL('../src/ui/my-work/src/components/', import.meta.url);
const pages = new URL('../src/ui/my-work/src/pages/', import.meta.url);
// Bundle the actual formatter rather than extracting a second copy of its implementation.
const compiled = buildSync({
  entryPoints: [fileURLToPath(new URL('focus-change-message.ts', components))],
  bundle: true, write: false, platform: 'node', format: 'cjs',
}).outputFiles[0].text;
const module = { exports: {} as typeof import('../src/ui/my-work/src/components/focus-change-message.ts') };
new Function('module', 'exports', compiled)(module, module.exports);
const { describeFocusChange, renderFocusChange } = module.exports;

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
    const renamed = describeFocusChange({ action: 'rename', focusAreaId: 'source', name: ` ${newName} ` }, areas, []);
    assert.equal(renderFocusChange(renamed, t), language === 'en' ? `Renamed “${name}” to “${newName}”` : `已将“${name}”重命名为“${newName}”`);
    assert.deepEqual(renamed.undo, [{ action: 'rename', focusAreaId: 'source', name }]);
    const merged = describeFocusChange({ action: 'merge', focusAreaId: 'source', intoFocusAreaId: 'target' }, areas, []);
    assert.equal(renderFocusChange(merged, t), language === 'en' ? `Merged “${name}” into “${newName}”` : `已将“${name}”合并入“${newName}”`);
  });

  test(`focus moves translate only the Other ID, not a user area named Other (${language})`, () => {
    const title = '$& {area}';
    const areas = [area('source', 'Source'), area('custom-other', 'Other')];
    const requests = [{ id: 'request', title, focusAreaId: 'source' }] as Request[];
    for (const [id, label] of [[OTHER_FOCUS_AREA_ID, t('Other')], ['custom-other', 'Other']]) {
      const moved = describeFocusChange({ action: 'move-request', requestId: 'request', focusAreaId: id }, areas, requests);
      assert.equal(renderFocusChange(moved, t), language === 'en' ? `Moved “${title}” to ${label}` : `已将“${title}”移至 ${label}`);
      assert.deepEqual(moved.undo, [{ action: 'move-request', requestId: 'request', focusAreaId: 'source' }]);
    }
  });
}

test('saved focus records switch languages repeatedly without changing text or Undo', () => {
  const areas = [{ ...area('source', 'Other $& {name}'), source: 'seed' as const, goal: 'Original goal' }, area('target', 'Target')];
  const requests = [{ id: 'request', title: 'Other {area}', focusAreaId: 'source' }] as Request[];
  const changes: FocusChange[] = [
    ...(['keep', 'dismiss', 'done', 'edit-goal', 'restore-suggestion'] as const).map(action => ({ action, focusAreaId: 'source' })),
    { action: 'rename', focusAreaId: 'source', name: 'New {name}' },
    { action: 'merge', focusAreaId: 'source', intoFocusAreaId: 'target' },
    { action: 'reorder', focusAreaIds: ['target', 'source'] },
    { action: 'move-request', requestId: 'request', focusAreaId: OTHER_FOCUS_AREA_ID },
  ];
  for (const change of changes) {
    const record = describeFocusChange(change, areas, requests);
    const snapshot = JSON.stringify(record);
    assert.equal(renderFocusChange(record, s => s), record.text);
    const chinese = renderFocusChange(record, s => myworkZh[s] ?? s);
    assert.notEqual(chinese, record.text, change.action);
    assert.equal(renderFocusChange(record, s => s), record.text);
    assert.equal(JSON.stringify(record), snapshot);
  }
  assert.deepEqual(describeFocusChange(changes[6], areas, requests).undo, [
    { action: 'restore-suggestion', focusAreaId: 'source' }, { action: 'keep', focusAreaId: 'source' },
  ]);
  assert.deepEqual(describeFocusChange(changes[7], areas, requests).undo, [{ action: 'reorder', focusAreaIds: ['source', 'target'] }]);
});

test('focus fallback labels translate but legacy records remain verbatim', () => {
  const t = (s: string) => myworkZh[s] ?? s;
  assert.equal(renderFocusChange(describeFocusChange({ action: 'keep', focusAreaId: 'missing' }, [], []), t), `已保留“${t('the area')}”`);
  assert.equal(renderFocusChange(describeFocusChange({ action: 'move-request', requestId: 'missing', focusAreaId: 'other' }, [], []), t), `已将“${t('the request')}”移至 ${t('Other')}`);
  assert.equal(renderFocusChange({ text: 'Other $& {name}', undo: null }, t), 'Other $& {name}');
});

test('My Work pages and components do not use string replacement for placeholder interpolation', () => {
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
  scan(pages);
});

const rulesSource = ts.createSourceFile('my-rules.tsx', readFileSync(new URL('my-rules.tsx', pages), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const fileHelpers = new Set(['scopeHeading', 'strengthScore', 'byStrength', 'lowerFirst', 'SET_BY_ORDER', 'rulesFileLines']);
const fileFormatter = rulesSource.statements.filter(node =>
  (ts.isFunctionDeclaration(node) && fileHelpers.has(node.name?.text ?? '')) ||
  (ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => fileHelpers.has(declaration.name.getText(rulesSource))))
).map(node => node.getText(rulesSource)).join('\n');
const rulesFileLines = new Function('RULE_TIERS',
  ts.transpileModule(fileFormatter, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + '\nreturn rulesFileLines;'
)(RULE_TIERS) as (rules: OwnerRule[], scopes: RuleScope[]) => { text: string; ruleId: string | null }[];

test('rules preview matches renderRulesFile with whole-day recency, English headings and exact whitespace', () => {
  const now = Date.parse('2026-11-03T12:00:00Z');
  const scopes: RuleScope[] = [
    { id: 'situation', tier: 'situation', name: '$& {name}' },
    { id: 'z', tier: 'project', name: 'Zulu' },
    { id: 'a', tier: 'project', name: 'Alpha' },
    { id: 'global', tier: 'everywhere', name: '全局' },
    { id: 'empty', tier: 'project', name: 'Empty' },
  ];
  const rule = (id: string, scopeId: string, overrides: Partial<OwnerRule> = {}): OwnerRule => ({
    id, scopeId, setBy: 'owner', status: 'on', when: '', then: `$& {when} ${id}`,
    timesSeen: 1, latestAt: 'Nov 3', latestDaysAgo: 0, source: 'you', quotes: [], records: [], ...overrides,
  });
  const rules = [
    rule('approved', 'z', { setBy: 'approved', timesSeen: 100 }),
    rule('old', 'z', { latestDaysAgo: 7 }),
    rule('recent', 'z', { when: 'I write {then}', then: 'Keep $& and {name} unchanged' }),
    rule('global', 'global'), rule('situation', 'situation'), rule('alpha', 'a'),
    rule('off', 'a', { status: 'off' }), rule('suggested', 'a', { status: 'suggested' }),
    rule('learned', 'a', { setBy: 'learned' }), rule('replaced', 'a', { status: 'replaced' }),
    rule('dismissed', 'a', { status: 'dismissed' }),
  ];
  const saved: SavedRule[] = rules.map(rule => {
    const scope = scopes.find(scope => scope.id === rule.scopeId)!;
    return { ...rule, ruleId: rule.id, scopeTier: scope.tier, scopeName: scope.name,
      latestAt: new Date(now - rule.latestDaysAgo * 86_400_000).toISOString(),
      kind: 'directive', quotes: [], replacedBy: null, replacedAt: null, savedAt: null };
  });
  const before = JSON.stringify({ rules, scopes });
  const lines = rulesFileLines(rules, scopes);
  assert.equal(lines.map(line => line.text).join('\n') + '\n', renderRulesFile(saved, now).markdown);
  assert.deepEqual(lines.flatMap(line => line.ruleId ? [line.ruleId] : []), ['global', 'alpha', 'recent', 'old', 'approved', 'situation']);
  assert.equal(JSON.stringify({ rules, scopes }), before, 'preview must not reorder the shared model');
  assert.equal(rulesFileLines([], scopes).map(line => line.text).join('\n') + '\n', renderRulesFile([], now).markdown);
});

test('rule receipts retain user text and render again after a language switch', () => {
  const compiled = buildSync({
    entryPoints: [fileURLToPath(new URL('../src/ui/ui-message.ts', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs',
  }).outputFiles[0].text;
  const module = { exports: {} as typeof import('../src/ui/ui-message.ts') };
  new Function('module', 'exports', compiled)(module, module.exports);
  const { uiMessage, renderUiMessage } = module.exports;
  const helpers = rulesSource.statements.filter(node => ts.isFunctionDeclaration(node)
    && ['ruleReceipt', 'renderRuleReceipt'].includes(node.name?.text ?? '')
  ).map(node => node.getText(rulesSource)).join('\n');
  let chinese = false;
  const t = (text: string) => chinese ? myworkZh[text] ?? text : text;
  const { ruleReceipt, renderRuleReceipt } = new Function('uiMessage', 'renderUiMessage', 't',
    ts.transpileModule(helpers, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + '\nreturn { ruleReceipt, renderRuleReceipt };'
  )(uiMessage, renderUiMessage, t);
  const name = '$& {scope} $$';
  const record = ruleReceipt('Approved {name} under {scope}', { name, scope: uiMessage('Everywhere') });
  assert.equal(record.text, `Approved ${name} under Everywhere`);
  for (chinese of [true, false, true]) {
    assert.equal(renderRuleReceipt(record), chinese ? `已在 全局 下批准 ${name}` : `Approved ${name} under Everywhere`);
    assert.equal(record.text, `Approved ${name} under Everywhere`);
  }
  assert.equal(renderRuleReceipt({ text: 'Other' }), 'Other', 'legacy receipts must not be translated as UI keys');
});

// Evaluate the actual JSX's message expressions so missing separators cannot hide behind catalog-only tests.
function pageMessage(file: URL, template: string, values: Record<string, unknown>, language: string) {
  const source = ts.createSourceFile(file.pathname, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression: ts.CallExpression | undefined;
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'interpolate'
      && node.arguments[0]?.getText(source) === `t('${template}')`) expression = node;
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(expression, `${file}: missing complete message ${template}`);
  const t = (text: string) => language === 'en' ? text : myworkZh[text] ?? text;
  return new Function('t', 'interpolate', 'displayTime', ...Object.keys(values), `return ${expression.getText(source)};`)(t, interpolate, (value: string) => value, ...Object.values(values));
}

for (const language of ['en', 'zh-CN']) {
  test(`request metadata and conditional rules use complete sentences (${language})`, () => {
    const request = { askedBy: '$& {time}', startedAt: 'Nov 3', runningFor: '2 min', stage: 'Building' };
    const metadata = pageMessage(new URL('request-detail.tsx', components), 'Asked by {name} · started {time} · {duration} · {stage}', { request }, language);
    const stage = language === 'en' ? request.stage : myworkZh[request.stage] ?? request.stage;
    assert.equal(metadata, language === 'en' ? `Asked by ${request.askedBy} · started Nov 3 · 2 min · ${stage}` : `由 ${request.askedBy} 发起 · 开始于 Nov 3 · 2 min · ${stage}`);
    const checked = { ...request, checkedAt: '$& {checked}' };
    assert.equal(pageMessage(new URL('request-detail.tsx', components), 'Checked {checkedAt}.', { request: checked, notice: null }, language),
      language === 'en' ? 'Checked $& {checked}.' : '已于 $& {checked} 检查。');
    const rule = { when: '$& {then}', then: '$$ {when}' };
    assert.equal(pageMessage(new URL('my-work.tsx', pages), 'When {when}: {then}', { rule }, language),
      language === 'en' ? `When ${rule.when}: ${rule.then}` : `当 ${rule.when} 时：${rule.then}`);
    assert.equal(pageMessage(new URL('suggested-areas.tsx', pages), 'Why it’s suggested: {reason}', {
      area: { quotes: [], evidence: '$& {reason}' }, SOURCE_TEXT: {},
    }, language), language === 'en' ? 'Why it’s suggested: $& {reason}' : '建议原因：$& {reason}');
  });
}
