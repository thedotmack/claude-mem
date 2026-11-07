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

describe('UI language catalogs', () => {
  it('keeps English as the default and accepts the supported Chinese locale', () => {
    assert.equal(parseLocale(null), 'en');
    assert.equal(parseLocale('fr'), 'en');
    assert.equal(parseLocale('zh-CN'), 'zh-CN');
  });

  it('interpolates values without interpreting them as replacement syntax', () => {
    assert.equal(interpolate('Delete {count} items for {name}?', { count: 2, name: '$&' }), 'Delete 2 items for $&?');
    assert.equal(interpolate('{unknown}', {}), '{unknown}');
  });

  for (const [name, catalog] of Object.entries({ viewerZh, myworkZh, setupZh, settingsZh })) {
    it(`${name} has nonempty translations and preserves interpolation placeholders`, () => {
      assert.ok(Object.keys(catalog).length > 0);
      for (const [english, chinese] of Object.entries(catalog)) {
        assert.ok(english.trim(), `${name}: empty source`);
        assert.ok(chinese.trim(), `${name}: empty translation for ${english}`);
        assert.deepEqual(placeholders(chinese), placeholders(english), `${name}: ${english}`);
      }
    });
  }

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

  it('shared English phrases have the same translation across catalogs', () => {
    const seen = new Map<string, string>();
    for (const catalog of [viewerZh, myworkZh, setupZh, settingsZh]) {
      for (const [key, value] of Object.entries(catalog)) {
        if (seen.has(key)) assert.equal(value, seen.get(key), key);
        seen.set(key, value);
      }
    }
  });
});
