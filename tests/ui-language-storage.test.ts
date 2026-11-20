import { it } from 'node:test';
import assert from 'node:assert/strict';
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
