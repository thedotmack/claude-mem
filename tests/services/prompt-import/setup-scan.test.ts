import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { join } from 'path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SetupScan, type SetupScanState } from '../../../src/services/prompt-import/setup-scan.js';
import { SettingsDefaultsManager } from '../../../src/shared/SettingsDefaultsManager.js';
import { _resetRedactionConfigCache } from '../../../src/utils/redaction.js';

const FIXTURE_HOME = join(import.meta.dir, '..', '..', 'fixtures', 'prompt-import', 'home');
const NOW = Date.parse('2026-10-10T00:00:00.000Z');
const CLAUDE_SESSION = '11111111-aaaa-bbbb-cccc-000000000001';

let store: SessionStore;

function setupScan() {
  return new SetupScan({
    getStore: () => store,
    now: () => NOW,
    scanOptions: { homeDirectory: FIXTURE_HOME, resolveProject: cwd => (cwd ?? 'unknown').split('/').pop()! },
  });
}

function counts(state: SetupScanState) {
  return Object.fromEntries(state.agents.map(agent => [agent.id, { prompts: agent.prompts, fromMemory: agent.fromMemory, fromTranscripts: agent.fromTranscripts }]));
}

function promptRows(contentSessionId: string): Array<{ prompt_text: string; created_at_epoch: number; native_prompt_id: string | null }> {
  return store.db.prepare(`SELECT up.prompt_text, up.created_at_epoch, up.native_prompt_id FROM user_prompts up
    JOIN sdk_sessions s ON s.id = up.session_db_id WHERE s.content_session_id = ? ORDER BY up.created_at_epoch, up.id`).all(contentSessionId) as any;
}

/** What claude-mem's hooks record: an unkeyed prompt row, stamped a moment after the transcript line. */
function hookRecorded(platform: string, contentSessionId: string, project: string, text: string, at: string) {
  const sessionDbId = store.createSDKSession(contentSessionId, project, text, undefined, platform);
  const promptNumber = store.getPromptNumberFromUserPrompts(contentSessionId, sessionDbId) + 1;
  store.saveUserPrompt(contentSessionId, promptNumber, text, sessionDbId, undefined, undefined, Date.parse(at));
}

beforeEach(() => { store = new SessionStore(':memory:'); });
afterEach(() => { store.close(); });

