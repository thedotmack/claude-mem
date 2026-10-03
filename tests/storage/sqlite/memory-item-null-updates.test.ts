import { describe, it, expect, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ProjectsRepository } from '../../../src/storage/sqlite/projects.js';
import { ServerV1Routes } from '../../../src/server/routes/v1/ServerV1Routes.js';
import { CreateMemoryItemSchema, UpdateMemoryItemSchema } from '../../../src/core/schemas/memory-item.js';
import { ServerSessionsRepository } from '../../../src/storage/sqlite/server-sessions.js';
import { MemoryItemsRepository } from '../../../src/storage/sqlite/memory-items.js';

describe('nullable memory item updates', () => {
  let db: Database;
  afterEach(() => { db?.close(); });
  it('clears populated nullable text fields when explicitly passed null', () => {
    db = new Database(':memory:');
    const project = new ProjectsRepository(db).create({ name: 'project' });
    const repo = new MemoryItemsRepository(db);
    const item = repo.create({ projectId: project.id, kind: 'manual', type: 'note', title: 'old title', subtitle: 'old subtitle', text: 'old text', narrative: 'old narrative' });
    const updated = repo.update(item.id, UpdateMemoryItemSchema.parse({ title: null, subtitle: null, text: null, narrative: null }));
    expect(updated).toMatchObject({ title: null, subtitle: null, text: null, narrative: null });
    expect(repo.getById(item.id)).toMatchObject({ title: null, subtitle: null, text: null, narrative: null });
  });
  it('clears session and legacy-observation links without deleting either record', () => {
    db = new Database(':memory:');
    const project = new ProjectsRepository(db).create({ name: 'project' });
    const sessions = new ServerSessionsRepository(db);
    const session = sessions.create({ projectId: project.id });
    const repo = new MemoryItemsRepository(db);
    const item = repo.create({ projectId: project.id, kind: 'manual', type: 'note', serverSessionId: session.id, legacyObservationId: 42 });
    expect(repo.update(item.id, UpdateMemoryItemSchema.parse({ serverSessionId: null, legacyObservationId: null }))).toMatchObject({ serverSessionId: null, legacyObservationId: null });
    expect(sessions.getById(session.id)?.id).toBe(session.id);
  });
  it('preserves every omitted field through the actual public PATCH schema', () => {
    db = new Database(':memory:');
    const project = new ProjectsRepository(db).create({ name: 'project' });
    const sessions = new ServerSessionsRepository(db);
    const session = sessions.create({ projectId: project.id });
    const repo = new MemoryItemsRepository(db);
    const item = repo.create({ projectId: project.id, kind: 'manual', type: 'note', title: 'old', subtitle: 'keep subtitle', text: 'keep text', narrative: 'keep narrative', serverSessionId: session.id, legacyObservationId: 42, facts: ['fact'], concepts: ['concept'], filesRead: ['a.ts'], filesModified: ['b.ts'], metadata: { source: 'manual' } });
    const patch = UpdateMemoryItemSchema.parse({ title: 'new' });
    expect(patch).toEqual({ title: 'new' });
    expect(repo.update(item.id, patch)).toMatchObject({ ...item, title: 'new', updatedAtEpoch: expect.any(Number) });
  });
  it('wires the omission-preserving schema into the registered PATCH handler', () => {
    db = new Database(':memory:');
    const project = new ProjectsRepository(db).create({ name: 'project' });
    const repo = new MemoryItemsRepository(db);
    const item = repo.create({ projectId: project.id, kind: 'manual', type: 'note', title: 'old', narrative: 'keep', facts: ['fact'], metadata: { source: 'manual' } });
    let patchHandler: any;
    const app = { get() {}, post() {}, patch(path: string, ...handlers: any[]) { if (path === '/v1/memories/:id') patchHandler = handlers.at(-1); } };
    new ServerV1Routes({ getDatabase: () => db }).setupRoutes(app as any);
    let response: any;
    const res = { json(value: unknown) { response = value; }, status() { return this; } };
    patchHandler({ params: { id: item.id }, body: { title: 'new' } }, res);
    expect(response.memory).toMatchObject({ title: 'new', narrative: 'keep', facts: ['fact'], metadata: { source: 'manual' } });
    patchHandler({ params: { id: item.id }, body: { narrative: null } }, res);
    expect(response.memory).toMatchObject({ title: 'new', narrative: null, facts: ['fact'], metadata: { source: 'manual' } });
  });
  it('rejects clearing the last searchable field and keeps the record searchable', () => {
    db = new Database(':memory:');
    const project = new ProjectsRepository(db).create({ name: 'project' });
    const handlers = new Map<string, any>();
    const app = { get() {}, post(path: string, ...callbacks: any[]) { handlers.set(path, callbacks.at(-1)); }, patch(path: string, ...callbacks: any[]) { handlers.set(path, callbacks.at(-1)); } };
    new ServerV1Routes({ getDatabase: () => db }).setupRoutes(app as any);
    let status: number; let response: any;
    const res = { json(value: unknown) { response = value; }, status(value: number) { status = value; return this; } };
    for (const field of ['title', 'subtitle', 'text', 'narrative', 'facts', 'concepts']) {
      handlers.get('/v1/memories')({ body: { projectId: project.id, kind: 'manual', type: 'note', [field]: field === 'facts' || field === 'concepts' ? ['searchabletoken'] : 'searchabletoken' } }, res);
      expect(status!).toBe(201);
      const id = response.memory.id;
      status = 200;
      handlers.get('/v1/memories/:id')({ params: { id }, body: { [field]: field === 'facts' || field === 'concepts' ? [] : null } }, res);
      expect(status).toBe(400);
      expect(response.error).toBe('ValidationError');
      handlers.get('/v1/search')({ body: { projectId: project.id, query: 'searchabletoken' } }, res);
      expect(response.memories.some((memory: { id: string }) => memory.id === id)).toBe(true);
    }
  });
  it('retains creation defaults and PATCH validation', () => {
    expect(CreateMemoryItemSchema.parse({ projectId: 'project', kind: 'manual', type: 'note' })).toMatchObject({ title: null, facts: [], metadata: {} });
    expect(() => UpdateMemoryItemSchema.parse({ title: '' })).toThrow();
    expect(() => UpdateMemoryItemSchema.parse({ facts: null })).toThrow();
  });
  it('preserves omitted fields and accepts empty text and new titles', () => {
    db = new Database(':memory:');
    const project = new ProjectsRepository(db).create({ name: 'project' });
    const repo = new MemoryItemsRepository(db);
    const item = repo.create({ projectId: project.id, kind: 'manual', type: 'note', title: 'old', narrative: 'keep', metadata: { source: 'manual' } });
    expect(repo.update(item.id, { title: 'new', text: '' })).toMatchObject({ title: 'new', text: '', narrative: 'keep', metadata: { source: 'manual' } });
    expect(repo.update('missing', { title: null })).toBeNull();
  });
});
