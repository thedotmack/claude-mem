import { expect, it } from 'bun:test';
import {
  FIXTURE_PAGE_HTML, UNTHROTTLED_TIMER_FLAGS, chromeExecutablePath, compileBrowserFixture,
  failOnCiWithoutChrome, htmlResponse, launchChrome, scriptResponse, withTimeout, type OwnedChrome,
} from '../../helpers/chrome-devtools';

failOnCiWithoutChrome('CI requires Chrome or Chromium for the conversation row retry regression.');

// The conversation row in a real page, with a data source whose every read the fixture answers by hand: the first read
// fails, "Try again" is pressed and its read never answers, it is pressed again and that read fails too, and the next read
// brings the conversation back.
(chromeExecutablePath ? it : it.skip)('keeps a failed read\'s reason and "Try again" on screen while it reads again, until a read answers', async () => {
  const bundle = compileBrowserFixture(`
    import React from './src/ui/my-work/node_modules/react';
    import { createRoot } from './src/ui/my-work/node_modules/react-dom/client';
    import { ConversationContinue } from './src/ui/my-work/src/components/conversation-continue';
    import { sampleSource } from './src/ui/my-work/src/live/sample-source';
    import { useStore } from './src/ui/my-work/src/store';
    // The shared fixture compiler uses classic JSX; the app's Vite build uses automatic JSX.
    window.React = React;
    window.addEventListener('error', event => fetch('/result', { method: 'POST', body: JSON.stringify({ error: event.message }) }));
    let phase = 'initial';
    async function until(test) {
      const end = Date.now() + 7000;
      while (!test()) {
        if (Date.now() > end) throw new Error('Conversation row fixture did not settle (' + phase + '): ' + document.body.textContent);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    const text = () => document.body.textContent;
    const tryAgainButton = () => [...document.querySelectorAll('button')].find(button => button.getAttribute('aria-describedby'));
    /** The label the button shows: of labels laid in one place (LabelsInOnePlace), the one not made invisible; else its text. */
    const shownLabel = () => {
      const button = tryAgainButton();
      if (!button) return null;
      const labelsInOnePlace = [...button.querySelectorAll('span > span')];
      if (labelsInOnePlace.length === 0) return button.textContent;
      return labelsInOnePlace.find(label => !label.classList.contains('invisible'))?.textContent ?? null;
    };
    (async () => {
      try {
        const reads = [];
        const source = { ...sampleSource, sourceKind: 'local',
          loadConversationContinuation: () => new Promise((resolve, reject) => { reads.push({ resolve, reject }); }),
          continueConversation: () => Promise.reject(new Error('No message is sent here.')),
          stopConversationContinuation: () => Promise.reject(new Error('No turn runs here.')),
          subscribeToConversationContinuations: () => () => {},
        };
        const stop = useStore.getState().startWorkSource(source);
        createRoot(document.getElementById('root')).render(
          <ConversationContinue platform="claude" conversationSessionId="0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d" toolName="Claude Code" conversationTitle="Fix the login flow" />,
        );
        await until(() => reads.length === 1);
        reads[0].reject(new Error('FIRST_READ_FAILED'));
        phase = 'first-failure';
        await until(() => text().includes('FIRST_READ_FAILED') && shownLabel() === 'Try again');

        tryAgainButton().click();
        phase = 'trying-again';
        await until(() => reads.length === 2 && shownLabel() === 'Trying again…');
        const whileTryingAgain = { reason: text().includes('FIRST_READ_FAILED'), button: shownLabel() };

        // The second read never answers. The button can still be pressed, and asks for a newer read.
        tryAgainButton().click();
        phase = 'pressed-again';
        await until(() => reads.length === 3);
        reads[2].reject(new Error('SECOND_READ_FAILED'));
        phase = 'second-failure';
        await until(() => text().includes('SECOND_READ_FAILED') && shownLabel() === 'Try again');
        const afterTheNewFailure = { oldReasonGone: !text().includes('FIRST_READ_FAILED'), button: shownLabel() };

        // The read that never answered answers late: only the newest read is shown, so nothing changes. Had the row taken
        // it, React would draw it in its next scheduler task after this promise job, well within this wait.
        reads[1].resolve({ target: { canContinue: false, refusalText: 'LATE_STALE_ANSWER', recordedFolder: null }, exchanges: [] });
        await new Promise(resolve => setTimeout(resolve, 50));
        const lateAnswerIgnored = !text().includes('LATE_STALE_ANSWER') && text().includes('SECOND_READ_FAILED');

        tryAgainButton().click();
        phase = 'answered';
        await until(() => reads.length === 4);
        reads[3].resolve({
          target: { canContinue: true, recordedFolder: '/work/example', runsInFolder: '/work/example', recordedFolderIsGone: false, opensInAppNamed: null },
          exchanges: [],
        });
        await until(() => document.querySelector('textarea') !== null);
        const afterTheAnswer = { reasonGone: !text().includes('SECOND_READ_FAILED'), tryAgainGone: tryAgainButton() === undefined };
        stop();
        await fetch('/result', { method: 'POST', body: JSON.stringify({ whileTryingAgain, afterTheNewFailure, lateAnswerIgnored, afterTheAnswer, reads: reads.length }) });
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
    chrome = launchChrome(server.url.href, { profilePrefix: 'claude-mem-conversation-retry-', extraFlags: UNTHROTTLED_TIMER_FLAGS });
    expect(await withTimeout(result, 30000, 'Conversation row browser did not report')).toEqual({
      whileTryingAgain: { reason: true, button: 'Trying again…' },
      afterTheNewFailure: { oldReasonGone: true, button: 'Try again' },
      lateAnswerIgnored: true,
      afterTheAnswer: { reasonGone: true, tryAgainGone: true },
      reads: 4,
    });
  } finally {
    await chrome?.close();
    server.stop(true);
  }
}, 60000);
