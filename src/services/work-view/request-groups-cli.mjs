// Entry point bundled into the request-progress skill's scripts folder.
import { join } from 'node:path';
import { resolveHarnessWorkerUrl } from '../../integrations/harness-worker.js';
import { resolveDataDir } from '../../shared/paths.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { runCli } from './request-groups.mjs';
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { SharedLedgerAdapter } from './shared-ledger-adapter.mjs';
import { registerSharedFileWriter } from './shared-file-hooks.mjs';
import { ensureLocalDeviceIdentity } from '../sync/local-device-identity.js';

/** record-focus: the worker writes the my-focus rows (they sync); a 400 means it refused before writing anything. */
async function saveFocus(body) {
  const base = resolveHarnessWorkerUrl();
  let response;
  try {
    response = await fetch(`${base}/api/work-view/focus/router`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (error) {
    throw new Error(`claude-mem worker is not reachable at ${base} (${error.message}). Start it with: npx claude-mem start`);
  }
  const text = await response.text();
  if (response.status === 400) throw new TypeError(`worker refused the answer: ${text}`);
  if (!response.ok) throw new Error(`worker refused /api/work-view/focus/router: ${response.status} ${text}`);
  return JSON.parse(text);
}

// The worker's sync device id as CloudSync persisted it ('' before cloud sync first started, when every row is local).
const settings = SettingsDefaultsManager.loadFromFile(join(resolveDataDir(), 'settings.json'), true, { readOnly: true });
let localDeviceId = settings.CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID ?? '';
let sharedDatabase = null;
let stopSharedWriter = null;
const command = process.argv[2];
const writesLedger = ['apply', 'record-progress', 'record-story'].includes(command) || (command === 'judge' && process.argv.includes('--apply'));
if (settings.CLAUDE_MEM_WORK_VIEW_SHARED_STATE === 'true' && writesLedger && existsSync(join(resolveDataDir(), 'claude-mem.db'))) {
  sharedDatabase = new Database(join(resolveDataDir(), 'claude-mem.db'), { readwrite: true, create: false });
  localDeviceId = ensureLocalDeviceIdentity(sharedDatabase, join(resolveDataDir(), 'settings.json'), localDeviceId);
  const adapter = new SharedLedgerAdapter(sharedDatabase, { directory: join(resolveDataDir(), 'work-view'), deviceId: localDeviceId });
  stopSharedWriter = registerSharedFileWriter(join(resolveDataDir(), 'work-view'), (name, value) => adapter.beforeWrite(name, value));
}

// Printed through process.stdout.write and awaited: the imports above load the logger, which reads
// process.stdout.isTTY, and after that Bun drops whatever console.log has not flushed to a pipe when the process
// exits (focus-input at 106 KB arrived cut at 65536 bytes). Agents read this output through a pipe.
let output = '';
const print = (value) => { output += `${JSON.stringify(value, null, 2)}\n`; };
try { await runCli(process.argv.slice(2), { saveFocus, localDeviceId, print }); }
catch (error) { console.error(error.message); process.exitCode = 1; }
finally { stopSharedWriter?.(); sharedDatabase?.close(); }
if (output) await new Promise((resolve, reject) => process.stdout.write(output, (error) => error ? reject(error) : resolve()));
