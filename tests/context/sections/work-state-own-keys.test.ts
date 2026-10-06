import { expect, it } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import {
  foldWorkStateList,
  renderWorkStateLines,
} from '../../../src/services/context/sections/WorkStateRenderer.js';
it('retains prototype-named fields through SQLite replay and rendering', () => {
  const store = new SessionStore(':memory:');
  try {
    store.appendWorkStateEntry({
      project: 'app',
      listName: 'config',
      fields: JSON.parse('{"__proto__":"first","constructor":"ok"}'),
    });
    store.appendWorkStateEntry({
      project: 'app',
      listName: 'config',
      fields: JSON.parse('{"__proto__":"latest"}'),
    });
    const rows = store.getWorkStateEntries(['app']);
    const folded = foldWorkStateList(rows);
    expect(Object.hasOwn(folded.state, '__proto__')).toBe(true);
    expect(folded.state.__proto__).toBe('latest');
    expect(Object.getPrototypeOf(folded.state)).toBe(Object.prototype);
    expect(renderWorkStateLines(rows, Date.now(), true).join('\n')).toContain('__proto__=latest');
    store.appendWorkStateEntry({
      project: 'app',
      listName: 'config',
      fields: JSON.parse('{"__proto__":null}'),
    });
    expect(
      renderWorkStateLines(store.getWorkStateEntries(['app']), Date.now(), true).join('\n')
    ).not.toContain('__proto__=');
  } finally {
    store.close();
  }
});
