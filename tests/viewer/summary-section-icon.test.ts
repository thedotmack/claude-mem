import { describe, it, expect } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const viewerTemplate = readFileSync(join(import.meta.dir, '../../src/ui/viewer-template.html'), 'utf-8');
const summaryCardSource = readFileSync(join(import.meta.dir, '../../src/ui/viewer/components/SummaryCard.tsx'), 'utf-8');

// Read the keys from the source so a future section without a size rule fails here too.
const sectionKeys = [...summaryCardSource.matchAll(/\{\s*key:\s*"(\w+)"/g)].map(match => match[1]);

// The SVG each section points at, in section order.
const iconFiles = [...summaryCardSource.matchAll(/icon:\s*"\/(icon-thick-[\w-]+\.svg)"/g)].map(match => match[1]);

/** Body of the first CSS rule whose selector is exactly `.summary-section-icon--<key>`. */
function iconRuleBody(key: string): string | undefined {
  const match = viewerTemplate.match(new RegExp(`\\.summary-section-icon--${key}\\s*\\{([^}]*)\\}`));
  return match?.[1];
}

describe('summary section icon sizing', () => {
  it('finds the section keys in SummaryCard', () => {
    expect(sectionKeys).toEqual(['investigated', 'learned', 'completed', 'next_steps', 'notes']);
  });

  it.each(sectionKeys)('sizes the .summary-section-icon--%s rule with a height', key => {
    // Without a height the SVG keeps its intrinsic size, so the icon renders far larger than its siblings.
    const body = iconRuleBody(key);
    expect(body, `missing .summary-section-icon--${key} rule`).toBeDefined();
    // Lookbehind so line-height, min-height or max-height cannot pass for a real height.
    expect(body).toMatch(/(?<![-\w])height\s*:/);
  });
});

describe('summary section icons', () => {
  it('assigns an icon to every section', () => {
    expect(iconFiles).toHaveLength(sectionKeys.length);
  });

  it('gives every section its own icon', () => {
    // Two sections sharing one SVG look identical in a summary that has both (NOTES once reused LEARNED's lightbulb).
    expect(new Set(iconFiles).size).toBe(iconFiles.length);
  });

  it.each(iconFiles)('ships %s in src/ui', file => {
    expect(existsSync(join(import.meta.dir, '../../src/ui', file))).toBe(true);
  });
});