describe('setup prompt scan', () => {
  it('marks each found agent that cannot run setup, with the detection\'s reason (Gemini credentials Google refuses)', async () => {
    const reason = "Gemini is installed, but this Google account can't use it: This client is no longer supported for Gemini Code Assist for individuals.";
    const scan = new SetupScan({
      getStore: () => store, now: () => NOW,
      scanOptions: { homeDirectory: FIXTURE_HOME, resolveProject: cwd => (cwd ?? 'unknown').split('/').pop()! },
      detectAgents: async () => [
        { id: 'claude-code', path: '/bin/claude', authenticated: true, reason: 'logged in' },
        { id: 'codex', path: null, authenticated: false, reason: 'not installed: `codex` is not on PATH' },
        { id: 'gemini', path: '/bin/gemini', authenticated: false, reason },
      ],
    });
    scan.start();
    const state = await scan.finished();
    const runners = Object.fromEntries(state.agents.map(agent => [agent.id, [agent.detected, agent.canRunSetup, agent.cannotRunReason]]));
    expect(runners).toEqual({
      'claude-code': [true, true, null],
      codex: [true, false, 'not installed: `codex` is not on PATH'],
      'gemini-cli': [true, false, reason],
      'antigravity-cli': [true, null, null],
      opencode: [true, null, null],
    });
  });

  it('new install: an empty DB is filled from every agent transcript, and a re-scan adds nothing', async () => {
    const scan = setupScan();
    const events: SetupScanState[] = [];
    scan.subscribe(state => events.push(state));
    scan.start();
    const state = await scan.finished();

    expect(state).toMatchObject({ phase: 'done', done: true, percent: 100, added: 13, error: null, skippedSources: 0 });
    expect(counts(state)).toEqual({
      'claude-code': { prompts: 5, fromMemory: 0, fromTranscripts: 5 },
      codex: { prompts: 1, fromMemory: 0, fromTranscripts: 1 },
      'gemini-cli': { prompts: 4, fromMemory: 0, fromTranscripts: 4 },
      'antigravity-cli': { prompts: 2, fromMemory: 0, fromTranscripts: 2 },
      opencode: { prompts: 1, fromMemory: 0, fromTranscripts: 1 },
    });
    expect(events.map(event => event.phase)).toEqual(expect.arrayContaining(['reading', 'checking', 'saving', 'done']));
    expect(events.filter(event => event.done).every(event => event.phase === 'done')).toBe(true);

    // Stored with the transcript's own time, under a finished session, with the transcript's key.
    expect(promptRows(CLAUDE_SESSION).map(row => row.prompt_text)).toEqual(['make the scan screen show each agent', '/claude-mem:do PLAN.md', 'continue', 'continue', 'ship it']);
    expect(promptRows(CLAUDE_SESSION)[0]).toMatchObject({ created_at_epoch: Date.parse('2026-10-01T10:01:00.000Z'), native_prompt_id: 'transcript:u-typed-1' });
    const session = store.db.prepare(`SELECT status, platform_source, project FROM sdk_sessions WHERE content_session_id = ?`).get('codex-interactive-1');
    expect(session).toEqual({ status: 'completed', platform_source: 'codex', project: 'beta' });

    scan.start();
    const again = await scan.finished();
    expect(again.added).toBe(0);
    expect(counts(again)).toEqual(counts(state));
    expect((store.db.prepare('SELECT COUNT(*) AS n FROM user_prompts').get() as { n: number }).n).toBe(13);
  });

  it('upgrade: prompts the hooks already recorded are matched, never stored twice, and counted as from memory', async () => {
    hookRecorded('claude', CLAUDE_SESSION, 'alpha', 'make the scan screen show each agent', '2026-10-01T10:01:02.000Z');
    hookRecorded('claude', CLAUDE_SESSION, 'alpha', 'Reply with ok', '2026-10-01T10:03:00.500Z'); // headless turn: not typed by the owner
    hookRecorded('claude', CLAUDE_SESSION, 'alpha', '/do PLAN.md', '2026-10-01T10:10:00.030Z'); // the hook's short command form
    hookRecorded('claude', CLAUDE_SESSION, 'alpha', 'continue', '2026-10-01T10:20:01.000Z'); // only the first of two "continue"s
    hookRecorded('claude', 'session-older-than-its-transcript', 'alpha', 'plan the funnel', '2026-10-05T09:00:00.000Z');
    hookRecorded('codex', 'codex-interactive-1', 'beta', 'fix the flaky test in beta', '2026-10-02T10:01:00.010Z');

    const scan = setupScan();
    scan.start();
    const state = await scan.finished();

    expect(state.added).toBe(9);
    expect(counts(state)).toEqual({
      'claude-code': { prompts: 6, fromMemory: 4, fromTranscripts: 2 },
      codex: { prompts: 1, fromMemory: 1, fromTranscripts: 0 },
      'gemini-cli': { prompts: 4, fromMemory: 0, fromTranscripts: 4 },
      'antigravity-cli': { prompts: 2, fromMemory: 0, fromTranscripts: 2 },
      opencode: { prompts: 1, fromMemory: 0, fromTranscripts: 1 },
    });
    expect(promptRows(CLAUDE_SESSION).map(row => [row.prompt_text, row.native_prompt_id])).toEqual([
      ['make the scan screen show each agent', null],
      ['Reply with ok', null],
      ['/do PLAN.md', null],
      ['continue', null],
      ['continue', 'transcript:u-continue-2'],
      ['ship it', 'transcript:u-blocks'],
    ]);
    expect(promptRows('codex-interactive-1')).toHaveLength(1);

    scan.start();
    const again = await scan.finished();
    expect(again.added).toBe(0);
    expect(counts(again)).toEqual(counts(state));
    expect(promptRows(CLAUDE_SESSION)).toHaveLength(6);
  });

  it('extraction also reads typed prompts whose transcripts are gone, without repeating matched ones', async () => {
    hookRecorded('claude', CLAUDE_SESSION, 'alpha', 'make the scan screen show each agent', '2026-10-01T10:01:02.000Z');
    hookRecorded('claude', 'session-older-than-its-transcript', 'alpha', 'plan the funnel', '2026-10-05T09:00:00.000Z');
    let extracted: Array<{ text: string; sessionId: string; project: string; agent: string }> = [];
    const scan = setupScan();
    scan.setExtractor(async prompts => { extracted = prompts; });
    scan.start();
    await scan.finished();
    expect(extracted.filter(prompt => prompt.text === 'make the scan screen show each agent')).toHaveLength(1);
    expect(extracted.filter(prompt => prompt.text === 'plan the funnel')).toEqual([
      expect.objectContaining({ sessionId: 'session-older-than-its-transcript', project: 'alpha', agent: 'claude-code' }),
    ]);
  });

  it('memory-only prompts get the current tag stripping and redaction before extraction', async () => {
    // Stored while redaction was off; redaction is turned on before setup reads it.
    hookRecorded('claude', 'session-older-than-its-transcript', 'alpha', 'plan the funnel with sk-ABCDEFGHIJ1234567890abcdef <private>my secret</private>', '2026-10-05T09:00:00.000Z');
    const loadSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({ ...SettingsDefaultsManager.getAllDefaults(), CLAUDE_MEM_REDACT_ENABLED: 'true' }));
    _resetRedactionConfigCache();
    try {
      let extracted: Array<{ text: string; sessionId: string }> = [];
      const scan = setupScan();
      scan.setExtractor(async prompts => { extracted = prompts; });
      scan.start();
      const state = await scan.finished();
      const stored = extracted.find(prompt => prompt.sessionId === 'session-older-than-its-transcript')!;
      expect(stored.text).toStartWith('plan the funnel with');
      for (const text of [stored.text, ...state.recentPrompts.map(prompt => prompt.text)]) {
        expect(text).not.toContain('sk-ABCDEFGHIJ1234567890abcdef');
        expect(text).not.toContain('my secret');
      }
    } finally { loadSpy.mockRestore(); _resetRedactionConfigCache(); }
  });

  it('a failing store ends the scan as failed, never as a finished result', async () => {
    const scan = new SetupScan({
      getStore: () => { throw new Error('database is locked'); },
      now: () => NOW,
      scanOptions: { homeDirectory: FIXTURE_HOME },
    });
    scan.start();
    const state = await scan.finished();
    expect(state).toMatchObject({ phase: 'failed', done: true, error: 'database is locked' });
    expect(state.agents.every(agent => agent.prompts === 0)).toBe(true);
  });
});
