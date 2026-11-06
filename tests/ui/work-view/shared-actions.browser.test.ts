import { expect, it } from 'bun:test';
import {
  FIXTURE_PAGE_HTML, UNTHROTTLED_TIMER_FLAGS, chromeExecutablePath, compileBrowserFixture,
  failOnCiWithoutChrome, htmlResponse, launchChrome, scriptResponse, withTimeout, type OwnedChrome,
} from '../../helpers/chrome-devtools';

failOnCiWithoutChrome('CI requires Chrome or Chromium for the shared action regression.');

(chromeExecutablePath ? it : it.skip)('renders origin-only files and actionable conflicts, sends clicked versions, and reports queued saves', async () => {
  const bundle = compileBrowserFixture(`
    import React from './src/ui/my-work/node_modules/react';
    import { createRoot } from './src/ui/my-work/node_modules/react-dom/client';
    import { RequestDetail } from './src/ui/my-work/src/components/request-detail';
    import { TooltipProvider } from './src/ui/my-work/src/components/ui/tooltip';
    import { sampleSource } from './src/ui/my-work/src/live/sample-source';
    import { useStore } from './src/ui/my-work/src/store';
    window.React = React;
    const report = value => fetch('/result', { method: 'POST', body: JSON.stringify(value) });
    const until = async predicate => {
      const deadline = Date.now() + 7000;
      while (!predicate()) { if (Date.now() > deadline) throw new Error('Shared action fixture timed out: ' + document.body.textContent); await new Promise(resolve => setTimeout(resolve, 10)); }
    };
    (async () => {
      try {
        const base = await sampleSource.loadWorkModel();
        let model = { ...base, sourceKind: 'cloud', requests: [{ ...base.requests[0], title: 'Shared request', state: 'needs-check', checkedAt: undefined,
          contentFingerprint: 'evidence-read', review: { mode: 'shared', hash: 'review-read', available: true, conflict: true },
          workProduct: [{ kind: 'Doc', label: 'origin-report.pdf', availability: 'origin-only' }, { kind: 'PR', label: 'Published PR', href: 'https://github.com/example/repo/pull/1' }],
          suggestion: { conversationKey: 'conversation-read', requestId: 'group-read', requestTitle: 'Related request', evidence: 'Same feature', expectedSuggestionHash: 'suggestion-read', sharedConflict: true } }] };
        let reviewArgs, reviewCalls = 0;
        const suggestionCalls = [];
        const source = { ...sampleSource, sourceKind: 'cloud', loadWorkModel: async () => model,
          setRequestChecked: async (...args) => { reviewCalls++; reviewArgs ??= args; model = { ...model, requests: [{ ...model.requests[0], state: reviewCalls === 1 ? 'your-move' : 'needs-check', checkedAt: reviewCalls === 1 ? 'now' : undefined, contentFingerprint: reviewCalls === 1 ? 'evidence-read' : 'new-evidence', review: { mode: 'shared', hash: 'new-review', available: true, pending: true, conflict: reviewCalls === 3 } }] }; return { outcome: 'saved', model, save: { scope: 'shared', state: 'queued' } }; },
          answerRequestSuggestion: async (...args) => { suggestionCalls.push(args); if (suggestionCalls.length === 2) model = { ...model, requests: [{ ...model.requests[0], suggestion: { ...model.requests[0].suggestion, sharedConflict: false } }] }; return { model, save: { scope: 'shared', state: 'queued', ...(suggestionCalls.length === 2 ? { localMaterialization: 'pending' } : {}) } }; } };
        const stop = useStore.getState().startWorkSource(source);
        function Fixture() {
          const load = useStore(state => state.work.load);
          return load.state === 'loaded' ? <TooltipProvider><RequestDetail request={load.model.requests[0]} onClose={() => {}} onOpenFocus={() => {}} /></TooltipProvider> : null;
        }
        createRoot(document.getElementById('root')).render(<Fixture />);
        await until(() => document.body.textContent.includes('origin-report.pdf'));
        const file = [...document.querySelectorAll('span')].find(node => node.textContent === 'origin-report.pdf');
        const originHasNoLink = !file.closest('a');
        const publicLink = [...document.querySelectorAll('a')].find(node => node.textContent.includes('Published PR'))?.getAttribute('href');
        const originalComputerShown = document.body.textContent.includes('check the original computer');
        const findButton = label => [...document.querySelectorAll('button')].find(button => button.textContent === label);
        const conflictsActionable = !findButton('Mark checked').disabled && !findButton('Keep unchecked').disabled && !findButton('Join').disabled;
        const conflictGuidanceShown = document.body.textContent.includes('Read this suggestion, then choose again to resolve them.');
        findButton('Mark checked').click();
        await until(() => document.body.textContent.includes('waiting to sync to your other viewers'));
        findButton('Not this').click();
        await until(() => document.body.textContent.includes('Your decision was saved here, but grouping decisions still conflict. Read this suggestion and choose again. The saved decision is waiting to sync.'));
        const suggestionConflictReceiptExplained = !document.body.textContent.includes('Kept these requests separate.');
        findButton('Join').click();
        await until(() => document.body.textContent.includes('Joined the request. Saved here; waiting to sync to your other viewers.'));
        const pendingLocalCopyExplained = document.body.textContent.includes("This viewer's local work copy is still updating.");
        const joinQueuedShown = true;
        const queuedShown = document.body.textContent.includes('waiting to sync to your other viewers');
        const falseSyncClaim = document.body.textContent.includes('Checked locally.') || document.body.textContent.includes('Checks do not sync');
        findButton('Undo').click();
        await until(() => document.body.textContent.includes('The current work changed; review it again.'));
        const lateReceiptExplained = !!findButton('Mark checked');
        findButton('Mark checked').click();
        await until(() => document.body.textContent.includes('Your review decision was saved here, but your viewers still have conflicting decisions. Read this version and choose again. The saved decision is waiting to sync.'));
        const reviewConflictReceiptExplained = !document.body.textContent.includes('Checked for this shared version.');
        stop();
        await report({ originHasNoLink, publicLink, originalComputerShown, conflictsActionable, conflictGuidanceShown, reviewArgs, suggestionCalls, suggestionConflictReceiptExplained, reviewConflictReceiptExplained, pendingLocalCopyExplained, joinQueuedShown, queuedShown, falseSyncClaim, lateReceiptExplained });
      } catch (error) { await report({ error: String(error) }); }
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
    chrome = launchChrome(server.url.href, { profilePrefix: 'claude-mem-shared-actions-', extraFlags: UNTHROTTLED_TIMER_FLAGS });
    expect(await withTimeout(result, 30000, 'Shared action browser did not report')).toEqual({
      originHasNoLink: true, publicLink: 'https://github.com/example/repo/pull/1', originalComputerShown: true, conflictsActionable: true, conflictGuidanceShown: true,
      reviewArgs: ['r1', 'evidence-read', true, 'review-read'],
      suggestionCalls: [
        [{ conversationKey: 'conversation-read', requestId: 'group-read', requestTitle: 'Related request', evidence: 'Same feature', expectedSuggestionHash: 'suggestion-read', sharedConflict: true }, 'not-this'],
        [{ conversationKey: 'conversation-read', requestId: 'group-read', requestTitle: 'Related request', evidence: 'Same feature', expectedSuggestionHash: 'suggestion-read', sharedConflict: true }, 'join'],
      ],
      suggestionConflictReceiptExplained: true, reviewConflictReceiptExplained: true, pendingLocalCopyExplained: true, joinQueuedShown: true,
      queuedShown: true, falseSyncClaim: false, lateReceiptExplained: true,
    });
  } finally { await chrome?.close(); server.stop(true); }
}, 60000);
