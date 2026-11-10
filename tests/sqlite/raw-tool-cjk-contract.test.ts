import { expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../src/services/sqlite/SessionSearch.js';
import { configureToolUseIndex, searchToolUses } from '../../src/services/sqlite/tool-use-search.js';
import { MemoryItemsRepository } from '../../src/storage/sqlite/memory-items.js';
import { ProjectsRepository } from '../../src/storage/sqlite/projects.js';

const cases = [
  ['Han', '修改了项目配置', '项目'],
  ['supplementary Han', '𠮷野家の記録', '𠮷野'],
  ['Japanese', '設定を変更しました', '変更'],
  ['halfwidth Katakana', 'ﾒﾓﾘ設定', 'ﾒﾓﾘ'],
  ['Katakana extensions', 'アイヌㇰ語', 'ㇰ'],
  ['Korean', '설정을변경했습니다', '설정'],
  ['Thai', 'ทดสอบภาษาไทย', 'ภาษาไทย'],
  ['mixed separated terms', 'worker 修改了连接池配置', 'worker 连接池'],
  ['mixed case', 'API設定', 'api設定'],
  ['missing conjunct', 'worker 修改了连接池配置', 'missing 连接池'],
  ['literal underscore', '数据库连接池', '数据_池'],
] as const;

function fixture(text: string) {
  const store = new SessionStore(':memory:'); const server = new Database(':memory:');
  const observations = new SessionSearch(store.db);
  const memories = new MemoryItemsRepository(server); const projects = new ProjectsRepository(server);
  const project = projects.create({ name: 'app' }); const other = projects.create({ name: 'other' });
  for (const scope of ['app', 'other']) {
    const session = store.createSDKSession(scope, scope, 'fixture');
    store.ensureMemorySessionIdRegistered(session, scope);
    store.storeObservation(scope, scope, { type: 'discovery', title: 'record', subtitle: null, narrative: text,
      facts: [], concepts: [], files_read: [], files_modified: [] }, 1);
    store.upsertToolUse({ toolUseId: scope, contentSessionId: scope, project: scope, toolName: 'Read', toolResponse: text });
    memories.create({ projectId: scope === 'app' ? project.id : other.id, kind: 'manual', type: 'note', text });
  }
  configureToolUseIndex(store.db, true);
  return { close() { store.close(); server.close(); }, find(query: string) {
    return {
      observation: observations.searchObservations(query, { project: 'app' }).length,
      raw: searchToolUses(store.db, query, { project: 'app' }).toolUses.length,
      serverMemory: memories.search(project.id, query).length,
    };
  } };
}

for (const [name, text, query] of cases) {
  it(`matches worker observation/raw and server SQLite memory for ${name}`, () => {
    const f = fixture(text);
    try {
      const result = f.find(query);
      const expected = ['missing conjunct', 'literal percent', 'literal underscore'].includes(name) ? 0 : 1;
      expect(result).toEqual({ observation: expected, raw: expected, serverMemory: expected });
    } finally { f.close(); }
  });
}

it.each([['项目 配置', '项目+配置'], ['数据库连接池', '数据%池']])('records existing server punctuation differences for %s / %s', (body, query) => {
  const f = fixture(body);
  try {
    // Server tokenizes '+', while the worker preserves it in its substring AND.
    // This is also an observation-vs-server difference on main, not a new raw contract.
    expect(f.find(query)).toEqual({ observation: 0, raw: 0, serverMemory: 1 });
  } finally { f.close(); }
});
