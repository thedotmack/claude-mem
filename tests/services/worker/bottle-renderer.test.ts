import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, readFileSync, readdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { BottleRenderer } from '../../../src/services/worker/BottleRenderer.js';
import type { DatabaseManager } from '../../../src/services/worker/DatabaseManager.js';
import { BOTTLES_DIR } from '../../../src/shared/paths.js';
import { MAX_STORED_PROMPT_CHARS } from '../../../src/services/sqlite/prompt-storage.js';

const FIXTURE_PATH = path.join(import.meta.dir, '..', '..', 'fixtures', 'claude-code-session.jsonl');

function obs(overrides: Partial<Parameters<SessionStore['storeObservation']>[2]> = {}) {
  return {
    type: 'discovery',
    title: 'Test Observation',
    subtitle: 'Test Subtitle',
    facts: ['fact1'],
    narrative: 'Test narrative content. Second sentence follows.',
    concepts: ['concept1'],
    files_read: ['/path/to/file1.ts'],
    files_modified: [],
    ...overrides,
  };
}

function summary(overrides: Partial<Parameters<SessionStore['storeSummary']>[2]> = {}) {
  return {
    request: 'User requested feature X',
    investigated: 'Explored the codebase',
    learned: 'Discovered pattern Y',
    completed: 'Implemented feature X',
    next_steps: 'Add tests and documentation',
    notes: null as string | null,
    ...overrides,
  };
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('BottleRenderer', () => {
  let store: SessionStore;
  let renderer: BottleRenderer;

  beforeEach(() => {
    store = new SessionStore(':memory:');
    renderer = new BottleRenderer({ getSessionStore: () => store } as unknown as DatabaseManager);
  });

  afterEach(() => {
    store.close();
  });

  // observations/session_summaries reference sdk_sessions(memory_session_id) via enforced FK;
  // register the session and set memory_session_id first.
  function registerSession(contentSessionId: string, memorySessionId: string): number {
    const sessionDbId = store.createSDKSession(contentSessionId, 'test-project', 'initial prompt');
    store.updateMemorySessionId(sessionDbId, memorySessionId);
    return sessionDbId;
  }

  describe('full mode (transcript present)', () => {
    it('renders the verbatim spine, keeps the mid-turn final assistant text, and skips the torn last line', async () => {
      const contentSessionId = 'bottle-full-spine';
      registerSession(contentSessionId, 'mem-full-spine');

      const result = await renderer.renderBottle(contentSessionId, FIXTURE_PATH, '/repo/endless');

      expect(result).not.toBeNull();
      expect(result!.mode).toBe('full');
      expect(result!.bottlePath).toBe(path.join(BOTTLES_DIR, `${contentSessionId}.md`));
      expect(existsSync(result!.bottlePath)).toBe(true);

      const bottle = readFileSync(result!.bottlePath, 'utf-8');
      expect(bottle).toContain(`# Session bottle — ${contentSessionId}`);
      expect(bottle).toContain('project: /repo/endless');
      expect(bottle).toContain('started: 2026-07-17T10:32:00.000Z');
      expect(bottle).toContain('mode: full');
      expect(bottle).toContain('## Original request');

      // Genuine turns, verbatim.
      expect(bottle).toContain('Add a bottle renderer to the worker');
      expect(bottle).toContain('and wire it up');
      expect(bottle).toContain("I'll read the worker service first.");
      expect(bottle).toContain('Now write the tests and make them pass');

      // Mid-turn: the final assistant text before the torn line is present verbatim.
      expect(bottle).toContain('Tests added.');
      expect(bottle).toContain('All 12 tests green.');
    });

    it('filters tool_result, system-reminder, sidechain, compact-summary, and meta entries out of the bottle', async () => {
      const contentSessionId = 'bottle-full-envelopes';
      registerSession(contentSessionId, 'mem-full-envelopes');

      const result = await renderer.renderBottle(contentSessionId, FIXTURE_PATH);
      const bottle = readFileSync(result!.bottlePath, 'utf-8');

      expect(bottle).not.toContain('TOOL-RESULT-MARKER');
      expect(bottle).not.toContain('SYSTEM-REMINDER-MARKER');
      expect(bottle).not.toContain('COMMAND-WRAPPER-MARKER');
      expect(bottle).not.toContain('SIDECHAIN-USER-MARKER');
      expect(bottle).not.toContain('SIDECHAIN-ASSISTANT-MARKER');
      expect(bottle).not.toContain('COMPACT-SUMMARY-MARKER');
      expect(bottle).not.toContain('CAVEAT-MARKER');
      expect(bottle).not.toContain('MIXED-TOOL-RESULT-MARKER');
      expect(bottle).not.toContain('MEDIA-DATA-MARKER');
      // The genuine prompts survive the filter.
      expect(bottle).toContain('Add a bottle renderer to the worker');
      expect(bottle).toContain('Now write the tests and make them pass');
    });

    it('renders a command-wrapper entry as a user turn with the extracted command text', async () => {
      const contentSessionId = 'bottle-full-command';
      registerSession(contentSessionId, 'mem-full-command');
      // prompt_number 2 belongs to the /model command turn.
      const commandObservation = store.storeObservation(
        'mem-full-command',
        'test-project',
        obs({ title: 'Switched model', narrative: 'Model switched to sonnet. Session continued.' }),
        2,
        0,
        1000000000000
      );

      const result = await renderer.renderBottle(contentSessionId, FIXTURE_PATH);
      const bottle = readFileSync(result!.bottlePath, 'utf-8');

      expect(bottle).toContain('/model sonnet');
      // The command consumes turn 2: its observation group sits between the
      // command turn and the following media-prompt turn.
      const commandIndex = bottle.indexOf('/model sonnet');
      const observationIndex = bottle.indexOf(`- [#${commandObservation.id}] Switched model`);
      const mediaIndex = bottle.indexOf('[media prompt]');
      expect(observationIndex).toBeGreaterThan(commandIndex);
      expect(observationIndex).toBeLessThan(mediaIndex);
    });

    it('renders a media-only user entry as a [media prompt] turn', async () => {
      const contentSessionId = 'bottle-full-media';
      registerSession(contentSessionId, 'mem-full-media');

      const result = await renderer.renderBottle(contentSessionId, FIXTURE_PATH);
      const bottle = readFileSync(result!.bottlePath, 'utf-8');

      expect(bottle).toContain('[media prompt]');
      expect(bottle).not.toContain('MEDIA-DATA-MARKER');
      // Positioned between the command turn and the next genuine prompt.
      const mediaIndex = bottle.indexOf('[media prompt]');
      expect(mediaIndex).toBeGreaterThan(bottle.indexOf('/model sonnet'));
      expect(mediaIndex).toBeLessThan(bottle.indexOf('Now write the tests and make them pass'));
    });

    it('keeps the text of mixed entries (assistant text+tool_use, user tool_result+text)', async () => {
      const contentSessionId = 'bottle-full-mixed';
      registerSession(contentSessionId, 'mem-full-mixed');

      const result = await renderer.renderBottle(contentSessionId, FIXTURE_PATH);
      const bottle = readFileSync(result!.bottlePath, 'utf-8');

      expect(bottle).toContain('Running the suite now.');
      expect(bottle).toContain('[Request interrupted by user] actually also run typecheck');
      expect(bottle).not.toContain('MIXED-TOOL-RESULT-MARKER');
    });

    it('skips an adjacent duplicate user turn inside the dedupe window (save-time mirror)', async () => {
      const contentSessionId = 'bottle-full-dedupe';
      registerSession(contentSessionId, 'mem-full-dedupe');

      const result = await renderer.renderBottle(contentSessionId, FIXTURE_PATH);
      const bottle = readFileSync(result!.bottlePath, 'utf-8');

      // The fixture repeats the prompt 5s later; only one turn renders.
      expect(countOccurrences(bottle, 'Now write the tests and make them pass')).toBe(1);
    });

    it('groups one-line observation entries under the matching user prompt, before the following Assistant heading', async () => {
      const contentSessionId = 'bottle-full-observations';
      registerSession(contentSessionId, 'mem-full-observations');
      const first = store.storeObservation(
        'mem-full-observations',
        'test-project',
        obs({ title: 'Read worker service', narrative: 'Explored worker-service wiring. Then checked the routes in detail.' }),
        1,
        0,
        1000000000000
      );
      // prompt_number 4 = the "Now write the tests" turn (after command + media turns).
      const second = store.storeObservation(
        'mem-full-observations',
        'test-project',
        obs({ title: 'Wrote tests', narrative: null, subtitle: 'bottle renderer coverage' }),
        4,
        0,
        2000000000000
      );
      const unanchored = store.storeObservation(
        'mem-full-observations',
        'test-project',
        obs({ title: 'Unanchored observation', narrative: 'Happened with no prompt number. More detail.' }),
        undefined,
        0,
        3000000000000
      );

      const result = await renderer.renderBottle(contentSessionId, FIXTURE_PATH);
      const bottle = readFileSync(result!.bottlePath, 'utf-8');

      const firstUserIndex = bottle.indexOf('**User**');
      const firstObservationIndex = bottle.indexOf(`- [#${first.id}] Read worker service — Explored worker-service wiring.`);
      const fourthUserIndex = bottle.indexOf('Now write the tests and make them pass');
      const secondObservationIndex = bottle.indexOf(`- [#${second.id}] Wrote tests — bottle renderer coverage`);
      // The Assistant heading that follows turn 4's observation group.
      const followingAssistantIndex = bottle.indexOf('**Assistant**', fourthUserIndex);

      expect(firstObservationIndex).toBeGreaterThan(firstUserIndex);
      expect(firstObservationIndex).toBeLessThan(fourthUserIndex);
      expect(secondObservationIndex).toBeGreaterThan(fourthUserIndex);
      expect(followingAssistantIndex).toBeGreaterThan(-1);
      expect(secondObservationIndex).toBeLessThan(followingAssistantIndex);

      // Null prompt_number lands in the trailing bucket after the last message.
      const unanchoredIndex = bottle.indexOf(`- [#${unanchored.id}] Unanchored observation`);
      expect(unanchoredIndex).toBeGreaterThan(bottle.indexOf('All 12 tests green.'));

      // One line each: first sentence only, never the full narrative.
      expect(bottle).not.toContain('Then checked the routes in detail');
    });

    it('strips <private> spans from user and assistant messages (spec test 2, full mode)', async () => {
      const contentSessionId = 'bottle-full-privacy';
      registerSession(contentSessionId, 'mem-full-privacy');

      const result = await renderer.renderBottle(contentSessionId, FIXTURE_PATH);
      const bottle = readFileSync(result!.bottlePath, 'utf-8');

      expect(bottle).not.toContain('sk-test-12345');
      expect(bottle).not.toContain('hunter2');
      expect(bottle).not.toContain('<private>');
      // The surrounding public text stays.
      expect(bottle).toContain('Add a bottle renderer to the worker');
      expect(bottle).toContain('All 12 tests green.');
    });

    it('uses the first user turn with surviving public text as the Original request', async () => {
      const contentSessionId = 'bottle-full-private-first';
      const transcriptDir = mkdtempSync(path.join(tmpdir(), 'bottle-transcript-'));
      const transcriptPath = path.join(transcriptDir, `${contentSessionId}.jsonl`);
      writeFileSync(transcriptPath, [
        '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"<private>entirely private opener</private>"}]},"timestamp":"2026-07-17T09:00:00.000Z"}',
        '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Public request here"}]},"timestamp":"2026-07-17T09:01:00.000Z"}',
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"On it."}]},"timestamp":"2026-07-17T09:02:00.000Z"}',
      ].join('\n'));

      const result = await renderer.renderBottle(contentSessionId, transcriptPath);
      const bottle = readFileSync(result!.bottlePath, 'utf-8');

      const originalRequestIndex = bottle.indexOf('## Original request');
      const nextLines = bottle.slice(originalRequestIndex).split('\n').slice(1, 3).join('\n');
      expect(nextLines).toContain('Public request here');
      expect(bottle).not.toContain('entirely private opener');
    });

    it('stores the cwd as the project on a session row it creates', async () => {
      const contentSessionId = 'bottle-project-arg';

      await renderer.renderBottle(contentSessionId, FIXTURE_PATH, '/repo/endless');

      const row = store.db.prepare('SELECT project FROM sdk_sessions WHERE content_session_id = ?')
        .get(contentSessionId) as { project: string };
      expect(row.project).toBe('/repo/endless');
    });
  });

  describe('unsafe contentSessionId', () => {
    it('returns null without writing anything for path-traversal ids', async () => {
      expect(await renderer.renderBottle('../evil')).toBeNull();
      expect(await renderer.renderBottle('..')).toBeNull();
      expect(await renderer.renderBottle('.')).toBeNull();
      expect(await renderer.renderBottle('id/with/slashes')).toBeNull();
      expect(await renderer.renderBottle('')).toBeNull();

      if (existsSync(BOTTLES_DIR)) {
        const written = readdirSync(BOTTLES_DIR).filter((name) => name.includes('evil') || name.includes('slashes'));
        expect(written).toEqual([]);
      }
    });
  });

  describe('reconstructed mode (no transcript)', () => {
    it('renders prompts in prompt_number order with truncation markers, observations, and provenance-marked summaries (spec test 3)', async () => {
      const contentSessionId = 'bottle-degraded';
      registerSession(contentSessionId, 'mem-degraded');
      store.saveUserPrompt(contentSessionId, 2, 'Second prompt: now fix the failing test');
      store.saveUserPrompt(contentSessionId, 1, 'First prompt: build the feature');
      store.saveUserPrompt(contentSessionId, 3, 'x'.repeat(MAX_STORED_PROMPT_CHARS + 500));
      const first = store.storeObservation(
        'mem-degraded',
        'test-project',
        obs({ title: 'Built the feature', narrative: 'Implemented the core path. Extra detail here.' }),
        1,
        0,
        1000000000000
      );
      store.storeSummary('mem-degraded', 'test-project', summary({ next_steps: 'Ship the bottle renderer' }), 2, 0, 2000000000000);

      const result = await renderer.renderBottle(contentSessionId);

      expect(result).not.toBeNull();
      expect(result!.mode).toBe('reconstructed');

      const bottle = readFileSync(result!.bottlePath, 'utf-8');
      expect(bottle).toContain('mode: reconstructed — assistant messages not preserved');

      // prompt_number ordering.
      const firstIndex = bottle.indexOf('First prompt: build the feature');
      const secondIndex = bottle.indexOf('Second prompt: now fix the failing test');
      expect(firstIndex).toBeGreaterThan(-1);
      expect(secondIndex).toBeGreaterThan(firstIndex);

      // The capped prompt carries an explicit truncation marker.
      expect(bottle).toContain(`[truncated at ${MAX_STORED_PROMPT_CHARS} chars]`);

      // Observations under their prompt, one line each.
      expect(bottle).toContain(`- [#${first.id}] Built the feature — Implemented the core path.`);
      expect(bottle.indexOf(`- [#${first.id}]`)).toBeGreaterThan(firstIndex);
      expect(bottle.indexOf(`- [#${first.id}]`)).toBeLessThan(secondIndex);

      // Summaries are provenance-marked quote blocks, never assistant turns.
      expect(bottle).toContain('> Session summary (generated by claude-mem — not verbatim)');
      expect(bottle).toContain('> Next steps: Ship the bottle renderer');
      expect(bottle).not.toContain('**Assistant**');

      expect(bottle).toContain('## Original request');
      expect(bottle).toContain('First prompt: build the feature');
    });

    it('renders null-prompt_number observations in the trailing bucket', async () => {
      const contentSessionId = 'bottle-degraded-unanchored';
      registerSession(contentSessionId, 'mem-degraded-unanchored');
      store.saveUserPrompt(contentSessionId, 1, 'Only prompt');
      const unanchored = store.storeObservation(
        'mem-degraded-unanchored',
        'test-project',
        obs({ title: 'Unanchored observation' }),
        undefined,
        0,
        3000000000000
      );

      const result = await renderer.renderBottle(contentSessionId);
      const bottle = readFileSync(result!.bottlePath, 'utf-8');

      const unanchoredIndex = bottle.indexOf(`- [#${unanchored.id}] Unanchored observation`);
      expect(unanchoredIndex).toBeGreaterThan(bottle.lastIndexOf('**User**'));
    });

    it('strips <private> spans from stored prompts and summary text (spec test 2, reconstructed mode)', async () => {
      const contentSessionId = 'bottle-degraded-privacy';
      const sessionDbId = registerSession(contentSessionId, 'mem-degraded-privacy');
      // Insert the prompt row raw: the renderer must strip even content that
      // bypassed the normal save-time stripping.
      store.db.prepare(`
        INSERT INTO user_prompts
        (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        sessionDbId,
        contentSessionId,
        1,
        'Deploy the service <private>prod db password is swordfish</private> to staging',
        new Date(1000000000000).toISOString(),
        1000000000000
      );
      store.storeSummary(
        'mem-degraded-privacy',
        'test-project',
        summary({ learned: 'Found the config <private>secret-plan-9</private> handling' }),
        1
      );

      const result = await renderer.renderBottle(contentSessionId);
      const bottle = readFileSync(result!.bottlePath, 'utf-8');

      expect(bottle).not.toContain('swordfish');
      expect(bottle).not.toContain('secret-plan-9');
      expect(bottle).not.toContain('<private>');
      expect(bottle).toContain('Deploy the service');
      expect(bottle).toContain('to staging');
    });

    it('does not fabricate assistant turns from summaries', async () => {
      const contentSessionId = 'bottle-degraded-no-fake';
      registerSession(contentSessionId, 'mem-degraded-no-fake');
      store.saveUserPrompt(contentSessionId, 1, 'Only prompt');
      store.storeSummary('mem-degraded-no-fake', 'test-project', summary(), 1);

      const result = await renderer.renderBottle(contentSessionId);
      const bottle = readFileSync(result!.bottlePath, 'utf-8');

      expect(bottle).not.toContain('**Assistant**');
      expect(bottle).toContain('> Session summary (generated by claude-mem — not verbatim)');
    });

    it('computes currentTask from the latest summary next_steps, falling back to request, then latest prompt', async () => {
      const contentSessionId = 'bottle-current-task';
      registerSession(contentSessionId, 'mem-current-task');
      store.saveUserPrompt(contentSessionId, 1, 'Prompt line one\nprompt line two');

      let result = await renderer.renderBottle(contentSessionId);
      expect(result!.currentTask).toBe('Prompt line one');

      store.storeSummary('mem-current-task', 'test-project', summary({ next_steps: '', request: 'The standing request' }), 1, 0, 1000000000000);
      result = await renderer.renderBottle(contentSessionId);
      expect(result!.currentTask).toBe('The standing request');

      store.storeSummary('mem-current-task', 'test-project', summary({ next_steps: 'Finish phase two' }), 1, 0, 2000000000000);
      result = await renderer.renderBottle(contentSessionId);
      expect(result!.currentTask).toBe('Finish phase two');
    });

    it('treats a fully-private next_steps as absent when computing currentTask', async () => {
      const contentSessionId = 'bottle-current-task-private';
      registerSession(contentSessionId, 'mem-current-task-private');
      store.saveUserPrompt(contentSessionId, 1, 'Latest prompt first line');
      store.storeSummary(
        'mem-current-task-private',
        'test-project',
        summary({ next_steps: '<private>secret next step</private>', request: 'Fallback request' }),
        1,
        0,
        1000000000000
      );

      let result = await renderer.renderBottle(contentSessionId);
      expect(result!.currentTask).toBe('Fallback request');

      store.storeSummary(
        'mem-current-task-private',
        'test-project',
        summary({ next_steps: '<private>secret</private>', request: '<private>also secret</private>' }),
        1,
        0,
        2000000000000
      );
      result = await renderer.renderBottle(contentSessionId);
      expect(result!.currentTask).toBe('Latest prompt first line');
    });
  });

  describe('nothing to render', () => {
    it('returns null and writes no file when neither transcript nor stored rows exist', async () => {
      const contentSessionId = 'bottle-nothing';

      const result = await renderer.renderBottle(contentSessionId);

      expect(result).toBeNull();
      expect(existsSync(path.join(BOTTLES_DIR, `${contentSessionId}.md`))).toBe(false);
    });

    it('returns null when only the cwd convention path is available and no such transcript exists', async () => {
      const contentSessionId = 'bottle-nothing-cwd';

      const result = await renderer.renderBottle(contentSessionId, undefined, '/nonexistent/claude-mem.bottle-test');

      expect(result).toBeNull();
      expect(existsSync(path.join(BOTTLES_DIR, `${contentSessionId}.md`))).toBe(false);
    });
  });

  describe('idempotency', () => {
    it('two consecutive renders produce identical content (modulo rendered timestamp) with no .tmp residue (spec test 6)', async () => {
      const contentSessionId = 'bottle-idempotent';
      registerSession(contentSessionId, 'mem-idempotent');
      store.saveUserPrompt(contentSessionId, 1, 'Render me twice');
      store.storeObservation('mem-idempotent', 'test-project', obs(), 1, 0, 1000000000000);

      const normalizeRenderedTimestamp = (bottle: string) =>
        bottle.replace(/rendered: [^\n·]+/, 'rendered: <normalized>');

      const firstResult = await renderer.renderBottle(contentSessionId);
      const firstBottle = readFileSync(firstResult!.bottlePath, 'utf-8');
      const secondResult = await renderer.renderBottle(contentSessionId);
      const secondBottle = readFileSync(secondResult!.bottlePath, 'utf-8');

      expect(secondResult!.bottlePath).toBe(firstResult!.bottlePath);
      expect(secondResult!.mode).toBe(firstResult!.mode);
      expect(secondResult!.currentTask).toBe(firstResult!.currentTask);
      expect(normalizeRenderedTimestamp(secondBottle)).toBe(normalizeRenderedTimestamp(firstBottle));

      const residue = readdirSync(BOTTLES_DIR).filter((name) => name.endsWith('.tmp'));
      expect(residue).toEqual([]);
    });
  });
});
