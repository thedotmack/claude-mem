// #2691 — Path inconsistency between PreToolUse:Read and PostToolUse broke
// context injection. PostToolUse stores whatever path form the observer
// recorded (often the absolute tool-input path), while PreToolUse:Read queried
// ONLY the cwd-relative form, so the exact-match lookup never matched.
// getObservationsByFilePath now accepts multiple candidate path forms and
// matches an observation whose files_read/files_modified contain ANY of them,
// yielding a consistent key across both handlers.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { getObservationsByFilePath } from '../../../src/services/sqlite/observations/get.js';

describe('getObservationsByFilePath — multi-candidate path matching (#2691)', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  function seedObservationWithReadPath(readPath: string, sessionSuffix: string, project = 'proj', platform = 'claude'): number {
    const sdkId = store.createSDKSession(`content-${sessionSuffix}`, project, 'prompt', undefined, platform);
    store.updateMemorySessionId(sdkId, `session-${sessionSuffix}`);
    const result = store.storeObservations(
      `session-${sessionSuffix}`,
      project,
      [{
        type: 'discovery',
        title: `touched ${sessionSuffix}: ${readPath}`,
        subtitle: null,
        facts: ['fact'],
        narrative: null,
        concepts: [],
        files_read: [readPath],
        files_modified: [],
      }],
      null,
      0,
      0,
      1_700_000_000_000,
    );
    return result.observationIds[0];
  }

  it('matches an observation stored under an ABSOLUTE path when querying multiple candidate forms', () => {
    const absolutePath = '/Users/dev/proj/src/services/foo.ts';
    const relativePath = 'src/services/foo.ts';
    const id = seedObservationWithReadPath(absolutePath, 'abs');

    // PreToolUse:Read sends both the absolute and the relative candidate forms.
    const matches = getObservationsByFilePath(store.db, [absolutePath, relativePath]);
    expect(matches.map(o => o.id)).toContain(id);
  });

  it.each([
    ['./src/note.ts', 'src/note.ts'],
    ['.\\src\\note.ts', 'src/note.ts'],
    ['src/note.ts', './src/note.ts'],
    ['src/note.ts', '.\\src\\note.ts'],
  ])('matches current-directory evidence %s from query %s', (storedPath, queryPath) => {
    const id = seedObservationWithReadPath(storedPath, 'matching');
    seedObservationWithReadPath(storedPath, 'other-project', 'unrelated');
    seedObservationWithReadPath(storedPath, 'other-source', 'proj', 'codex');
    seedObservationWithReadPath('./src/note.ts.bak', 'other-file');
    expect(getObservationsByFilePath(store.db, ['/checkout/src/note.ts', queryPath], {
      projects: ['proj'], platformSource: 'claude',
    }).map(row => row.id)).toEqual([id]);
  });

  it('does not reinterpret an absolute or home path as a current-directory path', () => {
    seedObservationWithReadPath('./C:/repo/note.ts', 'drive-lookalike');
    seedObservationWithReadPath('.//repo/note.ts', 'absolute-lookalike');
    seedObservationWithReadPath('./~/note.ts', 'home-lookalike');
    expect(getObservationsByFilePath(store.db, ['C:/repo/note.ts', '/repo/note.ts', '~/note.ts'])).toEqual([]);
  });

  it('matches an observation stored under a RELATIVE path when querying multiple candidate forms', () => {
    const absolutePath = '/Users/dev/proj/src/services/bar.ts';
    const relativePath = 'src/services/bar.ts';
    const id = seedObservationWithReadPath(relativePath, 'rel');

    const matches = getObservationsByFilePath(store.db, [absolutePath, relativePath]);
    expect(matches.map(o => o.id)).toContain(id);
  });

  it('matches a Windows tool-input path stored with backslashes when querying the forward-slashed forms', () => {
    // Claude Code on Windows reads and edits `C:\...` paths; the PreToolUse:Read
    // hook sends `absolutePath.split(path.sep).join('/')` and the relative form.
    const storedAbsolute = 'C:\\Users\\dev\\proj\\src\\services\\win.ts';
    const storedRelative = 'src\\services\\win-relative.ts';
    const absoluteId = seedObservationWithReadPath(storedAbsolute, 'win-abs');
    const relativeId = seedObservationWithReadPath(storedRelative, 'win-rel');

    const absoluteMatches = getObservationsByFilePath(store.db, ['C:/Users/dev/proj/src/services/win.ts', 'src/services/win.ts']);
    expect(absoluteMatches.map(o => o.id)).toContain(absoluteId);

    const relativeMatches = getObservationsByFilePath(store.db, ['C:/Users/dev/proj/src/services/win-relative.ts', 'src/services/win-relative.ts']);
    expect(relativeMatches.map(o => o.id)).toContain(relativeId);
  });
});
