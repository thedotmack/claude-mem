import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { setLocale } from '../src/ui/i18n/core';
import { clockTime, displayTime } from '../src/ui/my-work/src/lib/display-time';

// My Work shows model-written display dates such as "Today 3:45 pm"; only the UI language changes how they read.
describe('displayTime', () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  beforeAll(() => {
    let stored: string | null = null;
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: {
      getItem: () => stored,
      setItem: (_key: string, value: string) => { stored = value; },
    } } });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { lang: 'en' } } });
  });
  afterAll(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window');
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else Reflect.deleteProperty(globalThis, 'document');
  });

  it('leaves English as written', () => {
    setLocale('en');
    expect(displayTime('Today 3:45 pm')).toBe('Today 3:45 pm');
  });

  it('puts 오전/오후 before the time and localizes dates in Korean', () => {
    setLocale('ko');
    expect(displayTime('Today 3:45 pm')).toBe('오늘 오후 3:45');
    expect(displayTime('Yesterday 9:05am')).toBe('어제 오전 9:05');
    expect(displayTime('Nov 3')).toBe('11월 3일');
  });

  it('puts ÖÖ/ÖS before the time and localizes dates in Turkish', () => {
    setLocale('tr');
    expect(displayTime('Today 3:45 pm')).toBe('Bugün ÖS 3:45');
    expect(displayTime('Yesterday 9:05am')).toBe('Dün ÖÖ 9:05');
    expect(displayTime('Nov 3')).toBe('3 Kas');
  });

  it('keeps the Chinese wording as before', () => {
    setLocale('zh-CN');
    expect(displayTime('Today 3:45 pm')).toBe('今天 3:45 下午');
    expect(displayTime('Nov 3')).toBe('11月3日');
  });

  it('uses French dates and a 24-hour clock', () => {
    setLocale('fr');
    expect(displayTime('Today 3:45 pm')).toBe('Aujourd’hui 15:45');
    expect(displayTime('Yesterday 9:05am')).toBe('Hier 09:05');
    expect(displayTime('12:00 am')).toBe('00:00');
    expect(displayTime('12:00 pm')).toBe('12:00');
    expect(displayTime('Nov 3')).toBe('3 nov.');
    const date = new Date(2026, 10, 3, 15, 45);
    expect(displayTime(date.toISOString())).toBe(new Intl.DateTimeFormat('fr', {
      dateStyle: 'medium', timeStyle: 'short',
    }).format(date));
  });
});

// G9 and plan rule 9: a recorded instant reads in the person's own clock, short, with the full stamp for its tooltip.
describe('clockTime', () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  beforeAll(() => {
    let stored: string | null = null;
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: {
      getItem: () => stored,
      setItem: (_key: string, value: string) => { stored = value; },
    } } });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { lang: 'en' } } });
  });
  afterAll(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window');
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else Reflect.deleteProperty(globalThis, 'document');
  });
  // Local wall-clock instants, so the expectations hold in any time zone the tests run in.
  const evening = new Date(2026, 10, 16, 18, 9, 24);
  const iso = evening.toISOString();

  it('reads "6:09 pm" in English on the same day, with the date on another day', () => {
    setLocale('en');
    expect(clockTime(iso, evening.getTime())?.short).toBe('6:09 pm');
    // Another day adds the date the way the runtime's own date format joins it ("Nov 16, 6:09 pm" or "Nov 16 at 6:09 pm").
    const otherDay = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(evening);
    expect(clockTime(iso, new Date(2026, 10, 17, 9, 0).getTime())?.short).toBe(otherDay.replace(/\s?PM$/, ' pm'));
    expect(clockTime(iso, new Date(2026, 10, 17, 9, 0).getTime())?.short).toStartWith('Nov 16');
    expect(clockTime(iso, evening.getTime())?.full).toBe(new Intl.DateTimeFormat('en', { dateStyle: 'full', timeStyle: 'long' }).format(evening));
  });

  it('follows each language’s clock: 24-hour French, the half of the day first in Korean', () => {
    setLocale('fr');
    expect(clockTime(iso, evening.getTime())?.short).toBe('18:09');
    setLocale('ko');
    expect(clockTime(iso, evening.getTime())?.short).toBe(new Intl.DateTimeFormat('ko', { hour: 'numeric', minute: '2-digit', hour12: true }).format(evening));
    expect(clockTime(iso, evening.getTime())?.short.startsWith('오후')).toBe(true);
  });

  it('refuses anything that is not an ISO time, so a raw stamp is never shown as a time', () => {
    setLocale('en');
    expect(clockTime('not yet confirmed')).toBeNull();
    expect(clockTime('Today 3:45 pm')).toBeNull();
    expect(clockTime('2026-13-45T99:00:00Z')).toBeNull();
  });
});
