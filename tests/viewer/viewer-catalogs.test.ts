import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import ts from 'typescript-compiler-api';
import { viewerZh } from '../../src/ui/i18n/viewer-zh';
import { viewerKo } from '../../src/ui/i18n/viewer-ko';
import { viewerFr } from '../../src/ui/i18n/viewer-fr';
import { settingsZh } from '../../src/ui/i18n/settings-zh';
import { settingsKo } from '../../src/ui/i18n/settings-ko';
import { settingsFr } from '../../src/ui/i18n/settings-fr';

/**
 * Plan rule 4: every string the classic viewer shows has an entry in its own surface's catalogs (viewer-* for the
 * viewer, settings-* for its Settings dialog). core.ts merges every catalog at run time, so a word that only My Work's
 * or setup's catalog holds still shows translated today, and a rewording there would quietly change the viewer (L9).
 */
const VIEWER = join(import.meta.dir, '../../src/ui/viewer');
const files = (dir: string): string[] => readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
});

function literalKeys(): { path: string; key: string }[] {
  return files(VIEWER).flatMap(path => {
    const source = ts.createSourceFile(path, readFileSync(path, 'utf-8'), ts.ScriptTarget.Latest, true);
    const found: { path: string; key: string }[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(source) === 't' && node.arguments.length && ts.isStringLiteral(node.arguments[0])) {
        found.push({ path: relative(VIEWER, path), key: node.arguments[0].text });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  });
}

describe('the classic viewer\'s words are in the viewer\'s own catalogs', () => {
  const keys = literalKeys();
  for (const [locale, catalog] of [
    ['zh', { ...viewerZh, ...settingsZh }], ['ko', { ...viewerKo, ...settingsKo }], ['fr', { ...viewerFr, ...settingsFr }],
  ] as const) {
    it(`every literal t() key under src/ui/viewer has a viewer-${locale} or settings-${locale} entry`, () => {
      expect(keys.length).toBeGreaterThan(300);
      const missing = keys.filter(({ key }) => !(key in catalog) && key !== 'GitHub').map(({ path, key }) => `${path}: ${key}`);
      expect(missing).toEqual([]);
    });
  }
});
