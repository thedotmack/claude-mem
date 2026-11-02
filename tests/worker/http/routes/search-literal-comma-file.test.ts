import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import express from 'express';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../../src/services/sqlite/SessionSearch.js';
import { SearchManager } from '../../../../src/services/worker/SearchManager.js';
import { SearchRoutes } from '../../../../src/services/worker/http/routes/SearchRoutes.js';
import { FormattingService } from '../../../../src/services/worker/FormattingService.js';
import { TimelineService } from '../../../../src/services/worker/TimelineService.js';
import { ModeManager } from '../../../../src/services/domain/ModeManager.js';

let priorMode: unknown;
let priorModeId: unknown;
beforeEach(() => {
  const manager = ModeManager.getInstance();
  priorMode = Reflect.get(manager, 'activeMode');
  priorModeId = Reflect.get(manager, 'activeModeId');
  manager.loadMode('code');
});
afterEach(() => {
  Reflect.set(ModeManager.getInstance(), 'activeMode', priorMode);
  Reflect.set(ModeManager.getInstance(), 'activeModeId', priorModeId);
});

async function requestFile(query: URLSearchParams) {
  const store = new SessionStore(':memory:');
  const seed = (memory: string, title: string, file: string) => {
    const id = store.createSDKSession(`content-${memory}`, 'owned-project', title);
    store.ensureMemorySessionIdRegistered(id, memory);
    store.storeObservation(memory, 'owned-project', {
      type: 'discovery', title, subtitle: null, narrative: title,
      facts: [], concepts: [], files_read: [file], files_modified: [],
    }, 1);
  };
  seed('comma', 'COMMA_PATH_RECORD', 'src/release,final.md');
  seed('prefix', 'PREFIX_PATH_RECORD', 'src/release');
  const manager = new SearchManager(
    new SessionSearch(store.db), store, null, new FormattingService(), new TimelineService(),
  );
  const app = express();
  new SearchRoutes(manager).setupRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No owned HTTP address');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/search/by-file?${query}`);
    expect(response.status).toBe(200);
    const body = await response.json() as { content: Array<{ text: string }> };
    return body.content[0].text;
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  }
}

describe('literal filePath through the HTTP boundary', () => {
  it('keeps commas inside an explicitly named file path', async () => {
    const text = await requestFile(new URLSearchParams({ filePath: 'src/release,final.md', project: 'owned-project' }));
    expect(text).toContain('COMMA_PATH_RECORD');
    expect(text).not.toContain('PREFIX_PATH_RECORD');
    expect(text).toContain('src/release,final.md');
  });

  it('preserves the existing comma-separated files alias behavior', async () => {
    const text = await requestFile(new URLSearchParams({ files: 'src/release,src/other.md', project: 'owned-project' }));
    expect(text).toContain('PREFIX_PATH_RECORD');
    expect(text).toContain('for file "src/release"');
  });
});
