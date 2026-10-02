import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const viewerTemplate = readFileSync(join(import.meta.dir, '../../src/ui/viewer-template.html'), 'utf-8');

/** Custom properties declared in the first rule that opens with `ruleOpener`. */
function themeTokens(ruleOpener: string): Record<string, string> {
  const start = viewerTemplate.indexOf(ruleOpener);
  expect(start).toBeGreaterThan(-1);
  const body = viewerTemplate.slice(start + ruleOpener.length, viewerTemplate.indexOf('}', start));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(match => [match[1], match[2].trim()]));
}

const lightTheme = themeTokens('[data-theme="light"] {');
const darkTheme = themeTokens('[data-theme="dark"] {');
// Applies before the theme hook sets data-theme, so the page never flashes light first.
const systemDarkFallback = themeTokens(':root:not([data-theme]) {');

describe('viewer theme tokens', () => {
  it('mirrors every dark theme token in the system-dark fallback', () => {
    expect(Object.keys(darkTheme).length).toBeGreaterThan(0);
    expect(systemDarkFallback).toEqual(darkTheme);
  });

  it('defines every source badge token in both themes', () => {
    const badgeTokens = new Set([...viewerTemplate.matchAll(/var\((--color-source-[\w-]+)\)/g)].map(match => match[1]));
    expect(badgeTokens.size).toBeGreaterThan(0);
    const missing = [...badgeTokens].filter(token => !(token in lightTheme) || !(token in darkTheme));
    expect(missing).toEqual([]);
  });
});
