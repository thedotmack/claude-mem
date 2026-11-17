import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * F6 (page-16): the viewer's shell keeps to the token sheet at the top of viewer-template.html: six type sizes,
 * one sans and one monospace (Monaspace Radon for the logo word only), two breakpoints and one corner radius per
 * kind of element. A new size, face, width or radius has to be added to the sheet and to these lists together.
 */
const template = readFileSync(join(import.meta.dir, '../../src/ui/viewer-template.html'), 'utf-8');
const styles = template.match(/<style>([\s\S]*?)<\/style>/)![1].replace(/\/\*[\s\S]*?\*\//g, '');

// 16 (not 15) is the owner's prompts and session titles, and every field on a touch screen: iOS Safari zooms the
// page into a field whose text is under 16px.
const TYPE_SIZES = ['12px', '13px', '14px', '16px', '18px', '26px'];
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica', 'Arial', sans-serif";
const FONT_FAMILIES = ['inherit', 'var(--font-terminal)', SANS];
const BREAKPOINTS = ['767px', '1100px'];
const RADII = ['0', '4px', '6px', '8px', '999px'];

/** Every value of one CSS property in the stylesheet, without !important. */
function values(property: string): string[] {
  return [...styles.matchAll(new RegExp(`(?:^|[;{\\s])${property}\\s*:\\s*([^;}]+)`, 'g'))]
    .map(match => match[1].replace(/!important/, '').trim());
}

describe('viewer token sheet', () => {
  it('uses only the six type sizes', () => {
    const off = values('font-size').filter(value => !TYPE_SIZES.includes(value) && value !== 'inherit');
    expect(off).toEqual([]);
  });

  it('uses one sans and one monospace, with Monaspace Radon for the logo word only', () => {
    const families = values('font-family');
    const radon = families.filter(value => value.includes('Monaspace Radon'));
    // @font-face declares it; .logo-text uses it.
    expect(radon.length).toBe(2);
    expect(styles).toMatch(/\.logo-text\s*\{[^}]*font-family:\s*'Monaspace Radon'/);
    const off = families.filter(value => !FONT_FAMILIES.includes(value) && !value.includes('Monaspace Radon'));
    expect(off).toEqual([]);
  });

  it('has two breakpoints', () => {
    const widths = [...styles.matchAll(/@media[^{]*?(?:max|min)-width\s*:\s*(\d+px)/g)].map(match => match[1]);
    expect(widths.length).toBeGreaterThan(0);
    expect(widths.filter(width => !BREAKPOINTS.includes(width))).toEqual([]);
  });

  it('gives each kind of element one corner radius', () => {
    const off = values('border-radius').flatMap(value => value.split(/\s+/)).filter(part => !RADII.includes(part));
    expect(off).toEqual([]);
  });

  it('keeps sizes, faces and radii out of the components\' inline styles', () => {
    const root = join(import.meta.dir, '../../src/ui/viewer');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry)) files.push(path);
      }
    };
    walk(root);
    const offenders = files.filter(path => /\b(fontSize|fontFamily|borderRadius)\s*:/.test(readFileSync(path, 'utf-8')));
    expect(offenders).toEqual([]);
  });
});
