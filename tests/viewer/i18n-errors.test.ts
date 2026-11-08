import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { translateSettingsStatus, translateViewerError } from '../../src/ui/i18n/errors';
import { viewerZh } from '../../src/ui/i18n/viewer-zh';
import { settingsZh } from '../../src/ui/i18n/settings-zh';
import { describeDeleteFailure, deleteFeedItem } from '../../src/ui/viewer/utils/feed-deletion';
import { describeSessionDeleteFailure, deleteSession } from '../../src/ui/viewer/utils/sessions';
import { usePagination } from '../../src/ui/viewer/hooks/usePagination';
import { Feed } from '../../src/ui/viewer/components/Feed';

const catalog: Record<string, string> = { ...viewerZh, ...settingsZh };
const english = (source: string) => source;
const chinese = (source: string) => catalog[source] ?? source;

describe('render-time viewer errors', () => {
  it('renders a persisted feed error in the current locale while pagination still rejects in English', async () => {
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const originalFetch = globalThis.fetch;
    let locale = 'zh-CN';
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { localStorage: { getItem: () => locale } },
    });
    try {
      let pagination: ReturnType<typeof usePagination> | undefined;
      function Probe() {
        pagination = usePagination('project');
        return null;
      }
      renderToStaticMarkup(React.createElement(Probe));
      globalThis.fetch = (async () => new Response(null, { status: 503, statusText: 'Saving...' })) as typeof fetch;
      const stored = 'Failed to load observations: Saving...';
      await assert.rejects(pagination!.observations.loadMore(), { message: stored });
      const render = () => renderToStaticMarkup(React.createElement(Feed, {
        items: [], isLoading: false, hasMore: true, loadError: stored,
        onLoadMore() {}, onDeleted() {},
      }));
      assert.ok(render().includes(translateViewerError(stored, chinese)));
      locale = 'en';
      assert.ok(render().includes(stored));
      locale = 'zh-CN';
      assert.ok(render().includes(translateViewerError(stored, chinese)));
    } finally {
      globalThis.fetch = originalFetch;
      if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  });

  it('retranslates the same stored delete errors without changing their English source', () => {
    for (const describeFailure of [describeDeleteFailure, describeSessionDeleteFailure]) {
      for (const status of [404, 409, 503, 500]) {
        const stored = describeFailure(status);
        assert.equal(translateViewerError(stored, english), stored);
        assert.notEqual(translateViewerError(stored, chinese), stored);
        assert.equal(translateViewerError(stored, english), stored);
      }
    }
    assert.equal(translateViewerError(describeDeleteFailure(418), chinese),
      chinese('Not deleted: the worker answered HTTP {status}.').replace('{status}', '418'),
    );
  });

  it('retains English delete rejection messages independently of the UI locale', async () => {
    const failing = (async () => new Response(null, { status: 500 })) as typeof fetch;
    const offline = (async () => { throw new Error('opaque network details'); }) as typeof fetch;
    for (const operation of [
      (fetchImpl: typeof fetch) => deleteFeedItem('observation', 1, fetchImpl),
      (fetchImpl: typeof fetch) => deleteSession({ platformSource: 'claude', contentSessionId: '1' }, fetchImpl),
    ]) {
      await assert.rejects(operation(failing), { message: 'Not deleted: the worker answered HTTP 500.' });
      await assert.rejects(operation(offline), { message: 'Not deleted: the claude-mem worker could not be reached.' });
    }
  });

  it('retranslates assembled pagination errors and only translates the known data type', () => {
    for (const type of ['observations', 'summaries', 'prompts']) {
      const reason = 'Saving... $& {reason}\nserver details';
      const stored = `Failed to load ${type}: ${reason}`;
      const translated = translateViewerError(stored, chinese);
      assert.ok(translated.includes(chinese(type)));
      assert.ok(translated.endsWith(reason));
      assert.equal(translateViewerError(stored, english), stored);
    }
  });

  it('uses the session error template when supplied, or falls back to original English', () => {
    const stored = 'Could not load sessions: Saving... $& {error}';
    assert.equal(translateViewerError(stored, english), stored);
    assert.equal(translateViewerError(stored, source => source === 'Could not load sessions: {error}'
      ? '[sessions] {error}' : chinese(source)), '[sessions] Saving... $& {error}');
  });

  it('leaves arbitrary text and error parameters verbatim even when they match catalog keys', () => {
    for (const raw of ['Saving...', 'Delete', 'Failed to load custom: observations', 'user text']) {
      assert.equal(translateViewerError(raw, chinese), raw);
    }
    assert.equal(translateViewerError('Failed to load more data', chinese), chinese('Failed to load more data'));
  });

  it('renders settings envelopes and status changes without rewriting server details', () => {
    for (const [prefix, template] of [
      ['Could not load settings: ', 'Could not load settings: {error}'],
      ['\u2717 Error: ', '\u2717 Error: {error}'],
    ]) {
      const detail = 'Saving... $& {error}';
      const stored = prefix + detail;
      assert.equal(translateSettingsStatus(stored, chinese), chinese(template).replace('{error}', () => detail));
      assert.equal(translateSettingsStatus(stored, english), stored);
    }
    for (const status of ['Saving...', '\u2713 Saved']) {
      assert.equal(translateSettingsStatus(status, chinese), chinese(status));
      assert.equal(translateSettingsStatus(status, english), status);
    }
    assert.equal(translateSettingsStatus('Delete', chinese), 'Delete');
  });
});
