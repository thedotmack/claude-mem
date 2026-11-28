// Entry point bundled into the request-progress skill's scripts folder.
import { join } from 'node:path';
import { resolveHarnessAuthHeaders, resolveHarnessWorkerUrl, withHarnessAuth } from '../../integrations/harness-worker.js';
import { resolveDataDir } from '../../shared/paths.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { runCli } from './request-groups.mjs';
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { SharedLedgerAdapter } from './shared-ledger-adapter.mjs';
import { registerSharedFileWriter } from './shared-file-hooks.mjs';
import { ensureLocalDeviceIdentity } from '../sync/local-device-identity.js';
import { SQLITE_BUSY_TIMEOUT_MS } from '../sqlite/connection.js';
import { isTransientSqliteBusy } from '../worker/db-init-retry.js';

/** record-focus: the worker writes the my-focus rows (they sync); a 400 means it refused before writing anything. */
async function saveFocus(body) {
  const base = resolveHarnessWorkerUrl();
  let response;
  try {
    // Carries the local API token when that mode is on (#5141).
    response = await fetch(`${base}/api/work-view/focus/router`, withHarnessAuth({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, resolveHarnessAuthHeaders(base)));
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
/** Each shared ledger write this run made, in order: `saved` once its shared records committed, and for a saved one
 * whether writing or recording its file was left to the worker's reconciler (finishWrite 'pending', with the reason). */
const writes = [];
const command = process.argv[2];
const writesLedger = ['apply', 'record-progress', 'record-titles', 'record-story'].includes(command) || (command === 'judge' && process.argv.includes('--apply'));

/** With shared state on, a ledger write commits its shared records to claude-mem.db, then writes its file under the write lock. */
function openSharedWriter() {
  sharedDatabase = new Database(join(resolveDataDir(), 'claude-mem.db'), { readwrite: true, create: false });
  // Wait for another writer's lock as long as the worker's own connections do (SQLITE_BUSY_TIMEOUT_MS, connection.ts),
  // not bun:sqlite's default of 0 ms, which failed a write at once with "database is locked" whenever the worker or
  // another reviewer was writing.
  sharedDatabase.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  let adapter;
  try {
    localDeviceId = ensureLocalDeviceIdentity(sharedDatabase, join(resolveDataDir(), 'settings.json'), localDeviceId);
    adapter = new SharedLedgerAdapter(sharedDatabase, { directory: join(resolveDataDir(), 'work-view'), deviceId: localDeviceId });
  } catch (error) {
    if (!isTransientSqliteBusy(error)) throw error;
    throw new Error(`Another writer held the claude-mem database for longer than ${SQLITE_BUSY_TIMEOUT_MS} ms while this command prepared its shared write (device identity and file-state table), so nothing was saved. Run the command again.`, { cause: error });
  }
  stopSharedWriter = registerSharedFileWriter(join(resolveDataDir(), 'work-view'), (name, value, options) => {
    let finish;
    try { finish = adapter.beforeWrite(name, value, options); }
    catch (error) { writes.push({ name, saved: false }); throw error; }
    // Past the commit: finishWrite never throws, and what it leaves pending the reconciler finishes.
    return finish && (() => {
      const finished = finish();
      writes.push({ name, saved: true, ...finished });
      return finished;
    });
  });
}

/**
 * What stderr says about the shared writes when the command ends. A write whose shared records committed is saved even
 * when its file was left for the worker: that is never a failure, so the command is not run again for a decision it
 * already made, and it exits 0 when nothing else failed. When something failed after a write was saved (a later write
 * refused, as `judge --apply` writes after each verdict), it names what was saved and what was not.
 */
function savedNotes(attempts, failed) {
  const saved = attempts.filter((write) => write.saved), left = saved.filter((write) => write.materialization === 'pending');
  const names = (list) => [...new Set(list.map((write) => write.name))].join(', ');
  const notes = [];
  if (left.length) notes.push(`Saved ${names(left)}; writing or recording the file is left for the claude-mem worker to finish (${[...new Set(left.map((write) => write.reason))].join('; ')}).`);
  if (failed && saved.length) {
    const refused = attempts.filter((write) => !write.saved);
    notes.push(`Saved before the failure: ${names(saved)} (${saved.length} ${saved.length === 1 ? 'write' : 'writes'}). Not saved: ${refused.length ? names(refused) : 'what the command had not written yet'}. What was saved stays saved; run the command again for the rest.`);
  } else if (left.length) notes.push('Nothing needs to run again.');
  return notes.join('\n');
}

// Printed through process.stdout.write and awaited: the imports above load the logger, which reads
// process.stdout.isTTY, and after that Bun drops whatever console.log has not flushed to a pipe when the process
// exits (focus-input at 106 KB arrived cut at 65536 bytes). Agents read this output through a pipe.
let output = '';
const print = (value) => { output += `${JSON.stringify(value, null, 2)}\n`; };
try {
  if (settings.CLAUDE_MEM_WORK_VIEW_SHARED_STATE === 'true' && writesLedger && existsSync(join(resolveDataDir(), 'claude-mem.db'))) openSharedWriter();
  await runCli(process.argv.slice(2), { saveFocus, localDeviceId, print });
}
catch (error) { console.error(error.message); process.exitCode = 1; }
finally { stopSharedWriter?.(); sharedDatabase?.close(); }
const notes = savedNotes(writes, process.exitCode === 1);
if (notes) console.error(notes);
if (output) await new Promise((resolve, reject) => process.stdout.write(output, (error) => error ? reject(error) : resolve()));
