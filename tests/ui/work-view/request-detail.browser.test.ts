import { expect, it } from 'bun:test';
import {
  FIXTURE_PAGE_HTML, UNTHROTTLED_TIMER_FLAGS, chromeExecutablePath, compileBrowserFixture,
  failOnCiWithoutChrome, htmlResponse, launchChrome, scriptResponse, withTimeout, type OwnedChrome,
} from '../../helpers/chrome-devtools';

failOnCiWithoutChrome('CI requires Chrome or Chromium for the lazy request detail regression.');

(chromeExecutablePath ? it : it.skip)('loads request detail on open, cancels on close, retries errors, and keeps current summary fields', async () => {
  const bundle = compileBrowserFixture(`
    import React, { useState } from './src/ui/my-work/node_modules/react';
    import { createRoot } from './src/ui/my-work/node_modules/react-dom/client';
    import { RequestDetail } from './src/ui/my-work/src/components/request-detail';
    import { TooltipProvider } from './src/ui/my-work/src/components/ui/tooltip';
    import { sampleSource } from './src/ui/my-work/src/live/sample-source';
    import { useStore } from './src/ui/my-work/src/store';
    // The shared fixture compiler uses classic JSX; the app's Vite build uses automatic JSX.
    window.React = React;
    window.addEventListener('error', event => fetch('/result', { method: 'POST', body: JSON.stringify({ error: event.message }) }));
    let phase = 'initial';
    async function until(test) {
      const end = Date.now() + 7000;
      while (!test()) {
        if (Date.now() > end) throw new Error('Lazy detail fixture did not settle (' + phase + '): ' + document.body.textContent);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    (async () => {
      try {
        const model = await sampleSource.loadWorkModel();
        const full = { ...model.requests[0], title: 'Current request', workProduct: [{ kind: 'Doc', label: 'COMPLETE_DETAIL' }], detailLoaded: true, contentFingerprint: 'a'.repeat(64) };
        const compact = { ...full, workProduct: [], granular: [], detailLoaded: false, detailRevision: full.contentFingerprint };
        let calls = 0, aborted = 0, setRequest;
        const source = { ...sampleSource, sourceKind: 'local', loadWorkModel: async () => ({ ...model, sourceKind: 'local', requests: [compact] }),
          loadRequestDetail: (_id, _fingerprint, { signal }) => {
            const attempt = ++calls;
            if (attempt === 2) return Promise.reject(new Error('Temporary detail failure'));
            if (attempt === 3) return Promise.resolve(full);
            return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted++; reject(signal.reason); }, { once: true }));
          } };
        const stop = useStore.getState().startWorkSource(source);
        function Fixture() {
          const [request, set] = useState(compact);
          setRequest = set;
          return <TooltipProvider><RequestDetail request={request} onClose={() => set(null)} onOpenFocus={() => {}} /></TooltipProvider>;
        }
        createRoot(document.getElementById('root')).render(<Fixture />);
        await until(() => document.body.textContent.includes('Loading request detail'));
        const didWait = !document.body.textContent.includes('COMPLETE_DETAIL');
        document.querySelector('[data-slot="sheet-close"]').click();
        phase = 'first-close';
        await until(() => aborted === 1);
        setRequest(compact);
        phase = 'reopened-error';
        await until(() => document.body.textContent.includes('Temporary detail failure'));
        [...document.querySelectorAll('button')].find(button => button.textContent === 'Try again').click();
        phase = 'retried-detail';
        await until(() => document.body.textContent.includes('COMPLETE_DETAIL'));
        setRequest({ ...compact, title: 'RENAMED_CURRENT_REQUEST' });
        phase = 'renamed';
        await until(() => document.body.textContent.includes('RENAMED_CURRENT_REQUEST'));
        const keptDetail = document.body.textContent.includes('COMPLETE_DETAIL');
        const stableCalls = calls;
        setRequest({ ...compact, detailRevision: 'b'.repeat(64), contentFingerprint: 'b'.repeat(64) });
        phase = 'next-version';
        await until(() => calls === 4 && document.body.textContent.includes('Loading request detail'));
        const hidStale = !document.body.textContent.includes('COMPLETE_DETAIL');
        document.querySelector('[data-slot="sheet-close"]').click();
        await until(() => aborted === 2);
        stop();
        await fetch('/result', { method: 'POST', body: JSON.stringify({ didWait, aborted, keptDetail, stableCalls, hidStale }) });
      } catch (error) {
        await fetch('/result', { method: 'POST', body: JSON.stringify({ error: String(error) }) });
      }
    })();
  `);
  let report!: (value: unknown) => void;
  const result = new Promise<unknown>(resolve => { report = resolve; });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/') return htmlResponse(FIXTURE_PAGE_HTML);
    if (path === '/fixture.js') return scriptResponse(bundle);
    if (path === '/result') { report(await request.json()); return new Response('received'); }
    return new Response('not found', { status: 404 });
  } });
  let chrome: OwnedChrome | undefined;
  try {
    chrome = launchChrome(server.url.href, { profilePrefix: 'claude-mem-lazy-detail-', extraFlags: UNTHROTTLED_TIMER_FLAGS });
    expect(await withTimeout(result, 30000, 'Lazy detail browser did not report')).toEqual({ didWait: true, aborted: 2, keptDetail: true, stableCalls: 3, hidStale: true });
  } finally {
    await chrome?.close();
    server.stop(true);
  }
}, 60000);
