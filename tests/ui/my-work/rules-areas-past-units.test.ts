import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { buildSync } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { setLocale } from '../../../src/ui/i18n/core';
import { formatPromptDay, formatPromptTime } from '../../../src/ui/my-work/src/lib/prompt-time';
import { clockDay } from '../../../src/ui/my-work/src/lib/display-time';
import { SWIPE_DECIDES_AT_PX, swipeDirection, swipeToDecide } from '../../../src/ui/my-work/src/lib/swipe-to-decide';

/**
 * Phase 7 fix round (pro-max-v16): the pieces of My Rules, Suggested areas and Past focus that need no browser. Quote
 * times on the 12-hour clock, the done day through the shared formatter, a swipe that decides only when it goes
 * sideways, a decision card that honours Alert's variant, the citation's words in the reader's language, and no page
 * class giving a control its 44px (the Button primitive owns that, plan rule 6).
 */
const MY_WORK = resolve(import.meta.dir, '../../../src/ui/my-work');

// The language comes from localStorage (src/ui/i18n/core.ts), so give the suite a window and document while it runs.
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
let rendered: { setLocale: (locale: string) => void; renderConfirmation: (variant?: string) => string; renderCitation: () => string } | undefined;

beforeAll(() => {
  let stored: string | null = null;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    localStorage: { getItem: () => stored, setItem: (_key: string, value: string) => { stored = value; } },
    location: { search: '', href: 'http://localhost/', hostname: 'localhost' },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {}, removeEventListener() {},
  } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { lang: 'en' } } });
  // The real components, compiled with their sources (no DOM package): rendered to markup with My Work's React.
  const compiled = buildSync({
    stdin: {
      resolveDir: MY_WORK, loader: 'tsx', contents: `
        import React from 'react';
        import { renderToStaticMarkup } from 'react-dom/server';
        import { setLocale } from './src/lib/i18n';
        import { Confirmation, ConfirmationRequest } from './src/components/ai-elements/confirmation';
        import { InlineCitationCard, InlineCitationCardTrigger, InlineCitationCarousel, InlineCitationCarouselNext, InlineCitationCarouselPrev } from './src/components/ai-elements/inline-citation';
        export { setLocale };
        export const renderConfirmation = (variant) => renderToStaticMarkup(
          <Confirmation variant={variant} approval={{ id: 'rule' }} state="approval-requested"><ConfirmationRequest>Decide</ConfirmationRequest></Confirmation>);
        export const renderCitation = () => renderToStaticMarkup(<>
          <InlineCitationCard><InlineCitationCardTrigger sources={[]} /></InlineCitationCard>
          <InlineCitationCarousel><InlineCitationCarouselPrev /><InlineCitationCarouselNext /></InlineCitationCarousel>
        </>);
      `,
    },
    tsconfig: resolve(MY_WORK, 'tsconfig.app.json'),
    bundle: true, write: false, format: 'cjs', platform: 'node',
    loader: { '.webp': 'dataurl' }, define: { 'process.env.NODE_ENV': '"production"' },
  }).outputFiles[0].text;
  const module = { exports: {} as typeof rendered };
  new Function('module', 'exports', 'require', compiled)(module, module.exports, createRequire(import.meta.url));
  rendered = module.exports;
});

afterAll(() => {
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window');
  if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else Reflect.deleteProperty(globalThis, 'document');
});

describe('quote times read on the 12-hour clock (G9; anti-pattern L14)', () => {
  it('turns the stamp’s own minute into a 12-hour time, midnight and noon included', () => {
    setLocale('en');
    expect(formatPromptTime('10-18 00:05')).toBe('Oct 18, 12:05 am');
    expect(formatPromptTime('10-18 09:41')).toBe('Oct 18, 9:41 am');
    expect(formatPromptTime('10-18 12:30')).toBe('Oct 18, 12:30 pm');
    expect(formatPromptTime('10-18 23:59')).toBe('Oct 18, 11:59 pm');
  });

  it('keeps a bare day as a day, and says when no time was recorded', () => {
    setLocale('en');
    expect(formatPromptTime('10-18')).toBe('Oct 18');
    expect(formatPromptDay('03-02 17:00')).toBe('Mar 2');
    expect(formatPromptTime('')).toBe('Time not recorded');
  });
});

