import { rulesAndToolsPointerLine } from '../../src/services/context/RulesAndToolsFile.js';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { queryObservationsMulti, querySummariesMulti } from '../../src/services/context/ObservationCompiler.js';
import { renderContextFromRows } from '../../src/services/context/ContextBuilder.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { paths } from '../../src/shared/paths.js';
import { OBSERVER_HEALTH_FILENAME, OBSERVER_UNHEALTHY_FAILURE_THRESHOLD } from '../../src/shared/observer-health.js';
import { MEMORY_PLUGIN_INSTRUCTIONS } from '../../src/shared/memory-instructions.js';
import type { ContextConfig } from '../../src/services/context/types.js';

// The SessionStart block the model reads is the memory timeline. Its header says
// how to read it, everything else sits under that header, and the newest
// timeline entry ends it, so a later update can append rows to the timeline.

const PROJECT = 'layout-project';
const NOW = Date.UTC(2026, 10, 7, 20, 0, 0);
const WORK_STATE = 'Work state, still open:\n- release: status=active, updated 1 minute ago';

const config: ContextConfig = {
  totalObservationCount: 10, fullObservationCount: 0, sessionCount: 3,
  showReadTokens: false, showWorkTokens: false,
  // The query keeps only these; the fixture rows are all discovery / how-it-works.
  observationTypes: new Set(['discovery']), observationConcepts: new Set(['how-it-works']), fullObservationField: 'narrative',
  showLastSummary: true, showLastMessage: false,
};

let store: SessionStore;
let oldMode: unknown;
let oldModeId: unknown;
// Each test gets its own memory session: completed-observation deduplication
// would otherwise drop a row whose content an earlier test already stored.
let memorySessionId = '';
let testNumber = 0;

beforeEach(() => {
  const mode = ModeManager.getInstance();
  oldMode = Reflect.get(mode, 'activeMode');
  oldModeId = Reflect.get(mode, 'activeModeId');
  mode.loadMode('code');
  store = new SessionStore(':memory:');
  testNumber++;
  memorySessionId = `layout-memory-${testNumber}`;
  const sessionId = store.createSDKSession(`layout-content-${testNumber}`, PROJECT, 'prompt');
  store.ensureMemorySessionIdRegistered(sessionId, memorySessionId);
});

afterEach(() => {
  store.close();
  const mode = ModeManager.getInstance();
  Reflect.set(mode, 'activeMode', oldMode);
  Reflect.set(mode, 'activeModeId', oldModeId);
});

function observe(title: string, minutesAgo: number): void {
  store.storeObservations(memorySessionId, PROJECT, [{
    type: 'discovery', title, subtitle: null, facts: [], narrative: `${title} narrative`,
    concepts: ['how-it-works'], files_read: [], files_modified: [],
  }], null, 1, 50_000, NOW - minutesAgo * 60_000);
}

function render(input: Record<string, unknown> = {}, forHuman = false): string {
  const rows = {
    observations: queryObservationsMulti(store, [PROJECT], config),
    summaries: querySummariesMulti(store, [PROJECT], config),
  };
  return renderContextFromRows(rows, { workStateSection: WORK_STATE, ...input }, forHuman,
    { config, cwd: '/layout-fixture', project: PROJECT }).text;
}

