import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../src/services/sqlite/SessionSearch.js';
import { SearchManager } from '../../src/services/worker/SearchManager.js';
import { FormattingService } from '../../src/services/worker/FormattingService.js';
import { TimelineService } from '../../src/services/worker/TimelineService.js';

const PROJECT = 'mixed-timeline';
const EPOCH = Date.UTC(2026, 10, 1);

describe('timeline context outside observation history', () => {
  let store: SessionStore;
  let manager: SearchManager;
  let sequence: number;

  function session(project = PROJECT, platform = 'claude') {
    const content = `content-${++sequence}`;
    const memory = `memory-${sequence}`;
    const id = store.createSDKSession(content, project, 'Initial request', undefined, platform);
    store.ensureMemorySessionIdRegistered(id, memory);
    return { content, memory, id, project };
  }

  function prompt(owner: ReturnType<typeof session>, label: string, offset: number) {
    return store.saveUserPrompt(owner.content, ++sequence, label, owner.id, undefined, undefined, EPOCH + offset);
  }

  function summary(owner: ReturnType<typeof session>, label: string, offset: number) {
    return store.storeSummary(owner.memory, owner.project, {
      request: label, investigated: '', learned: '', completed: '', next_steps: '', notes: null,
    }, 1, 0, EPOCH + offset).id;
  }

  async function timeline(anchor: string | number, extra: Record<string, unknown> = {}) {
    const result = await manager.timeline({ anchor, project: PROJECT, depth_before: 1, depth_after: 1, ...extra });
    expect(result.isError).not.toBe(true);
    return result.content[0].text as string;
  }

  beforeEach(() => {
    ModeManager.getInstance().loadMode('code');
    store = new SessionStore(':memory:');
    manager = new SearchManager(new SessionSearch(store.db), store, null, new FormattingService(), new TimelineService());
    sequence = 0;
  });

  afterEach(() => store.close());

  it('includes nearby prompts and summaries around a summary when no observations exist', async () => {
    const owner = session();
    prompt(owner, 'FarEarlierPrompt', 1000);
    prompt(owner, 'NearestEarlierPrompt', 2000);
    const anchor = summary(owner, 'AnchorSummary', 3000);
    summary(owner, 'NearestLaterSummary', 4000);
    prompt(owner, 'FarLaterPrompt', 5000);
    const body = await timeline(`S${anchor}`);
    expect(body).toContain('NearestEarlierPrompt');
    expect(body).toContain('AnchorSummary');
    expect(body).toContain('NearestLaterSummary');
    expect(body).not.toContain('FarEarlierPrompt');
    expect(body).not.toContain('FarLaterPrompt');
    expect(body).toContain('**Items:** 3');
  });

  it('returns the requested neighbors around a timestamp in prompt-only history', async () => {
    const owner = session();
    for (const offset of [1000, 2000, 4000, 5000]) prompt(owner, `PromptAt${offset}`, offset);
    const body = await timeline(new Date(EPOCH + 3000).toISOString());
    expect(body).toContain('PromptAt2000');
    expect(body).toContain('PromptAt4000');
    expect(body).not.toContain('PromptAt1000');
    expect(body).not.toContain('PromptAt5000');
    expect(body).toContain('**Items:** 2');
  });

  it('includes records before the first and after the last observation', async () => {
    const owner = session();
    prompt(owner, 'PromptBeforeObservation', 2000);
    const anchor = store.storeObservation(owner.memory, owner.project, {
      type: 'discovery', title: 'OnlyObservation', subtitle: null, narrative: null,
      facts: [], concepts: [], files_read: [], files_modified: [],
    }, 1, 0, EPOCH + 3000).id;
    summary(owner, 'SummaryAfterObservation', 4000);
    const body = await timeline(anchor);
    expect(body).toContain('PromptBeforeObservation');
    expect(body).toContain('OnlyObservation');
    expect(body).toContain('SummaryAfterObservation');
    expect(body).toContain('**Items:** 3');
  });

  it('applies project and platform scope to non-observation boundaries', async () => {
    const owner = session(PROJECT, 'codex');
    prompt(owner, 'ScopedEarlierPrompt', 1000);
    summary(owner, 'ScopedLaterSummary', 5000);
    const otherProject = session('unrelated-project', 'codex');
    prompt(otherProject, 'ForeignProjectPrompt', 2000);
    summary(otherProject, 'ForeignProjectSummary', 4000);
    const otherPlatform = session(PROJECT, 'claude');
    prompt(otherPlatform, 'ForeignPlatformPrompt', 2500);
    summary(otherPlatform, 'ForeignPlatformSummary', 3500);
    const body = await timeline(new Date(EPOCH + 3000).toISOString(), { platformSource: 'codex' });
    expect(body).toContain('ScopedEarlierPrompt');
    expect(body).toContain('ScopedLaterSummary');
    expect(body).not.toContain('Foreign');
    expect(body).toContain('**Items:** 2');
  });

  it('keeps the exact-epoch group with zero depth', async () => {
    const owner = session();
    prompt(owner, 'EarlierPrompt', 2000);
    const anchor = summary(owner, 'TiedSummary', 3000);
    prompt(owner, 'TiedPrompt', 3000);
    summary(owner, 'LaterSummary', 4000);
    const body = await timeline(`S${anchor}`, { depth_before: 0, depth_after: 0 });
    expect(body).toContain('TiedSummary');
    expect(body).toContain('TiedPrompt');
    expect(body).not.toContain('EarlierPrompt');
    expect(body).not.toContain('LaterSummary');
    expect(body).toContain('**Items:** 2');
  });
});
