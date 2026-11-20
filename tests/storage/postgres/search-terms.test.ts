// SPDX-License-Identifier: Apache-2.0
//
// Pure unit tests for the PostgreSQL keyword search terms behind #3982: a term
// in a script unicode61/to_tsvector cannot segment matches by literal
// substring, the contract the server SQLite read has. No database needed.

import { describe, expect, it } from 'bun:test';
import {
  buildSubstringSearchSql,
  searchQueryTerms,
  type PostgresSearchTerm,
} from '../../../src/storage/postgres/observations.js';

describe('postgres keyword search terms', () => {
  it('splits a plain ASCII query into word terms', () => {
    expect(searchQueryTerms('restore snapshots require tables')).toEqual([
      { literal: 'restore', words: 'restore', substring: false },
      { literal: 'snapshots', words: 'snapshots', substring: false },
      { literal: 'require', words: 'require', substring: false },
      { literal: 'tables', words: 'tables', substring: false },
    ]);
  });

  it('marks CJK, kana, Hangul, Thai, Khmer and Bopomofo runs as substring terms', () => {
    for (const query of ['修改了连接池配置', '設定を変更しました', '설정을변경했습니다', 'การตั้งค่า', 'ការកំណត់']) {
      expect(searchQueryTerms(query)).toEqual([
        { literal: query, words: query, substring: true },
      ]);
    }
    expect(searchQueryTerms('worker 连接池')).toEqual([
      { literal: 'worker', words: 'worker', substring: false },
      { literal: '连接池', words: '连接池', substring: true },
    ]);
  });

  it('treats decomposed Korean jamo as an unsegmented run', () => {
    // NFD 정: U+110C U+1165 U+11BC, the form a decomposed Korean write produces.
    const jamo = '\u110C\u1165\u11BC';
    expect(searchQueryTerms(jamo)).toEqual([
      { literal: jamo, words: jamo, substring: true },
    ]);
  });

  it('splits on punctuation, keeps underscore inside a term, and deduplicates', () => {
    expect(searchQueryTerms('retry retry -gateway "header font"').map(term => term.literal)).toEqual([
      'retry',
      'gateway',
      'header',
      'font',
    ]);
    const [term] = searchQueryTerms('設定_変更');
    expect(term).toEqual({ literal: '設定_変更', words: '設定_変更', substring: true });
  });

  it('classifies symbol runs that hold no word characters', () => {
    expect(searchQueryTerms('$100 ++ 設定')).toEqual([
      { literal: '$100', words: '100', substring: false },
      { literal: '++', words: '', substring: false },
      { literal: '設定', words: '設定', substring: true },
    ]);
  });

  it('builds ANDed groups with bound parameters, a script term matching by substring or tsquery', () => {
    const { predicate, params } = buildSubstringSearchSql(searchQueryTerms('worker 設定'), 11);
    expect(params).toEqual(['worker', '%設定%', '設定']);
    expect(predicate).toBe(
      "((numnode(websearch_to_tsquery('english', $11)) = 0 OR "
      + "observations.content_search @@ websearch_to_tsquery('english', $11))) AND "
      + "(observations.content ILIKE $12 ESCAPE '\\' OR "
      + "observations.content_search @@ websearch_to_tsquery('english', $13))",
    );
  });

  it('escapes backslash, percent and underscore in the substring pattern', () => {
    const term: PostgresSearchTerm = { literal: '50%_a\\b', words: '', substring: true };
    const { predicate, params } = buildSubstringSearchSql([term], 3);
    expect(params).toEqual(['%50\\%\\_a\\\\b%']);
    expect(predicate).toBe("(observations.content ILIKE $3 ESCAPE '\\')");
  });

  it('drops a term that is only punctuation, as websearch_to_tsquery does', () => {
    const { predicate, params } = buildSubstringSearchSql(searchQueryTerms('++ 設定'), 11);
    expect(params).toEqual(['%設定%', '設定']);
    expect(predicate).toBe(
      "(observations.content ILIKE $11 ESCAPE '\\' OR "
      + "observations.content_search @@ websearch_to_tsquery('english', $12))",
    );
  });
});
