import { describe, expect, test } from 'bun:test';
import { buildAgentView } from '../../../src/services/work-view/agent-view.mjs';
import { conversationKey, originalFor } from '../../../src/services/work-view/request-projection.mjs';
import { NOW, promptWindow } from '../../fixtures/work-view-prompt-window.js';

describe('request projection session prompt lookup', () => {
  test('retains original selection, scope updates and attribution from a real SQLite window', () => {
    const window = promptWindow(6);
    try {
      const records = window.read();
      const before = JSON.stringify(records);
      const view = buildAgentView(window.state, records, { now: NOW });
      expect(view.humanRequests).toHaveLength(6);
      for (const session of records.sessions) {
        const request = view.humanRequests.find((row: any) => row.id === conversationKey(session));
        expect(request.original).toEqual(originalFor(session, records.prompts));
        expect(request.scopeUpdates.map((row: any) => row.promptNumber)).toEqual([15, 16, 17, 18, 19, 20]);
        expect(request.items).toHaveLength(2);
        expect(request.items.every((row: any) => row.agentSessionId === session.id)).toBe(true);
        expect(request.projects).toEqual([session.project]);
      }
      expect(JSON.stringify(records)).toBe(before);
    } finally { window.database.close(); }
  });

  test('rebuilds the per-snapshot lookup after prompt edits and deletions', () => {
    const window = promptWindow(2);
    try {
      const render = () => buildAgentView(window.state, window.read(), { now: NOW });
      const find = (view: any) => view.humanRequests.find((row: any) => row.conversationKey === JSON.stringify(['conversation', 'claude', 'content-1']));
      expect(find(render()).original.text).toBe('Build the requested feature 1');
      window.database.prepare('UPDATE user_prompts SET prompt_text = ? WHERE id = 1').run('Build the corrected feature');
      expect(find(render()).original.text).toBe('Build the corrected feature');
      window.database.exec('DELETE FROM user_prompts WHERE id = 1');
      const next = find(render());
      expect(next.original.source).toBe('session-initial-request');
      expect(next.original.text).toBe('Build the requested feature 1');
      expect(next.items).toHaveLength(2);
    } finally { window.database.close(); }
  });

  test('does not rescan unrelated prompts for every conversation and work item', () => {
    const window = promptWindow(100);
    try {
      const records = window.read();
      expect(records.sessions).toHaveLength(100);
      expect(records.prompts).toHaveLength(2000);
      expect(records.observations).toHaveLength(200);
      const expected = buildAgentView(window.state, records, { now: NOW });
      let reads = 0;
      // Instrument values actually returned by SQLite, not an alternate parser
      // or a wall-clock deadline. The original values and ordering stay intact.
      for (const prompt of records.prompts) {
        const sessionId = prompt.session_db_id;
        Object.defineProperty(prompt, 'session_db_id', {
          enumerable: true, configurable: true,
          get() { reads++; return sessionId; },
        });
      }
      const actual = buildAgentView(window.state, records, { now: NOW });
      const projectionReads = reads;
      expect(actual).toEqual(expected);
      expect(actual.humanRequests).toHaveLength(100);
      expect(actual.agents.flatMap((agent: any) => agent.work)).toHaveLength(200);
      expect(projectionReads).toBeLessThan(records.prompts.length * 20);
    } finally { window.database.close(); }
  });
});
