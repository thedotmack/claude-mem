// Issue #4772: when a hook payload arrives without a cwd, the observation and
// advisor-call ingest paths must register the session's project as 'unknown' —
// the same fallback session init uses — instead of the empty string. Empty
// project rows make cloud sync quarantine every content line they produce
// ('summary.project must be a non-empty string'), and a late real init can
// only repair NULL/'' so the placeholder must stay repairable too.
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { ingestAdvisorCalls, ingestObservation, setIngestContext } from '../../src/services/worker/http/shared.js';
import { logger } from '../../src/utils/logger.js';

let store: SessionStore;
let loggerSpies: Array<ReturnType<typeof spyOn>> = [];
let sessionManager: {
  queueObservation: ReturnType<typeof mock>;
  queueSummarize: ReturnType<typeof mock>;
  requestSessionWrapup: ReturnType<typeof mock>;
  getSession: () => undefined;
};
let eventBroadcaster: {
  broadcastObservationQueued: ReturnType<typeof mock>;
  broadcastSummarizeQueued: ReturnType<typeof mock>;
};
let ensureGeneratorRunning: ReturnType<typeof mock>;
let settingsSpies: Array<ReturnType<typeof spyOn>> = [];

function projectOf(contentSessionId: string): string | null | undefined {
  const row = store.db.prepare(
    'SELECT project FROM sdk_sessions WHERE content_session_id = ?'
  ).get(contentSessionId) as { project: string | null } | undefined;
  return row?.project;
}

beforeEach(() => {
  // Hermetic settings (#4774 review): ingest reads the real user settings file
  // and applies CLAUDE_MEM_* env overrides, so a developer with
  // CLAUDE_MEM_SKIP_TOOLS=Bash, a matching CLAUDE_MEM_SKIP_BASH_PATTERNS entry,
  // or an excluded project would see these tests skip ingest and fail. Pin
  // loadFromFile to the built-in defaults — no env merge, no user file.
  settingsSpies = [
    spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(
      () => SettingsDefaultsManager.getAllDefaults()
    ),
  ];
  loggerSpies = [
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
  ];
  store = new SessionStore(new Database(':memory:'));
  sessionManager = {
    queueObservation: mock(async () => {}),
    queueSummarize: mock(async () => {}),
    requestSessionWrapup: mock(async () => {}),
    getSession: () => undefined,
  };
  eventBroadcaster = {
    broadcastObservationQueued: mock(() => {}),
    broadcastSummarizeQueued: mock(() => {}),
  };
  ensureGeneratorRunning = mock(async () => {});
  setIngestContext({
    sessionManager: sessionManager as any,
    dbManager: { getSessionStore: () => store } as any,
    eventBroadcaster: eventBroadcaster as any,
    ensureGeneratorRunning,
  });
});

afterEach(() => {
  loggerSpies.forEach(spy => spy.mockRestore());
  settingsSpies.forEach(spy => spy.mockRestore());
  store.close();
});

describe('ingest without a cwd registers the project as unknown (#4772)', () => {
  it('observation ingest falls back to unknown when the payload has no cwd', async () => {
    const result = await ingestObservation({
      contentSessionId: 'obs-no-cwd',
      platformSource: 'claude',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      toolResponse: { stdout: 'x' },
      toolUseId: 'toolu_obs_nocwd',
    });

    expect(result).toMatchObject({ ok: true });
    expect(projectOf('obs-no-cwd')).toBe('unknown');
  });

  it('observation ingest falls back to unknown when cwd is blank', async () => {
    const result = await ingestObservation({
      contentSessionId: 'obs-blank-cwd',
      platformSource: 'claude',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      toolResponse: { stdout: 'x' },
      cwd: '   ',
      toolUseId: 'toolu_obs_blank',
    });

    expect(result).toMatchObject({ ok: true });
    expect(projectOf('obs-blank-cwd')).toBe('unknown');
  });

  it('advisor-call ingest falls back to unknown when the payload has no cwd', async () => {
    const result = await ingestAdvisorCalls({
      contentSessionId: 'adv-no-cwd',
      platformSource: 'claude',
      calls: [{ toolUseId: 'srvtoolu_adv_nocwd', advice: 'Raise the retry budget.', occurredAtEpoch: 1 }],
    });

    expect(result).toMatchObject({ status: 'stored', stored: 1 });
    expect(projectOf('adv-no-cwd')).toBe('unknown');
  });

  it('a late init with a real project repairs an unknown-project session', async () => {
    await ingestObservation({
      contentSessionId: 'late-init-repair',
      platformSource: 'claude',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      toolResponse: { stdout: 'x' },
      toolUseId: 'toolu_repair',
    });
    expect(projectOf('late-init-repair')).toBe('unknown');

    // Session init arrives afterwards with the real project.
    store.createSDKSession('late-init-repair', '/real/project', 'first prompt');

    expect(projectOf('late-init-repair')).toBe('/real/project');
  });

  it('a no-cwd ingest never overwrites a real project with unknown', async () => {
    store.createSDKSession('init-first', '/real/project', 'first prompt');

    await ingestObservation({
      contentSessionId: 'init-first',
      platformSource: 'claude',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      toolResponse: { stdout: 'x' },
      toolUseId: 'toolu_init_first',
    });

    expect(projectOf('init-first')).toBe('/real/project');
  });

  it('a real project literally named unknown is never replaced by a later real project (#4774 review)', () => {
    // Path mode resolves a non-git checkout literally named `unknown` to the
    // project key 'unknown' — by project alone it is indistinguishable from the
    // no-cwd placeholder. The recorded launch cwd is what proves the row is a
    // real project, so the repair must leave it untouched.
    const sessionDbId = store.createSDKSession('real-unknown', 'unknown', 'first prompt');
    store.setSessionCwd(sessionDbId, '/work/unknown', 'path');

    store.createSDKSession('real-unknown', '/other/project', 'second prompt');

    expect(projectOf('real-unknown')).toBe('unknown');
  });

  it('a real project named unknown survives a later no-cwd observation ingest (#4774 review)', async () => {
    const sessionDbId = store.createSDKSession('real-unknown-obs', 'unknown', 'first prompt');
    store.setSessionCwd(sessionDbId, '/work/unknown', 'path');

    await ingestObservation({
      contentSessionId: 'real-unknown-obs',
      platformSource: 'claude',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      toolResponse: { stdout: 'x' },
      toolUseId: 'toolu_real_unknown',
    });

    expect(projectOf('real-unknown-obs')).toBe('unknown');
  });

  it('an unknown-project row with a recorded cwd is a real project, not a repairable placeholder', () => {
    // Same guard, stated from the placeholder side: once a cwd is on the row,
    // the stored 'unknown' is never swapped for a later different project.
    const sessionDbId = store.createSDKSession('unknown-with-cwd', 'unknown', 'first prompt');
    store.setSessionCwd(sessionDbId, '/work/unknown', 'path');

    store.createSDKSession('unknown-with-cwd', '/different/project', '');

    expect(projectOf('unknown-with-cwd')).toBe('unknown');
  });
});
