import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { MemoryItemsRepository } from '../../../src/storage/sqlite/memory-items.js';
import { ProjectsRepository } from '../../../src/storage/sqlite/projects.js';

test.each(['mā\u0301laga', 'sam\u0310skṛta', 'x\u0304mean'])('finds an indexed word containing combining marks: %s', text => {
  const db = new Database(':memory:');
  try {
    const projects = new ProjectsRepository(db);
    const project = projects.create({ name: 'Combining marks' });
    const other = projects.create({ name: 'Other' });
    const repo = new MemoryItemsRepository(db);
    const item = repo.create({ projectId: project.id, kind: 'manual', type: 'note', text: `Recorded ${text} result` });
    repo.create({ projectId: other.id, kind: 'manual', type: 'note', text });
    repo.create({ projectId: project.id, kind: 'manual', type: 'note', text: `Recorded ${text.replace(/\p{M}+/gu, ' unrelated ')} result` });

    expect(repo.search(project.id, text).map(row => row.id)).toEqual([item.id]);
    expect(repo.search(project.id, `${text} result`).map(row => row.id)).toEqual([item.id]);
    expect(repo.search(project.id, `${text} absent`)).toEqual([]);
  } finally { db.close(); }
});
