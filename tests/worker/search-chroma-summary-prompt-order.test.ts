import { describe, expect, it } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../src/services/sqlite/SessionSearch.js';
import { SearchManager } from '../../src/services/worker/SearchManager.js';
import { FormattingService } from '../../src/services/worker/FormattingService.js';
import { TimelineService } from '../../src/services/worker/TimelineService.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function chromaRanking(ids: number[], docType: string, epochOf: (id: number) => number) {
  return {
    async queryChroma() {
      return {
        ids,
        distances: ids.map((_, i) => i / 10),
        metadatas: ids.map(id => ({ doc_type: docType, created_at_epoch: epochOf(id) })),
      };
    },
  };
}

describe('SearchManager Chroma hydration keeps relevance order for summaries and prompts', () => {
  it('returns the most relevant (older) session summary first', async () => {
    const store = new SessionStore(':memory:');
    const now = Date.now();
    const summary = (n: number, epoch: number, request: string) => {
      const sid = `memory-${n}`;
      store.ensureMemorySessionIdRegistered(store.createSDKSession(`content-${n}`, 'p', 'ask'), sid);
      return store.importSessionSummary({
        memory_session_id: sid, project: 'p', request,
        investigated: null, learned: null, completed: null, next_steps: null, notes: null,
        files_read: null, files_edited: null, prompt_number: 1, discovery_tokens: 0,
        created_at: new Date(epoch).toISOString(), created_at_epoch: epoch,
      }).id;
    };
    const exact = summary(1, now - 10 * DAY_MS, 'fix the retry limit in the queue');
    const newer = [2, 3, 4].map(n => summary(n, now - n * 3_600_000, `unrelated chore ${n}`));
    const ranking = [exact, ...newer];
    const epochOf = (id: number) => (store.getSessionSummariesByIds([id])[0] as any).created_at_epoch;

    const manager = new SearchManager(new SessionSearch(store.db), store, chromaRanking(ranking, 'session_summary', epochOf) as any, new FormattingService(), new TimelineService());

    const top = await manager.search({ query: 'retry limit queue', type: 'sessions', limit: 1, format: 'json' });
    expect(top.sessions.map((s: any) => s.id)).toEqual([exact]);

    const all = await manager.search({ query: 'retry limit queue', type: 'sessions', format: 'json' });
    expect(all.sessions.map((s: any) => s.id)).toEqual(ranking);
  });

  it('returns the most relevant (older) user prompt first', async () => {
    const store = new SessionStore(':memory:');
    store.createSDKSession('content-1', 'p', 'ask');
    const now = Date.now();
    const prompt = (n: number, epoch: number, text: string) => store.importUserPrompt({
      content_session_id: 'content-1', prompt_number: n, prompt_text: text,
      created_at: new Date(epoch).toISOString(), created_at_epoch: epoch,
    }).id;
    const exact = prompt(1, now - 10 * DAY_MS, 'why does the retry limit in the queue reset');
    const newer = [2, 3, 4].map(n => prompt(n, now - n * 3_600_000, `unrelated chore ${n}`));
    const ranking = [exact, ...newer];
    const epochOf = (id: number) => (store.getUserPromptsByIds([id])[0] as any).created_at_epoch;

    const manager = new SearchManager(new SessionSearch(store.db), store, chromaRanking(ranking, 'user_prompt', epochOf) as any, new FormattingService(), new TimelineService());

    const top = await manager.search({ query: 'retry limit queue', type: 'prompts', limit: 1, format: 'json' });
    expect(top.prompts.map((p: any) => p.id)).toEqual([exact]);

    const all = await manager.search({ query: 'retry limit queue', type: 'prompts', format: 'json' });
    expect(all.prompts.map((p: any) => p.id)).toEqual(ranking);
  });
});
