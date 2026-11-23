import { afterAll, beforeAll, describe, expect, it, setSystemTime } from 'bun:test';
import { setLocale } from '../src/ui/i18n/core';
import { clockTime, displayTime } from '../src/ui/my-work/src/lib/display-time';

/**
 * The instant this process's clock reads while displayTime words a fixed instant (it takes no `now`; it reads
 * Date.now()), the one the page's clock reads in focus-area-page.browser.test.ts: a day of 2026 that is not the
 * instant's own day, so "3 nov., 15:45" holds on any run date. On the real clock it read "3 nov. 2026, 15:45" from
 * 2027-01-01, and "15:45" on 2026-11-03 (Phase 6 re-verify).
 */
const PINNED_NOW = '2026-11-17T10:00:00-08:00';

// My Work shows model-written display dates such as "Today 3:45 pm"; only the UI language changes how they read.
describe('displayTime', () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  beforeAll(() => {
    setSystemTime(new Date(PINNED_NOW));
    let stored: string | null = null;
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: {
      getItem: () => stored,
      setItem: (_key: string, value: string) => { stored = value; },
    } } });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { lang: 'en' } } });
  });
  afterAll(() => {
    setSystemTime();
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

  // Since the one formatter (Phase 6 fix V3), a clock is Intl's in the reader's language, the half of the day first in
  // Chinese, as recorded instants (clockTime) already read; English words are no longer swapped one by one ("3:45 下午").
  it('says a Chinese clock as Intl does, the half of the day first', () => {
    setLocale('zh-CN');
    expect(displayTime('Today 3:45 pm')).toBe('今天 下午3:45');
    expect(displayTime('Nov 3')).toBe('11月3日');
  });

  it('uses French dates and a 24-hour clock', () => {
    setLocale('fr');
    expect(displayTime('Today 3:45 pm')).toBe('Aujourd’hui 15:45');
    expect(displayTime('Yesterday 9:05am')).toBe('Hier 09:05');
    expect(displayTime('12:00 am')).toBe('00:00');
    expect(displayTime('12:00 pm')).toBe('12:00');
    expect(displayTime('Nov 3')).toBe('3 nov.');
    // An ISO time reads as clockTime words it (the one formatter, Phase 6 fix V3): the day and the clock joined by the
    // catalog's "{date}, {time}", the classic viewer's own French join, not Intl's medium date ("3 nov. 2026 à 15:45").
    const date = new Date(2026, 10, 3, 15, 45);
    expect(displayTime(date.toISOString())).toBe('3 nov., 15:45');
    expect(displayTime(date.toISOString())).toBe(clockTime(date.toISOString())!.short);
  });

  it('shows Brazilian Portuguese day labels and a 24-hour clock in My Work', () => {
    setLocale('pt-BR');
    expect(displayTime('Today 3:45 pm')).toBe('Hoje 15:45');
    expect(displayTime('Yesterday 9:05am')).toBe('Ontem 09:05');
    expect(displayTime('Nov 3, 3:45 pm')).toBe('3 de nov., às 15:45');
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
    // Another day adds the date, joined by the catalog's "{date}, {time}" (Phase 6 fix V3) whatever the runtime's own
    // join is (newer ICU writes "Nov 16 at 6:09 PM"), so every language joins its own way and English reads the same.
    expect(clockTime(iso, new Date(2026, 10, 17, 9, 0).getTime())?.short).toBe('Nov 16, 6:09 pm');
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

  it('adds the year to a day that is not this year’s, so last year’s time never reads as this year’s', () => {
    const lastYear = new Date(2025, 10, 16, 18, 9).toISOString();
    const thisYearNow = new Date(2026, 10, 17, 9, 0).getTime();
    setLocale('en');
    expect(clockTime(lastYear, thisYearNow)?.short).toBe('Nov 16, 2025, 6:09 pm');
    setLocale('fr');
    expect(clockTime(lastYear, thisYearNow)?.short).toBe('16 nov. 2025, 18:09');
    setLocale('en');
    expect(clockTime(iso, thisYearNow)?.short).toBe('Nov 16, 6:09 pm');
  });

  it('refuses anything that is not an ISO time, so a raw stamp is never shown as a time', () => {
    setLocale('en');
    expect(clockTime('not yet confirmed')).toBeNull();
    expect(clockTime('Today 3:45 pm')).toBeNull();
    expect(clockTime('2026-13-45T99:00:00Z')).toBeNull();
  });
});
