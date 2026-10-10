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
