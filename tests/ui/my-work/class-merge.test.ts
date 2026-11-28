import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { CUSTOM_FONT_SIZES, cn } from '../../../src/ui/my-work/src/lib/utils';

/**
 * My Work's cn() (src/ui/my-work/src/lib/utils.ts) knows the font sizes index.css adds, so it never takes one for a
 * colour: in the design pass Phase 3 bar, `cn('… text-muted-foreground …', 'text-place-narrow')` dropped the colour and
 * the places that were not the page shown drew in full ink. And every component merges through that one helper.
 */

const APP_SOURCE = resolve(import.meta.dir, '../../../src/ui/my-work/src');
const INDEX_CSS = readFileSync(join(APP_SOURCE, 'index.css'), 'utf8');

/** Each `--text-<name>:` index.css declares (not its `--text-<name>--line-height` and other modifiers). */
const fontSizeTokens = () => [...INDEX_CSS.matchAll(/^\s*--text-([a-z][\w-]*?):/gm)].map(([, name]) => name).filter((name) => !name.includes('--'));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('My Work cn() and its font sizes', () => {
  it('keeps a colour next to each of the app\'s own font sizes', () => {
    expect(cn('text-muted-foreground', 'text-place-narrow')).toBe('text-muted-foreground text-place-narrow');
    for (const size of CUSTOM_FONT_SIZES) {
      expect(cn('text-muted-foreground', `text-${size}`)).toBe(`text-muted-foreground text-${size}`);
      expect(cn('text-foreground', `lg:text-${size}`)).toBe(`text-foreground lg:text-${size}`);
    }
  });

  it('lets a later font size replace an earlier one, its own or Tailwind\'s', () => {
    expect(cn('text-sm', 'text-place')).toBe('text-place');
    expect(cn('text-place-narrow', 'text-sm')).toBe('text-sm');
    expect(cn('text-page-title-phone md:text-page-title', 'md:text-brand')).toBe('text-page-title-phone md:text-brand');
  });

  it('knows exactly the font sizes index.css declares', () => {
    expect([...CUSTOM_FONT_SIZES].sort()).toEqual(fontSizeTokens().sort());
    expect(fontSizeTokens().length).toBeGreaterThan(0);
  });

  it('is the one cn every My Work file uses: nothing imports the cn package but lib/utils.ts', () => {
    const direct = sourceFiles(APP_SOURCE)
      .filter((path) => /from\s+['"]cn(\/[\w-]+)?['"]/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(APP_SOURCE, path));
    expect(direct).toEqual(['lib/utils.ts']);
  });
});
