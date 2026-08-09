import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { buildCompactionTimeline } from '../../src/services/worker/observer-compaction.js';

// buildCompactionTimeline loads context config, which resolves the active mode
// through ModeManager.getInstance(). Mocked via spyOn rather than
// loadMode('code'): an earlier test file's top-level mock.module of
// ModeManager can leak into this file under whole-suite ordering (see
// observer-compaction-hook.test.ts), and spyOn works on either the real
// class or a leaked stub. observation_types/observation_concepts must match
// the seeded observations so queryObservationsMulti's filters keep them.
const mockMode = {
  name: 'code',
  prompts: {},
  observation_types: [{ id: 'discovery' }],
  observation_concepts: [{ id: 'how-it-works' }],
};

let modeManagerSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  modeManagerSpy = spyOn(ModeManager, 'getInstance').mockImplementation(() => ({
    getActiveMode: () => mockMode,
    loadMode: () => {},
    // Used by the timeline renderer (AgentFormatter.renderAgentTableRow).
    getTypeIcon: () => '*',
  } as any));
});

afterEach(() => {
  modeManagerSpy.mockRestore();
});

function seedObservation(
  store: SessionStore,
  input: {
    project: string;
    memorySessionId: string;
    title: string;
    narrative: string;
    createdAtEpoch: number;
  },
): void {
  store.storeObservation(
    input.memorySessionId,
    input.project,
    {
      type: 'discovery',
      title: input.title,
      subtitle: null,
      facts: [],
      narrative: input.narrative,
      concepts: ['how-it-works'],
      files_read: [],
      files_modified: [],
    },
    1,
    0,
    input.createdAtEpoch,
  );
}

function createSession(store: SessionStore, project: string, memorySessionId: string): void {
  const sessionDbId = store.createSDKSession(`${memorySessionId}-content`, project, 'test prompt');
  store.ensureMemorySessionIdRegistered(sessionDbId, memorySessionId);
}

