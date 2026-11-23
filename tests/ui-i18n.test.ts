import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript-compiler-api';
import { LOCALE_NAMES, parseLocale, interpolate, placeholders } from '../src/ui/i18n/locale.ts';
import { viewerZh } from '../src/ui/i18n/viewer-zh.ts';
import { myworkZh } from '../src/ui/i18n/mywork-zh.ts';
import { setupZh } from '../src/ui/i18n/setup-zh.ts';
import { settingsZh } from '../src/ui/i18n/settings-zh.ts';
import { viewerKo } from '../src/ui/i18n/viewer-ko.ts';
import { myworkKo } from '../src/ui/i18n/mywork-ko.ts';
import { setupKo } from '../src/ui/i18n/setup-ko.ts';
import { settingsKo } from '../src/ui/i18n/settings-ko.ts';
import { myworkTr } from '../src/ui/i18n/mywork-tr.ts';
import { myworkPtBr } from '../src/ui/i18n/mywork-pt-BR.ts';
import { viewerFr } from '../src/ui/i18n/viewer-fr.ts';
import { myworkFr } from '../src/ui/i18n/mywork-fr.ts';
import { setupFr } from '../src/ui/i18n/setup-fr.ts';
import { settingsFr } from '../src/ui/i18n/settings-fr.ts';

const UI_ROOT = fileURLToPath(new URL('../src/ui/', import.meta.url));

/** Every literal t('…') call in the .ts and .tsx files under `directory` (tests left out), with the file it is in. */
function literalTranslationKeys(directory: string): { path: string; key: string }[] {
  const found: { path: string; key: string }[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { found.push(...literalTranslationKeys(path)); continue; }
    if (!/\.tsx?$/.test(path) || path.includes('.test.')) continue;
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && node.expression.getText(source) === 't'
        && node.arguments.length && ts.isStringLiteral(node.arguments[0])) {
        found.push({ path, key: node.arguments[0].text });
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return found;
}

/**
 * The words a t() call picks with a ternary (or `??` / `||`) inside it, such as t(failed ? 'A' : 'B'), under
 * `directory`: the check above sees only a string as the first argument, so these keys would go unchecked.
 */
function conditionalTranslationKeys(directory: string): { path: string; key: string }[] {
  const found: { path: string; key: string }[] = [];
  const literalsIn = (node: ts.Node, keys: string[]): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) keys.push(node.text);
    else if (ts.isConditionalExpression(node)) { literalsIn(node.whenTrue, keys); literalsIn(node.whenFalse, keys); }
    else if (ts.isParenthesizedExpression(node)) literalsIn(node.expression, keys);
    else if (ts.isBinaryExpression(node) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind)) {
      literalsIn(node.left, keys); literalsIn(node.right, keys);
    }
  };
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { found.push(...conditionalTranslationKeys(path)); continue; }
    if (!/\.tsx?$/.test(path) || path.includes('.test.')) continue;
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && node.expression.getText(source) === 't'
        && node.arguments.length && !ts.isStringLiteral(node.arguments[0])) {
        const keys: string[] = [];
        literalsIn(node.arguments[0], keys);
        found.push(...keys.map(key => ({ path, key })));
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return found;
}

/** The literal t() calls under these folders of src/ui whose words `catalog` lacks, as "file: words". */
function wordsMissingFrom(catalog: Record<string, string>, folders: string[]): string[] {
  return folders.flatMap(folder => literalTranslationKeys(join(UI_ROOT, folder)))
    .filter(({ key }) => !(key in catalog) && key !== 'GitHub')
    .map(({ path, key }) => `${path}: ${key}`);
}

