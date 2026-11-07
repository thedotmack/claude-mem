import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { getLocale, setLocale } from '../src/ui/i18n/index';

it('keeps an explicit page language when writes fail but old storage remains readable', () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const html = { lang: 'en' };
  let stored = 'en';
  let denyWrite = true;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: {
    getItem: () => stored,
    setItem: (_key: string, value: string) => { if (denyWrite) throw new Error('quota'); stored = value; },
  } } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: html } });
  try {
    setLocale('zh-CN');
    assert.equal(getLocale(), 'zh-CN');
    assert.equal(html.lang, 'zh-CN');
    setLocale('en');
    assert.equal(getLocale(), 'en');
    denyWrite = false;
    setLocale('zh-CN');
    assert.equal(stored, 'zh-CN');
    stored = 'en';
    assert.equal(getLocale(), 'en');
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window');
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else Reflect.deleteProperty(globalThis, 'document');
  }
});

// plugin/ui/tv.html is a verbatim copy of src/ui/tv.html made by scripts/build-viewer.js at release, so the source is what to test.
it('TV language initialization survives blocked localStorage', () => {
  for (const path of ['src/ui/tv.html']) {
    const html = readFileSync(path, 'utf8');
    const start = html.indexOf('  const languageKey =');
    const end = html.indexOf('  applyLanguage();', start) + '  applyLanguage();'.length;
    assert.ok(start >= 0 && end > start);
    const els = Object.fromEntries(['idle', 'dot', 'pipBtn', 'fsBtn'].map(key => [key, {}]));
    const document = { documentElement: { lang: '' }, title: '' };
    runInNewContext(html.slice(start, end), { els, document, localStorage: { getItem() { throw new Error('SecurityError'); } } });
    assert.equal(document.documentElement.lang, 'en');
    assert.equal(els.idle.textContent, 'waiting for observations');
  }
});
