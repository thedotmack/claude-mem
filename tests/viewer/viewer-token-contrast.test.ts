import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const viewerTemplate = readFileSync(join(import.meta.dir, '../../src/ui/viewer-template.html'), 'utf-8');

/** Custom properties declared in the first rule that opens with `ruleOpener` (same parser as theme-tokens.test.ts). */
function themeTokens(ruleOpener: string): Record<string, string> {
  const start = viewerTemplate.indexOf(ruleOpener);
  expect(start).toBeGreaterThan(-1);
  const body = viewerTemplate.slice(start + ruleOpener.length, viewerTemplate.indexOf('}', start));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(match => [match[1], match[2].trim()]));
}

/** WCAG 2.x relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) throw new Error(`Not a #rrggbb colour: ${hex}`);
  const channels = [0, 2, 4].map(offset => parseInt(match[1].slice(offset, offset + 2), 16) / 255)
    .map(channel => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/** WCAG contrast ratio, (L1 + 0.05) / (L2 + 0.05). */
function contrast(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

const themes = {
  light: themeTokens('[data-theme="light"] {'),
  dark: themeTokens('[data-theme="dark"] {'),
};

/** Surfaces a card, the page or the header can put text or a control on. */
const SURFACES = ['--color-bg-primary', '--color-bg-card', '--color-bg-header', '--color-bg-card-hover', '--color-bg-summary', '--color-bg-prompt'];

/** [what, foreground tokens, background tokens, minimum ratio]. Text 4.5:1 (WCAG 1.4.3); control edges and focus 3:1 (1.4.11). */
const PAIRS: Array<[string, string[], string[], number]> = [
  ['body and meta text', ['--color-text-primary', '--color-text-secondary', '--color-text-tertiary', '--color-text-muted'], [...SURFACES, '--color-bg-control-hover'], 4.5],
  ['links, selected chips and tabs', ['--color-accent-primary'], SURFACES, 4.5],
  ['observation kind word', ['--color-type-badge-text'], ['--color-bg-card', '--color-bg-card-hover'], 4.5],
  ['summary kind word and labels', ['--color-summary-badge-text', '--color-accent-summary', '--color-text-summary'], ['--color-bg-summary'], 4.5],
  ['prompt kind word', ['--color-prompt-badge-text'], ['--color-bg-prompt'], 4.5],
  ['tool chips', ['--color-source-claude-text', '--color-source-codex-text', '--color-source-cursor-text', '--color-source-antigravity-cli-text'], SURFACES, 4.5],
  // The card menu's "Delete observation…" sits on the hover fill while it is pointed at or focused.
  ['delete and error text', ['--color-accent-error'], [...SURFACES, '--color-bg-control-hover'], 4.5],
  ['primary button and queue count', ['--color-text-button'], ['--color-bg-button', '--color-bg-button-hover', '--color-bg-button-active'], 4.5],
  ['control edges', ['--color-border-control'], [...SURFACES, '--color-bg-input', '--color-bg-control-hover'], 3],
  ['focus ring', ['--color-accent-focus'], ['--color-bg-primary', '--color-bg-card', '--color-bg-header'], 3],
  ['log levels', ['--color-log-debug', '--color-log-info', '--color-log-warn', '--color-log-error', '--color-log-success', '--color-log-component'], ['--color-bg-primary'], 4.5],
];

describe('viewer token contrast', () => {
  for (const [themeName, tokens] of Object.entries(themes)) {
    it(`meets the text, control-edge and focus contrast floors in the ${themeName} theme`, () => {
      const failures: string[] = [];
      for (const [what, foregrounds, backgrounds, minimum] of PAIRS) {
        for (const foreground of foregrounds) {
          for (const background of backgrounds) {
            const foregroundValue = tokens[foreground];
            const backgroundValue = tokens[background];
            if (!foregroundValue || !backgroundValue) { failures.push(`${what}: ${foreground} or ${background} is not defined`); continue; }
            const ratio = contrast(foregroundValue, backgroundValue);
            if (ratio < minimum) failures.push(`${what}: ${foreground} ${foregroundValue} on ${background} ${backgroundValue} is ${ratio.toFixed(2)}:1, needs ${minimum}:1`);
          }
        }
      }
      expect(failures).toEqual([]);
    });
  }

  it('keeps the decorative border token shared with the scrollbar thumb unchanged', () => {
    // The scrollbar thumb and the decorative borders share #3a3834 in dark; control edges use their own token.
    expect(themes.dark['--color-border-primary']).toBe('#3a3834');
    expect(themes.dark['--color-bg-scrollbar-thumb']).toBe('#3a3834');
    expect(themes.dark['--color-border-control']).not.toBe('#3a3834');
  });

  it('never paints a hovered plain button with the blue fill', () => {
    // The global button rules carry no specificity, so every component's own hover wins,
    // and the default hover is the neutral control-hover surface.
    expect(/\n\s*button:hover:not\(:disabled\)\s*\{/.test(viewerTemplate)).toBe(false);
    expect(/:where\(button:hover:not\(:disabled\)\)[^{]*\{[^}]*--color-bg-control-hover/.test(viewerTemplate)).toBe(true);
  });
});
