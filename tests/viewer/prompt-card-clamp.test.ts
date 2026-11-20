import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { PromptCard } from '../../src/ui/viewer/components/PromptCard';
import type { UserPrompt } from '../../src/ui/viewer/types';

const viewerTemplate = readFileSync(join(import.meta.dir, '../../src/ui/viewer-template.html'), 'utf-8');

function makePrompt(text: string): UserPrompt {
  return {
    id: 1,
    content_session_id: 'sess',
    project: 'proj',
    platform_source: 'claude',
    prompt_number: 1,
    prompt_text: text,
    created_at_epoch: Date.UTC(2026, 9, 13, 12, 0, 0),
  };
}

// 16 lines x 121 chars + 15 newlines = 1,951 chars — sized after the ~2k-char
// automation prompt measured in #4757 (1,952 chars, 16 lines, 835px card).
const LONG_TEXT = Array.from({ length: 16 }, (_, i) =>
  `Run orchestration loop step ${String(i + 1).padStart(2, '0')}: inspect the staged diff, reconcile it against pending queue entries, note results.`
    .slice(0, 121)
    .padEnd(121, ' ')
).join('\n');
const SHORT_TEXT = 'two short lines\nof plain prompt text';

// #4757: a long prompt renders verbatim into an unbounded card that pushes the
// rest of the Timeline off screen. Long prompts must ship with a line clamp
// and a "Show all <n> characters" disclosure; short prompts must stay untouched.
describe('prompt card clamp (#4757)', () => {
  it('renders a long prompt clamped, with a collapsed "Show all <n> characters" disclosure', () => {
    const html = renderToStaticMarkup(React.createElement(PromptCard, { prompt: makePrompt(LONG_TEXT) }));
    expect(html).toContain('card-content-clamped');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(`Show all ${LONG_TEXT.length.toLocaleString('en')} characters`);
  });

  it('clamps a prompt over 3 lines even when it is under 225 characters', () => {
    const fourShortLines = Array.from({ length: 4 }, (_, i) => `line ${i + 1}`).join('\n');
    expect(fourShortLines.length).toBeLessThan(225);
    const html = renderToStaticMarkup(React.createElement(PromptCard, { prompt: makePrompt(fourShortLines) }));
    expect(html).toContain('card-content-clamped');
  });

  it('leaves a 3-line prompt under 225 characters unclamped', () => {
    const threeShortLines = Array.from({ length: 3 }, (_, i) => `line ${i + 1}`).join('\n');
    const html = renderToStaticMarkup(React.createElement(PromptCard, { prompt: makePrompt(threeShortLines) }));
    expect(html).not.toContain('card-content-clamped');
  });

  it('clamps a single-line prompt over 225 characters', () => {
    const html = renderToStaticMarkup(React.createElement(PromptCard, { prompt: makePrompt('x'.repeat(226)) }));
    expect(html).toContain('card-content-clamped');
    expect(renderToStaticMarkup(React.createElement(PromptCard, { prompt: makePrompt('x'.repeat(225)) }))).not.toContain('card-content-clamped');
  });

  it('draws a short one-line prompt as a single row', () => {
    const html = renderToStaticMarkup(React.createElement(PromptCard, { prompt: makePrompt('continue') }));
    expect(html).toContain('prompt-card--line');
    expect(html).toContain('prompt-row');
  });

  it('leaves a short prompt unclamped with no disclosure', () => {
    const html = renderToStaticMarkup(React.createElement(PromptCard, { prompt: makePrompt(SHORT_TEXT) }));
    expect(html).not.toContain('card-content-clamped');
    expect(html).not.toContain('aria-expanded');
    expect(html).not.toContain('Show all');
  });

  it('bounds the clamped prompt content with a line clamp in the stylesheet', () => {
    const body = viewerTemplate.match(/\.prompt-card \.card-content-clamped\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(body).toContain('-webkit-line-clamp');
    expect(body).toMatch(/overflow\s*:\s*hidden/);
  });
});
