// A Library change cut off after its config files are written and before
// library.json records them (the process dies, as a kill or power loss would
// end it). Started as a child by library-engine.test.ts:
//
//   bun crash-mid-change.ts <libraryDirectory> <settingsFile>

import { applyLibrary } from '../../../src/services/wire-gateway/library/library-engine.js';

const [libraryDirectory, file] = process.argv.slice(2);
/** The exit code the parent test expects: anything else means the crash point was never reached. */
const CRASHED_MID_CHANGE_EXIT_CODE = 86;

applyLibrary({
  agentId: 'agent',
  items: [{ kind: 'setting', id: 'setting:flag', group: 'settings', place: 'member', file, format: 'json', keyPath: ['plugins', 'claude-mem'], value: true, whenUnrecorded: 'replace-and-stash' }],
  ownedGroups: ['settings'],
}, { libraryDirectory, afterConfigFilesWritten: () => process.exit(CRASHED_MID_CHANGE_EXIT_CODE) });
