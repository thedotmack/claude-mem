import { expect, it } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { parseAgentXml } from '../../src/sdk/parser.js';
import { querySummariesMulti } from '../../src/services/context/ObservationCompiler.js';
import { renderContextFromRows } from '../../src/services/context/ContextBuilder.js';
import { toLocalSummaryShape } from '../../src/services/context/ServerContextRows.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import type { ContextConfig } from '../../src/services/context/types.js';

const config: ContextConfig = {
  totalObservationCount: 10, fullObservationCount: 3, sessionCount: 3,
  showReadTokens: false, showWorkTokens: false, showSavingsAmount: false, showSavingsPercent: false,
  observationTypes: new Set(), observationConcepts: new Set(), fullObservationField: 'narrative',
  showLastSummary: true, showLastMessage: false,
};

for (const forHuman of [false, true]) {
  it(`carries a parsed notes-only summary through SQLite into context (human=${forHuman})`, () => {
    const mode = ModeManager.getInstance();
    const oldMode = Reflect.get(mode, 'activeMode');
    const oldId = Reflect.get(mode, 'activeModeId');
    const store = new SessionStore(':memory:');
    try {
      mode.loadMode('code');
      const parsed = parseAgentXml('<summary><notes>NOTES_ONLY_KEEP_THIS_FINDING</notes></summary>');
      expect(parsed.valid).toBe(true);
      const sid = store.createSDKSession('notes-context', 'owned-project', 'prompt');
      store.ensureMemorySessionIdRegistered(sid, 'notes-memory');
      const summary = parsed.summary!;
      store.storeSummary('notes-memory', 'owned-project', {
        request: summary.request ?? '', investigated: summary.investigated ?? '', learned: summary.learned ?? '',
        completed: summary.completed ?? '', next_steps: summary.next_steps ?? '', notes: summary.notes,
      }, 1);
      const rows = querySummariesMulti(store, ['owned-project'], config);
      expect(rows).toHaveLength(1);
      const rendered = renderContextFromRows({ observations: [], summaries: rows }, undefined, forHuman,
        { config, cwd: '/owned-fixture', project: 'owned-project' });
      expect(rendered.text).toContain('NOTES_ONLY_KEEP_THIS_FINDING');
      const disabled = renderContextFromRows({ observations: [], summaries: rows }, undefined, forHuman,
        { config: { ...config, showLastSummary: false }, cwd: '/owned-fixture', project: 'owned-project' });
      expect(disabled.text).not.toContain('NOTES_ONLY_KEEP_THIS_FINDING');
    } finally {
      store.close();
      Reflect.set(mode, 'activeMode', oldMode);
      Reflect.set(mode, 'activeModeId', oldId);
    }
  });

  it(`carries existing server summary metadata into context (human=${forHuman})`, () => {
    const mode = ModeManager.getInstance();
    const oldMode = Reflect.get(mode, 'activeMode');
    const oldId = Reflect.get(mode, 'activeModeId');
    try {
      mode.loadMode('code');
      const summary = toLocalSummaryShape({ id: 'server-summary', kind: 'summary',
        metadata: { notes: 'SERVER_NOTES_KEEP_THIS_FINDING' }, createdAtEpoch: 1000 }, 'owned-project', 'claude');
      const rendered = renderContextFromRows({ observations: [], summaries: [summary] }, undefined, forHuman,
        { config, cwd: '/owned-fixture', project: 'owned-project' });
      expect(rendered.text).toContain('SERVER_NOTES_KEEP_THIS_FINDING');
    } finally {
      Reflect.set(mode, 'activeMode', oldMode);
      Reflect.set(mode, 'activeModeId', oldId);
    }
  });
}
