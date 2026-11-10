import { describe, expect, it } from 'bun:test';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

// Compile the real empty Rules state with its sources: no DOM package is needed.
const compiled = buildSync({
  stdin: {
    resolveDir: resolve(import.meta.dir, '../../../src/ui/my-work'), loader: 'tsx', contents: `
      import React from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import { NoRulesYet, RuleEvidence, RuleEvidenceNotice } from './src/pages/my-rules';
      export const renderNoRules = (readError, refresh) => renderToStaticMarkup(<NoRulesYet onAdd={() => {}} readError={readError} refresh={refresh} />);
      export const renderEvidence = (rule) => renderToStaticMarkup(<><RuleEvidenceNotice rule={rule} /><RuleEvidence rule={rule} /></>);
    `,
  },
  tsconfig: resolve(import.meta.dir, '../../../src/ui/my-work/tsconfig.app.json'),
  bundle: true, write: false, format: 'cjs', platform: 'node',
  loader: { '.webp': 'dataurl' }, define: { 'process.env.NODE_ENV': '"production"' },
}).outputFiles[0].text;

// The page's store reads the browser window when it loads. Give it a bare one only while the module
// evaluates, so no other suite in this process sees a fake window.
function loadFixture() {
  const module = { exports: {} as any };
  const hadWindow = 'window' in globalThis;
  const previousWindow = (globalThis as any).window;
  (globalThis as any).window = {
    location: { search: '', href: 'http://localhost/', hostname: 'localhost' },
    history: { replaceState() {}, pushState() {} },
    matchMedia: () => ({ matches: false }),
    addEventListener() {}, removeEventListener() {}, scrollTo() {},
  };
  try {
    new Function('module', 'exports', 'require', compiled)(module, module.exports, createRequire(import.meta.url));
  } finally {
    if (hadWindow) (globalThis as any).window = previousWindow;
    else delete (globalThis as any).window;
  }
  return module.exports;
}
const { renderNoRules, renderEvidence } = loadFixture();

const NO_AGENT = 'No logged-in Claude Code, Codex or Gemini on this computer yet.';
const LEARNS_ON_ITS_OWN = 'claude-mem learns how you like to work from your requests on its own.';

describe('empty Rules page (#5535)', () => {
  it('says rule learning is waiting for an agent, and why, instead of promising it happens on its own', () => {
    const html = renderNoRules(null, { state: 'waiting-for-agent', finishedAt: null, error: NO_AGENT });
    expect(html).toContain('Rule learning is waiting for an agent.');
    expect(html).toContain(`Waiting to refresh: ${NO_AGENT}`);
    expect(html).toContain('Add rule');
    expect(html).not.toContain('on its own');
  });

  it('keeps the learns-on-its-own copy when no refresh is waiting', () => {
    const html = renderNoRules(null, null);
    expect(html).toContain(LEARNS_ON_ITS_OWN);
    expect(html).toContain('Add rule');
    expect(html).not.toContain('Waiting to refresh');
  });

  it('shows only the read error when rules cannot be read', () => {
    const html = renderNoRules('x', { state: 'waiting-for-agent', finishedAt: null, error: NO_AGENT });
    expect(html).toContain('Can’t read your rules right now');
    expect(html).not.toContain('Add rule');
    expect(html).not.toContain('Waiting to refresh');
  });
});

describe('saved rule evidence budget', () => {
  it('shows the omitted count without describing a learned rule as owner-written', () => {
    const html = renderEvidence({ quotes: [], quotesOmitted: 2, source: 'request-progress' });
    expect(html).toContain('2 supporting quotes could not fit in this saved rule.');
    expect(html).toContain('Other devices may show fewer quotes.');
    expect(html).toContain('No supporting quotes are available on this computer.');
    expect(html).not.toContain('You wrote this rule');
  });

  it('still shows the budget notice when the local story supplies the missing evidence', () => {
    const html = renderEvidence({
      quotes: [{ quote: 'keep the supporting evidence', at: 'Today', kind: 'directive', where: 'prompt' }],
      quotesOmitted: 1, source: 'request-progress', records: [],
    });
    expect(html).toContain('1 supporting quote could not fit in this saved rule.');
    expect(html).toContain('keep the supporting evidence');
  });

  it('keeps the owner-written explanation without a false budget warning', () => {
    const html = renderEvidence({ quotes: [], source: 'you' });
    expect(html).toContain('You wrote this rule in My Rules');
    expect(html).not.toContain('could not fit');
  });
});
