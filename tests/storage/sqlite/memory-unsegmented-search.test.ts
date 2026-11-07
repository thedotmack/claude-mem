import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { MemoryItemsRepository } from '../../../src/storage/sqlite/memory-items.js';
import { ProjectsRepository } from '../../../src/storage/sqlite/projects.js';

describe('server memory search for unsegmented scripts', () => {
  it('finds terms inside Chinese, Japanese, Korean and Thai runs', () => {
    const db = new Database(':memory:');
    try {
      const project = new ProjectsRepository(db).create({ name: 'Search' });
      const memories = new MemoryItemsRepository(db);
      for (const [text, term] of [['修改了项目配置', '项目'], ['設定を変更しました', '変更'], ['설정을변경했습니다', '설정'], ['ทดสอบภาษาไทย', 'ภาษาไทย']]) {
        const item = memories.create({ projectId: project.id, kind: 'manual', type: 'note', text });
        expect(memories.search(project.id, term).map(row => row.id)).toContain(item.id);
      }
    } finally { db.close(); }
  });

  it('keeps Latin terms conjunctive and filters before applying the limit', () => {
    const db = new Database(':memory:');
    try {
      const projects = new ProjectsRepository(db);
      const project = projects.create({ name: 'Search' });
      const other = projects.create({ name: 'Other' });
      const memories = new MemoryItemsRepository(db);
      const match = memories.create({ projectId: project.id, kind: 'manual', type: 'note', text: '修改了项目配置 database migration' });
      memories.create({ projectId: project.id, kind: 'manual', type: 'note', text: '修改了项目配置 unrelated' });
      memories.create({ projectId: other.id, kind: 'manual', type: 'note', text: '修改了项目配置 database migration' });
      expect(memories.search(project.id, '项目 database', 1).map(row => row.id)).toEqual([match.id]);
      expect(memories.search(project.id, '项目 missing')).toEqual([]);
      const mixed = memories.create({ projectId: project.id, kind: 'manual', type: 'note', text: '中文Database更新' });
      expect(memories.search(project.id, '中文DATABASE').map(row => row.id)).toEqual([mixed.id]);
      expect(memories.search(project.id, '项目 migration database').map(row => row.id)).toEqual([match.id]);
    } finally { db.close(); }
  });
});

describe('unsegmented search review regressions', () => {
  it.each([['API設定', 'api設定'], ['项目 配置', '项目+配置'], ['ﾌﾟﾛｼﾞｪｸﾄ設定', 'ﾌﾟﾛｼﾞｪｸﾄ'], ['𠀀𠀁𠀂', '𠀁'], ['설정변경', '정']])('retains matches for %s queried with %s', (text, query) => {
    const db = new Database(':memory:');
    try {
      const project = new ProjectsRepository(db).create({ name: 'Regression' });
      const repo = new MemoryItemsRepository(db);
      const item = repo.create({ projectId: project.id, kind: 'manual', type: 'note', text });
      expect(repo.search(project.id, query).map(row => row.id)).toEqual([item.id]);
    } finally { db.close(); }
  });

  it('deduplicates repeated terms before generating SQLite expressions', () => {
    const db = new Database(':memory:');
    try {
      const project = new ProjectsRepository(db).create({ name: 'Repeated' });
      const repo = new MemoryItemsRepository(db);
      const item = repo.create({ projectId: project.id, kind: 'manual', type: 'note', text: '修改了项目配置' });
      expect(repo.search(project.id, Array(1000).fill('项目').join(' ')).map(row => row.id)).toEqual([item.id]);
    } finally { db.close(); }
  });

  it('accepts the exact distinct-term boundary in native SQLite', () => {
    const db = new Database(':memory:');
    try {
      const project = new ProjectsRepository(db).create({ name: 'Boundary' });
      const repo = new MemoryItemsRepository(db);
      const text = Array.from({ length: 64 }, (_, i) => `项目${i}`).join(' ');
      const item = repo.create({ projectId: project.id, kind: 'manual', type: 'note', text });
      expect(repo.search(project.id, text).map(row => row.id)).toEqual([item.id]);
    } finally { db.close(); }
  });

  it('rejects too many distinct terms before preparing SQL', () => {
    const db = new Database(':memory:');
    try {
      const project = new ProjectsRepository(db).create({ name: 'Bounded' });
      const repo = new MemoryItemsRepository(db);
      expect(() => repo.search(project.id, Array.from({ length: 65 }, (_, i) => `项目${i}`).join(' '))).toThrow('64 distinct terms');
    } finally { db.close(); }
  });

  it('keeps script FTS alternatives conjunctive with each other and Latin terms', () => {
    const db = new Database(':memory:');
    try {
      const projects = new ProjectsRepository(db);
      const project = projects.create({ name: 'Conjunction' });
      const other = projects.create({ name: 'Other' });
      const repo = new MemoryItemsRepository(db);
      const match = repo.create({ projectId: project.id, kind: 'manual', type: 'note', text: '项目 配置 API設定 database' });
      repo.create({ projectId: project.id, kind: 'manual', type: 'note', text: '项目 API設定 database' });
      repo.create({ projectId: other.id, kind: 'manual', type: 'note', text: '项目 配置 API設定 database' });
      expect(repo.search(project.id, '项目+配置 api設定 database', 1).map(row => row.id)).toEqual([match.id]);
      expect(repo.search(project.id, '项目+配置 absent')).toEqual([]);
      expect(repo.search(project.id, '项目%不存在')).toEqual([]);
      expect(repo.search(project.id, '项目_不存在')).toEqual([]);
    } finally { db.close(); }
  });
});
