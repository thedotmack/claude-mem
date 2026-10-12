import { expect, it } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { PaginationHelper } from '../../../src/services/worker/PaginationHelper.js';
import type { DatabaseManager } from '../../../src/services/worker/DatabaseManager.js';
import { SummaryCard } from '../../../src/ui/viewer/components/SummaryCard.js';
import type { Summary } from '../../../src/ui/viewer/types.js';

it('keeps existing notes in the real paginated summary row for the viewer', () => {
  const store = new SessionStore(':memory:');
  try {
    const sid = store.createSDKSession('notes-viewer', 'owned-project', 'prompt');
    store.ensureMemorySessionIdRegistered(sid, 'notes-viewer-memory');
    store.storeSummary('notes-viewer-memory', 'owned-project', {
      request: '', investigated: '', learned: '', completed: '', next_steps: '', notes: 'VIEWER_NOTES_KEEP_THIS',
    }, 1);
    const manager = { getSessionStore: () => store } as DatabaseManager;
    const [row] = new PaginationHelper(manager).getSummaries(0, 10, 'owned-project').items;
    expect(row.notes).toBe('VIEWER_NOTES_KEEP_THIS');
    const html = renderToStaticMarkup(React.createElement(SummaryCard, { summary: row as unknown as Summary, onDeleted() {} }));
    expect(html).toContain('VIEWER_NOTES_KEEP_THIS');
  } finally { store.close(); }
});

it('renders notes from the existing live summary payload', () => {
  const summary = { id: 7, session_id: 'owned-content', project: 'owned-project', platform_source: 'claude',
    notes: 'LIVE_NOTES_KEEP_THIS', created_at_epoch: 1000 } as Summary;
  const html = renderToStaticMarkup(React.createElement(SummaryCard, { summary, onDeleted() {} }));
  expect(html).toContain('LIVE_NOTES_KEEP_THIS');
  expect(html).toContain('>Notes</h3>');
});
