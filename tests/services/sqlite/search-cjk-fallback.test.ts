import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';

// FTS5's unicode61 tokenizer has no delimiter to split CJK on, so an entire run of
// ideographs folds into ONE token and no substring of it can ever match (#3801).
// Queries in those scripts are answered by substring, the way searchUserPrompts
// has always answered every query.
describe('search in scripts FTS5 cannot segment', () => {
  let store: SessionStore;
  let search: SessionSearch;

  function seedObservation(sessionId: string, project: string, title: string, narrative: string): void {
    const sdkId = store.createSDKSession(sessionId, project, 'prompt');
    store.ensureMemorySessionIdRegistered(sdkId, `${sessionId}-mem`);
    store.storeObservation(`${sessionId}-mem`, project, {
      type: 'discovery',
      title,
      subtitle: null,
      facts: [],
      narrative,
      concepts: [],
      files_read: [],
      files_modified: [],
    }, 1);
  }

  function seedSummary(memorySessionId: string, project: string, request: string): void {
    const sdkId = store.createSDKSession(`${memorySessionId}-raw`, project, 'prompt');
    store.ensureMemorySessionIdRegistered(sdkId, memorySessionId);
    store.importSessionSummary({
      memory_session_id: memorySessionId,
      project,
      request,
      investigated: null,
      learned: null,
      completed: null,
      next_steps: null,
      files_read: null,
      files_edited: null,
      notes: null,
      prompt_number: 1,
      discovery_tokens: 0,
      created_at: new Date(1_700_000_000_000).toISOString(),
      created_at_epoch: 1_700_000_000_000,
    });
  }

  beforeEach(() => {
    store = new SessionStore(':memory:');
    search = new SessionSearch(store.db);
    seedObservation('cjk-1', 'cjk-project', '用户身份验证流程', '这是关于用户身份的观察记录');
    seedObservation('cjk-2', 'cjk-project', '数据库连接池配置', '调整数据库连接池的大小');
    seedObservation('jp-1', 'cjk-project', 'ユーザー認証の設計', 'ユーザー認証をやり直した');
    seedObservation('ko-1', 'cjk-project', '프로젝트 설정을 변경했습니다', '설정을 바꾼 기록');
    seedObservation('bpmf-1', 'cjk-project', 'ㄓㄨㄛ ㄖㄣ ㄊㄢ', 'ㄓㄨㄛ 的紀錄');
    seedObservation('en-1', 'cjk-project', 'Database Path resolution', 'the database path is resolved at startup');
    seedObservation('other-1', 'other-project', '用户身份验证流程', '另一个项目里的同名观察');
    seedSummary('sum-cjk', 'cjk-project', '重构用户身份验证的会话');
    seedSummary('sum-en', 'cjk-project', 'refactor the database path');
  });

  afterEach(() => {
    store.close();
  });

  it('finds a Chinese keyword that appears inside a longer run', () => {
    const results = search.searchObservations('用户身份', { project: 'cjk-project' });
    expect(results.map(r => r.title)).toEqual(['用户身份验证流程']);
  });

  it('finds a two-character Chinese keyword, which a trigram index could not', () => {
    const results = search.searchObservations('数据', { project: 'cjk-project' });
    expect(results.map(r => r.title)).toEqual(['数据库连接池配置']);
  });

  it('finds Japanese, which has no word delimiter either', () => {
    const results = search.searchObservations('ユーザー認証', { project: 'cjk-project' });
    expect(results.map(r => r.title)).toEqual(['ユーザー認証の設計']);
  });

  // Korean spaces its words, so only the sub-word case breaks — but that case is every
  // partial-word query. Against tokenize='unicode61', 설정 inside 설정을 returns 0 rows
  // while the whole token 설정을 returns 1, which is the tokenizer folding the run.
  it('finds a Korean keyword inside a word, which the tokenizer folds', () => {
    const results = search.searchObservations('설정', { project: 'cjk-project' });
    expect(results.map(r => r.title)).toEqual(['프로젝트 설정을 변경했습니다']);
  });

  // Bopomofo has no delimiters at all, the same as the ideographs.
  it('finds a Bopomofo keyword inside a longer run', () => {
    const results = search.searchObservations('ㄓㄨ', { project: 'cjk-project' });
    expect(results.map(r => r.title)).toEqual(['ㄓㄨㄛ ㄖㄣ ㄊㄢ']);
  });

  it('searches session summaries the same way', () => {
    const results = search.searchSessions('用户身份', { project: 'cjk-project' });
    expect(results.map(r => r.request)).toEqual(['重构用户身份验证的会话']);
  });

  it('still applies the project filter on this path', () => {
    expect(search.searchObservations('用户身份', { project: 'other-project' }).map(r => r.memory_session_id))
      .toEqual(['other-1-mem']);
    expect(search.searchObservations('用户身份', {}).length).toBe(2);
  });

  it('still applies the type filter on this path', () => {
    expect(search.searchObservations('用户身份', { project: 'cjk-project', type: 'discovery' }).length).toBe(1);
    expect(search.searchObservations('用户身份', { project: 'cjk-project', type: 'decision' }).length).toBe(0);
  });

  it('treats LIKE wildcards in the query as literal characters', () => {
    expect(search.searchObservations('用户%验证', { project: 'cjk-project' })).toEqual([]);
    expect(search.searchObservations('用户_验证', { project: 'cjk-project' })).toEqual([]);
  });

  it('does not widen an English query that FTS5 already answers', () => {
    const results = search.searchObservations('Database Path', { project: 'cjk-project' });
    expect(results.map(r => r.title)).toEqual(['Database Path resolution']);
    expect(search.searchSessions('database path', { project: 'cjk-project' }).map(r => r.request))
      .toEqual(['refactor the database path']);
  });
});
