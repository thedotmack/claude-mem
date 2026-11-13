import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { OBSERVER_SESSIONS_PROJECT } from '../../src/shared/paths.js';

describe('project catalog source deduplication', () => {
  let store: SessionStore;
  let sequence: number;
  beforeEach(() => { store = new SessionStore(':memory:'); sequence = 0; });
  afterEach(() => store.close());

  function row(project: string, source: string, epoch: number) {
    const id = store.createSDKSession(`catalog-${++sequence}`, project, 'request', undefined, source);
    // Historical rows can contain source aliases; the catalog normalizes them.
    store.db.run('UPDATE sdk_sessions SET platform_source = ?, started_at_epoch = ? WHERE id = ?', [source, epoch, id]);
  }

  it('collapses source aliases while retaining the most recently seen project order', () => {
    row('shared', 'claude-code', 1);
    row('older', 'CLAUDE CODE', 5);
    row('shared', 'claude', 8);
    row('latest', 'claude-code', 9);
    expect(store.getProjectCatalog()).toEqual({ projects: ['latest', 'shared', 'older'], sources: ['claude'],
      projectsBySource: { claude: ['latest', 'shared', 'older'] } });
  });

  it('keeps literal project case and each platform membership', () => {
    row('App', 'claude', 3);
    row('app', 'claude-code', 2);
    row('App', 'codex', 1);
    expect(store.getProjectCatalog()).toEqual({ projects: ['App', 'app'], sources: ['claude', 'codex'],
      projectsBySource: { claude: ['App', 'app'], codex: ['App'] } });
  });

  it('supports prototype-named sources and projects as literal catalog keys', () => {
    row('__proto__', '__proto__', 3);
    row('constructor', '__proto__', 2);
    row('__proto__', 'constructor', 1);
    const catalog = store.getProjectCatalog();
    expect(catalog.projects).toEqual(['__proto__', 'constructor']);
    expect(catalog.sources).toEqual(['__proto__', 'constructor']);
    expect(Object.hasOwn(catalog.projectsBySource, '__proto__')).toBe(true);
    expect(catalog.projectsBySource.__proto__).toEqual(['__proto__', 'constructor']);
    expect(catalog.projectsBySource.constructor).toEqual(['__proto__']);
  });

  it('keeps empty and observer-only projects out of an otherwise empty catalog', () => {
    row('', 'claude', 1);
    row(OBSERVER_SESSIONS_PROJECT, 'codex', 2);
    expect(store.getProjectCatalog()).toEqual({ projects: [], sources: [], projectsBySource: {} });
  });
});