describe('agent SessionStart block layout', () => {
  it('opens with the one Rules + Tools line and ends on the newest row, with nothing after it', () => {
    observe('OLDEST_ROW', 30);
    observe('MIDDLE_ROW', 20);
    observe('NEWEST_ROW', 10);
    const text = render();

    expect(text).toStartWith(`${rulesAndToolsPointerLine()}\n\n`);
    const order = [WORK_STATE, '\n### ', 'OLDEST_ROW', 'MIDDLE_ROW', 'NEWEST_ROW'];
    const positions = order.map(marker => text.indexOf(marker));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(text.split('\n').at(-1)).toMatch(/ NEWEST_ROW$/);

    // The old closing footer and the instruction blocks are gone from the block.
    expect(text).not.toContain('tokens of past work');
    expect(text).not.toContain(MEMORY_PLUGIN_INSTRUCTIONS.split('\n')[0]);
    expect(text).not.toContain('# Work state: your to-do lists');
    // How to read it lives in the file the line points to, not in every block.
    for (const repeated of ['recent context', 'Mode: ', 'Legend: ', 'Format: ', 'Fetch details: ', 'Stats: ']) {
      expect(text).not.toContain(repeated);
    }
  });

  it('ends on the last session summary when it is the newest entry, its fields right after its row', () => {
    observe('ONLY_ROW', 30);
    store.storeSummary(memorySessionId, PROJECT, {
      request: 'SUMMARY_REQUEST', investigated: 'SUMMARY_INVESTIGATED', learned: 'SUMMARY_LEARNED',
      completed: 'SUMMARY_COMPLETED', next_steps: 'SUMMARY_NEXT_STEPS', notes: null,
    }, 1, 0, NOW - 5 * 60_000);
    const text = render();

    expect(text.indexOf('ONLY_ROW')).toBeLessThan(text.indexOf('SUMMARY_REQUEST'));
    expect(text.indexOf('SUMMARY_REQUEST')).toBeLessThan(text.indexOf('**Investigated**: SUMMARY_INVESTIGATED'));
    expect(text).toEndWith('**Next Steps**: SUMMARY_NEXT_STEPS');
  });

  it('puts an unhealthy observer warning under the header, above the timeline', () => {
    const healthPath = join(paths.dataDir(), OBSERVER_HEALTH_FILENAME);
    mkdirSync(paths.dataDir(), { recursive: true });
    writeFileSync(healthPath, JSON.stringify({
      consecutiveFailures: OBSERVER_UNHEALTHY_FAILURE_THRESHOLD,
      failingSinceAt: NOW - 3_600_000,
      lastErrorAt: NOW - 60_000,
      lastErrorMessage: 'provider refused',
      lastErrorProvider: 'openrouter',
      lastSuccessAt: null,
    }));
    try {
      observe('NEWEST_ROW', 10);
      const text = render();
      const warningAt = text.indexOf("can't save memories");
      expect(warningAt).toBeGreaterThan(text.indexOf(rulesAndToolsPointerLine()));
      expect(warningAt).toBeLessThan(text.indexOf(WORK_STATE));
      expect(text.indexOf(WORK_STATE)).toBeLessThan(text.indexOf('\n### '));
      expect(text.split('\n').at(-1)).toMatch(/ NEWEST_ROW$/);

      // The terminal preview ends on its newest row too, so its warning goes above.
      const preview = render({}, true);
      expect(preview.indexOf("can't save memories")).toBeLessThan(preview.indexOf(rulesAndToolsPointerLine()));
      expect(preview.trimEnd().split('\n').at(-1)).toContain('NEWEST_ROW');
    } finally {
      rmSync(healthPath, { force: true });
    }
  });

  it('keeps the empty timeline last when a project has no memory yet', () => {
    const text = render();
    expect(text).toStartWith(`${rulesAndToolsPointerLine()}\n\n${WORK_STATE}`);
    expect(text).toEndWith(`${WORK_STATE}\n\nNo previous sessions found.`);
  });

  it('gives the terminal preview the same shape: the Rules + Tools line on top, the newest row last', () => {
    observe('OLDEST_ROW', 30);
    observe('NEWEST_ROW', 10);
    const preview = render({}, true);
    expect(preview.indexOf(rulesAndToolsPointerLine())).toBeGreaterThanOrEqual(0);
    expect(preview.indexOf(rulesAndToolsPointerLine())).toBeLessThan(preview.indexOf('OLDEST_ROW'));
    expect(preview).not.toContain('Legend: ');
    expect(preview.trimEnd().split('\n').at(-1)).toContain('NEWEST_ROW');
    // No closing line, and none of the old instruction blocks.
    expect(preview).not.toContain('tokens of past research & decisions');
    expect(preview).not.toContain('Column Key');
    expect(preview).not.toContain('Context Index');
    expect(preview).not.toContain('Trust this index');
    // The open lists are for the agent; the person sees them in My Work.
    expect(preview).not.toContain(WORK_STATE);
  });
});
