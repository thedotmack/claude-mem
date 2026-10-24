// A Library change whose process stalls after writing its config files and
// before library.json records them (a suspended laptop, a slow disk), long
// past the age at which the lock used to be broken as stale. Started as a
// child by library-lock-and-recovery.test.ts:
//
//   bun stall-mid-change.ts <libraryDirectory> <settingsFile> <markerFile> <stallMs>

import { utimesSync, writeFileSync } from 'fs';
import { applyLibrary } from '../../../src/services/wire-gateway/library/library-engine.js';
import { libraryRecordPath } from '../../../src/services/wire-gateway/library/library-record.js';

const [libraryDirectory, file, markerFile, stallMs] = process.argv.slice(2);
/** Older than any stale window a time-based lock rule would use (the old one: 10 s). */
const LOCK_AGE_OF_A_LONG_STALL_MS = 60_000;

const result = applyLibrary({
  agentId: 'stalled',
  items: [{ kind: 'setting', id: 'setting:flag', group: 'settings', place: 'member', file, format: 'json', keyPath: ['plugins', 'claude-mem'], value: true, whenUnrecorded: 'replace-and-stash' }],
  ownedGroups: ['settings'],
}, {
  libraryDirectory,
  afterConfigFilesWritten: () => {
    const longAgo = new Date(Date.now() - LOCK_AGE_OF_A_LONG_STALL_MS);
    utimesSync(`${libraryRecordPath(libraryDirectory)}.lock`, longAgo, longAgo);
    writeFileSync(markerFile, 'files written, stalling');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(stallMs));
  },
});
process.stdout.write(JSON.stringify(result));