describe('buildCompactionTimeline', () => {
  it('includes every observation when the budget is huge', () => {
    const store = new SessionStore(':memory:');
    try {
      const project = 'compaction-huge-budget';
      createSession(store, project, 'huge-memory');
      const titles = ['ALPHA_OBS', 'BRAVO_OBS', 'CHARLIE_OBS', 'DELTA_OBS'];
      titles.forEach((title, i) => {
        seedObservation(store, {
          project,
          memorySessionId: 'huge-memory',
          title,
          narrative: `narrative for ${title}`,
          createdAtEpoch: 1_700_000_000_000 + i * 1000,
        });
      });
      store.storeSummary(
        'huge-memory',
        project,
        {
          request: 'HUGE_BUDGET_SUMMARY',
          investigated: 'investigated',
          learned: 'learned',
          completed: 'completed',
          next_steps: 'next',
          notes: null,
        },
        1,
        0,
        1_700_000_010_000,
      );

      const output = buildCompactionTimeline(store, project, '/tmp/compaction-test', 1_000_000);

      for (const title of titles) {
        expect(output).toContain(title);
      }
      // The seeded summary renders as an `S<id>` line containing its request
      // text (renderAgentSummaryItem in AgentFormatter).
      expect(output).toContain('HUGE_BUDGET_SUMMARY');
      // buildTimeline sorts ascending, so the oldest observation renders first.
      expect(output.indexOf('ALPHA_OBS')).toBeLessThan(output.indexOf('DELTA_OBS'));
    } finally {
      store.close();
    }
  });

  it('keeps only the newest observations when the budget is tiny, and stays near the budget', () => {
    const store = new SessionStore(':memory:');
    try {
      const project = 'compaction-tiny-budget';
      createSession(store, project, 'tiny-memory');
      // Oldest and middle are ~205 tokens each (800-char narratives); newest is
      // ~55 tokens (200-char narrative). A 100-token budget fits only the newest.
      seedObservation(store, {
        project,
        memorySessionId: 'tiny-memory',
        title: 'OLDEST_OBS',
        narrative: 'x'.repeat(800),
        createdAtEpoch: 1_700_000_000_000,
      });
      seedObservation(store, {
        project,
        memorySessionId: 'tiny-memory',
        title: 'MIDDLE_OBS',
        narrative: 'y'.repeat(800),
        createdAtEpoch: 1_700_000_001_000,
      });
      seedObservation(store, {
        project,
        memorySessionId: 'tiny-memory',
        title: 'NEWEST_OBS',
        narrative: 'z'.repeat(200),
        createdAtEpoch: 1_700_000_002_000,
      });

      const tokenBudget = 100;
      const output = buildCompactionTimeline(store, project, '/tmp/compaction-test', tokenBudget);

      expect(output).toContain('NEWEST_OBS');
      expect(output).not.toContain('MIDDLE_OBS');
      expect(output).not.toContain('OLDEST_OBS');

      // The rendered string tracks the budget with tolerance: the renderer adds
      // day headers and table chrome beyond raw observation content, so allow
      // 20% overage plus a fixed header allowance rather than exactness.
      const HEADER_ALLOWANCE_TOKENS = 100;
      const estimatedTokens = Math.ceil(output.length / 4);
      expect(estimatedTokens).toBeLessThanOrEqual(1.2 * tokenBudget + HEADER_ALLOWANCE_TOKENS);
    } finally {
      store.close();
    }
  });

  it('drops every observation when the budget is smaller than any single one', () => {
    const store = new SessionStore(':memory:');
    try {
      const project = 'compaction-zero-fit';
      createSession(store, project, 'zero-fit-memory');
      const titles = ['ZF_ALPHA_OBS', 'ZF_BRAVO_OBS'];
      titles.forEach((title, i) => {
        seedObservation(store, {
          project,
          memorySessionId: 'zero-fit-memory',
          title,
          narrative: 'w'.repeat(400),
          createdAtEpoch: 1_700_000_000_000 + i * 1000,
        });
      });
      store.storeSummary(
        'zero-fit-memory',
        project,
        {
          request: 'ZERO_FIT_SUMMARY',
          investigated: 'investigated',
          learned: 'learned',
          completed: 'completed',
          next_steps: 'next',
          notes: null,
        },
        1,
        0,
        1_700_000_010_000,
      );

      // ~50 tokens is smaller than any single seeded observation (~103), so
      // the budget walk keeps nothing — but the call must not throw, and the
      // short summary's rendered line plus day header (~17 tokens) still fits.
      const output = buildCompactionTimeline(store, project, '/tmp/compaction-test', 50);

      for (const title of titles) {
        expect(output).not.toContain(title);
      }
      expect(output).toContain('ZERO_FIT_SUMMARY');
    } finally {
      store.close();
    }
  });

  it('budgets summaries too — long stored requests cannot blow past the budget', () => {
    const store = new SessionStore(':memory:');
    try {
      const project = 'compaction-summary-budget';
      // Ten summaries with 4,000-char requests (~1,000 tokens each) against a
      // 100-token budget: unbudgeted, these rendered a ~10,000-token timeline
      // (PR #3516 review repro). Each needs its own memory session because
      // querySummariesMulti returns one summary per session.
      for (let i = 0; i < 10; i++) {
        const memorySessionId = `summary-budget-memory-${i}`;
        createSession(store, project, memorySessionId);
        store.storeSummary(
          memorySessionId,
          project,
          {
            request: `LONG_SUMMARY_${i} ` + 'q'.repeat(4000),
            investigated: 'investigated',
            learned: 'learned',
            completed: 'completed',
            next_steps: 'next',
            notes: null,
          },
          1,
          0,
          1_700_000_000_000 + i * 1000,
        );
      }

      const tokenBudget = 100;
      const output = buildCompactionTimeline(store, project, '/tmp/compaction-test', tokenBudget);

      // Rendered size must stay near the budget instead of ballooning to the
      // summaries' full ~10k tokens. Small allowance for day headers.
      expect(Math.ceil(output.length / 4)).toBeLessThanOrEqual(tokenBudget + 50);
    } finally {
      store.close();
    }
  });

  it('enforces the budget on rendered output — row scaffolding cannot blow past it', () => {
    const store = new SessionStore(':memory:');
    try {
      const project = 'compaction-rendered-budget';
      // Ten one-char summary requests: the admission walk charges ~1 token
      // each, but every row renders as `S<id> <char> (<datetime>)` plus day
      // headers — ~94 tokens against a 10-token budget before the
      // rendered-output limit existed (PR #3516 review repro).
      for (let i = 0; i < 10; i++) {
        const memorySessionId = `rendered-budget-memory-${i}`;
        createSession(store, project, memorySessionId);
        store.storeSummary(
          memorySessionId,
          project,
          {
            request: 'x',
            investigated: 'investigated',
            learned: 'learned',
            completed: 'completed',
            next_steps: 'next',
            notes: null,
          },
          1,
          0,
          1_700_000_000_000 + i * 1000,
        );
      }

      const tokenBudget = 10;
      const output = buildCompactionTimeline(store, project, '/tmp/compaction-test', tokenBudget);

      expect(Math.ceil(output.length / 4)).toBeLessThanOrEqual(tokenBudget);
    } finally {
      store.close();
    }
  });

  it('renders an empty string for a project with no observations', () => {
    const store = new SessionStore(':memory:');
    try {
      const output = buildCompactionTimeline(store, 'compaction-empty-project', '/tmp/compaction-test', 1000);
      expect(output).toBe('');
    } finally {
      store.close();
    }
  });
});