describe('the done day comes from the shared formatter (rule 9)', () => {
  const thisYear = Date.parse('2026-11-16T12:00:00Z');
  it('prints the short day, with the year only when it is not this year’s, and keeps the full stamp', () => {
    setLocale('en');
    const day = clockDay('2026-10-17T16:05:00Z', thisYear)!;
    expect(day.short).toBe('Oct 17');
    expect(day.full).toContain('2026');
    expect(clockDay('2025-10-17T16:05:00Z', thisYear)!.short).toBe('Oct 17, 2025');
  });

  it('writes the day in the reader’s language', () => {
    setLocale('fr');
    expect(clockDay('2026-10-17T16:05:00Z', thisYear)!.short).toBe('17 oct.');
    setLocale('en');
  });

  it('prints nothing for a value that is not a recorded time, never a raw stamp', () => {
    expect(clockDay('Oct 17', thisYear)).toBeNull();
    expect(clockDay('', thisYear)).toBeNull();
  });
});

describe('swipe to decide only on a mostly sideways drag (quality L2)', () => {
  it('decides past the distance when the drag goes more sideways than up or down', () => {
    const decided: string[] = [];
    const release = swipeToDecide(() => decided.push('right'), () => decided.push('left'));
    release({ x: SWIPE_DECIDES_AT_PX, y: 20 });
    release({ x: -SWIPE_DECIDES_AT_PX - 10, y: -30 });
    expect(decided).toEqual(['right', 'left']);
  });

  it('a drag that goes mostly up or down (a scroll that started on the card) shows no direction and decides nothing', () => {
    const decided: string[] = [];
    const release = swipeToDecide(() => decided.push('right'), () => decided.push('left'));
    release({ x: 100, y: 180 });
    release({ x: -SWIPE_DECIDES_AT_PX, y: SWIPE_DECIDES_AT_PX });
    expect(decided).toEqual([]);
    expect(swipeDirection({ x: 3, y: 12 })).toBeNull();
    expect(swipeDirection({ x: 12, y: 3 })).toBe('right');
  });
});

describe('a decision card honours the variant it accepts (fail fast; anti-pattern L6)', () => {
  it('a named variant draws that kind’s look and word from the Alert, still with no status role', () => {
    setLocale('en');
    const html = rendered!.renderConfirmation('destructive');
    expect(html).toContain('data-kind="destructive"');
    expect(html).toContain('border-destructive');
    expect(html).toContain('Error: ');
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain('role="alert"');
  });

  it('without a variant it is a plain card with no role', () => {
    const html = rendered!.renderConfirmation(undefined);
    expect(html).toContain('data-slot="confirmation"');
    expect(html).not.toContain('role=');
    expect(html).not.toContain('data-kind');
  });
});

describe('the citation’s own words follow the reader’s language (rule 4)', () => {
  it('names an unknown source and the carousel’s buttons in French', () => {
    rendered!.setLocale('fr');
    const html = rendered!.renderCitation();
    rendered!.setLocale('en');
    expect(html).toContain('inconnu');
    expect(html).toContain('aria-label="Précédent"');
    expect(html).toContain('aria-label="Suivant"');
    expect(html).not.toContain('unknown');
  });
});

describe('the Button primitive owns the 44px touch size (plan rule 6; anti-pattern L2)', () => {
  it('no Phase 7 page gives a control its 44px with a page class', () => {
    const pages = ['my-rules.tsx', 'suggested-areas.tsx', 'past-focus.tsx'];
    const found = pages.flatMap((page) => readFileSync(resolve(MY_WORK, 'src/pages', page), 'utf8').split('\n')
      .map((line, index) => ({ page, line: index + 1, match: /(?<![\w-])(?:min-h-11|h-11|size-11|min-w-11|min-h-\[44px\]|h-\[44px\])(?![\w-])/.exec(line)?.[0] }))
      .filter((entry) => entry.match));
    expect(found).toEqual([]);
  });
});