describe('UI language catalogs', () => {
  it('keeps English as the default and accepts each supported locale', () => {
    assert.equal(parseLocale(null), 'en');
    assert.equal(parseLocale('fr'), 'fr');
    assert.equal(LOCALE_NAMES.fr, 'Français');
    assert.equal(parseLocale('fr-FR'), 'en');
    assert.equal(parseLocale('zh-CN'), 'zh-CN');
    assert.equal(parseLocale('ko'), 'ko');
    assert.equal(parseLocale('tr'), 'tr');
    assert.equal(parseLocale('pt-BR'), 'pt-BR');
    assert.equal(LOCALE_NAMES['pt-BR'], 'Português (Brasil)');
    assert.equal(parseLocale('toString'), 'en');
  });

  it('interpolates values without interpreting them as replacement syntax', () => {
    assert.equal(interpolate('Delete {count} items for {name}?', { count: 2, name: '$&' }), 'Delete 2 items for $&?');
    assert.equal(interpolate('{unknown}', {}), '{unknown}');
  });

  for (const [name, catalog] of Object.entries({
    viewerZh, myworkZh, setupZh, settingsZh,
    viewerKo, myworkKo, setupKo, settingsKo, myworkTr,
    viewerFr, myworkFr, setupFr, settingsFr,
    myworkPtBr,
  })) {
    it(`${name} has nonempty translations and preserves interpolation placeholders`, () => {
      assert.ok(Object.keys(catalog).length > 0);
      for (const [english, translated] of Object.entries(catalog)) {
        assert.ok(english.trim(), `${name}: empty source`);
        assert.ok(translated.trim(), `${name}: empty translation for ${english}`);
        assert.deepEqual(placeholders(translated), placeholders(english), `${name}: ${english}`);
      }
    });
  }

  // Every literal t() call has a zh entry (below), so matching the zh keys covers the whole UI.
  for (const [name, localized, chinese] of [
    ['viewerKo', viewerKo, viewerZh], ['myworkKo', myworkKo, myworkZh], ['setupKo', setupKo, setupZh], ['settingsKo', settingsKo, settingsZh],
    ['viewerFr', viewerFr, viewerZh], ['myworkFr', myworkFr, myworkZh], ['setupFr', setupFr, setupZh], ['settingsFr', settingsFr, settingsZh],
    ['myworkPtBr', myworkPtBr, myworkZh],
  ] as const) {
    it(`${name} translates exactly the strings its Chinese catalog does`, () => {
      assert.deepEqual(Object.keys(localized).sort(), Object.keys(chinese).sort());
    });
  }

  it('the Turkish My Work catalog covers the same strings as the Chinese catalog', () => {
    assert.deepEqual(Object.keys(myworkTr).sort(), Object.keys(myworkZh).sort());
  });

  it('every literal t() call has a catalog entry', () => {
    assert.deepEqual(wordsMissingFrom({ ...viewerZh, ...myworkZh, ...setupZh, ...settingsZh }, ['viewer', 'my-work/src']), []);
  });

  // Setup's own screens only: My Work's pages still have such calls without entries (their track's to fix).
  it('every word a setup t() call picks with a ternary has a catalog entry', () => {
    const catalog = { ...viewerZh, ...myworkZh, ...setupZh, ...settingsZh };
    assert.deepEqual(conditionalTranslationKeys(join(UI_ROOT, 'my-work/src/setup')).filter(({ key }) => !(key in catalog))
      .map(({ path, key }) => `${path}: ${key}`), []);
  });

  // Turkish reads the My Work catalog alone (core.ts), so words that only the setup or viewer catalogs carry, such as
  // 'Try again', show in English to a Turkish reader while the check above passes. My Work's setup flow has no Turkish
  // catalog, so only its pages and components are checked here.
  it('the Turkish catalog has the words of every literal t() call in My Work’s pages and components', () => {
    assert.deepEqual(wordsMissingFrom(myworkTr, ['my-work/src/pages', 'my-work/src/components']), []);
  });

  for (const catalogs of [
    [viewerZh, myworkZh, setupZh, settingsZh],
    [viewerKo, myworkKo, setupKo, settingsKo],
    [viewerFr, myworkFr, setupFr, settingsFr],
  ]) {
    it('shared English phrases have the same translation across catalogs', () => {
      const seen = new Map<string, string>();
      for (const catalog of catalogs) {
        for (const [key, value] of Object.entries(catalog)) {
          if (seen.has(key)) assert.equal(value, seen.get(key), key);
          seen.set(key, value);
        }
      }
    });
  }
});
