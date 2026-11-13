import { describe, expect, it } from 'bun:test';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { WAITING_FOR, type WaitingFor } from '../../../src/services/work-view/waiting-for.mjs';

// Compile the card's real label with its sources: no DOM package is needed.
const compiled = buildSync({
  stdin: {
    resolveDir: resolve(import.meta.dir, '../../../src/ui/my-work'), loader: 'tsx', contents: `
      import React from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import { WaitingForLabel } from './src/components/request-card';
      import { SAMPLE_REQUESTS, WAITING_FOR_LABEL } from './src/data';
      export { WAITING_FOR_LABEL };
      export const renderLabel = (change) => renderToStaticMarkup(<WaitingForLabel request={{ ...SAMPLE_REQUESTS.find((request) => request.id === 'r1'), ...change }} />);
    `,
  },
  tsconfig: resolve(import.meta.dir, '../../../src/ui/my-work/tsconfig.app.json'),
  bundle: true, write: false, format: 'cjs', platform: 'node',
  loader: { '.webp': 'dataurl' }, define: { 'process.env.NODE_ENV': '"production"' },
}).outputFiles[0].text;

// The label's store reads the browser window when it loads. Give it a bare one only while the module
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
  return module.exports as { renderLabel: (change: object) => string; WAITING_FOR_LABEL: Record<WaitingFor, string | null> };
}
const { renderLabel, WAITING_FOR_LABEL } = loadFixture();

describe('what the request card says its latest turn waits for', () => {
  it('shows the words for each value that owes the person something', () => {
    const owed = WAITING_FOR.filter((value) => value !== 'nothing');
    for (const value of owed) expect(renderLabel({ waitingFor: value })).toBe(`<span>${WAITING_FOR_LABEL[value]}</span>`);
    expect(new Set(owed.map((value) => WAITING_FOR_LABEL[value])).size).toBe(owed.length);
  });

  it('shows no label when nothing is owed, when no summary said, and on shipped work', () => {
    expect(renderLabel({ waitingFor: 'nothing' })).toBe('');
    expect(renderLabel({ waitingFor: undefined })).toBe('');
    expect(renderLabel({ waitingFor: 'review', state: 'shipped' })).toBe('');
  });
});
