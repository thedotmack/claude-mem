import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { parseLocale, interpolate, placeholders } from '../src/ui/i18n/locale.ts';
import { viewerZh } from '../src/ui/i18n/viewer-zh.ts';
import { myworkZh } from '../src/ui/i18n/mywork-zh.ts';
import { setupZh } from '../src/ui/i18n/setup-zh.ts';
import { settingsZh } from '../src/ui/i18n/settings-zh.ts';
import { viewerKo } from '../src/ui/i18n/viewer-ko.ts';
import { myworkKo } from '../src/ui/i18n/mywork-ko.ts';
import { setupKo } from '../src/ui/i18n/setup-ko.ts';
import { settingsKo } from '../src/ui/i18n/settings-ko.ts';
import { myworkTr } from '../src/ui/i18n/mywork-tr.ts';

describe('UI language catalogs', () => {
  it('keeps English as the default and accepts each supported locale', () => {
    assert.equal(parseLocale(null), 'en');
    assert.equal(parseLocale('fr'), 'en');
    assert.equal(parseLocale('zh-CN'), 'zh-CN');
    assert.equal(parseLocale('ko'), 'ko');
    assert.equal(parseLocale('tr'), 'tr');
    assert.equal(parseLocale('toString'), 'en');
  });

  it('interpolates values without interpreting them as replacement syntax', () => {
    assert.equal(interpolate('Delete {count} items for {name}?', { count: 2, name: '$&' }), 'Delete 2 items for $&?');
    assert.equal(interpolate('{unknown}', {}), '{unknown}');
  });

  for (const [name, catalog] of Object.entries({ viewerZh, myworkZh, setupZh, settingsZh, viewerKo, myworkKo, setupKo, settingsKo, myworkTr })) {
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
  for (const [name, korean, chinese] of [
    ['viewerKo', viewerKo, viewerZh], ['myworkKo', myworkKo, myworkZh], ['setupKo', setupKo, setupZh], ['settingsKo', settingsKo, settingsZh],
  ] as const) {
    it(`${name} translates exactly the strings its Chinese catalog does`, () => {
      assert.deepEqual(Object.keys(korean).sort(), Object.keys(chinese).sort());
    });
  }

  it('the Turkish My Work catalog covers the same strings as the Chinese catalog', () => {
    assert.deepEqual(Object.keys(myworkTr).sort(), Object.keys(myworkZh).sort());
  });

  it('every literal t() call has a catalog entry', () => {
    const catalog = { ...viewerZh, ...myworkZh, ...setupZh, ...settingsZh };
    const missing: string[] = [];
    function scan(directory: string) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) { scan(path); continue; }
        if (!/\.tsx?$/.test(path) || path.includes('.test.')) continue;
        const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
        function visit(node: ts.Node) {
          if (ts.isCallExpression(node) && node.expression.getText(source) === 't'
            && node.arguments.length && ts.isStringLiteral(node.arguments[0])) {
            const key = node.arguments[0].text;
            if (!(key in catalog) && key !== 'GitHub') missing.push(`${path}: ${key}`);
          }
          ts.forEachChild(node, visit);
        }
        visit(source);
      }
    }
    const root = fileURLToPath(new URL('../src/ui/', import.meta.url));
    scan(join(root, 'viewer'));
    scan(join(root, 'my-work/src'));
    assert.deepEqual(missing, []);
  });

  for (const catalogs of [[viewerZh, myworkZh, setupZh, settingsZh], [viewerKo, myworkKo, setupKo, settingsKo]]) {
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
