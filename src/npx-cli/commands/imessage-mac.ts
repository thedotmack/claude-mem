/**
 * `claude-mem imessage mac …` — read iMessage from the Messages database on
 * this Mac, for the chats you pick, and keep notes on them in Claude-Mem.
 *
 *   imessage mac check     Can this app read Messages (Full Disk Access)? Is Claude-Mem running?
 *   imessage mac chats     List the chats and group chats on this Mac
 *   imessage mac pick      Turn a chat on or off, and say what to watch it for
 *   imessage mac observe   Listen for new messages in the picked chats and send them to Claude-Mem
 *   imessage mac contacts  Save names for phone numbers and emails (JSON on stdin), so notes say who said what
 *
 * Every command takes --json, which the Claude-Mem Messages app reads. The
 * app runs this command as its own child, so the Full Disk Access granted to
 * the app covers the read. See docs/imessage-mac-app.md.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { DATA_DIR } from '../../shared/paths.js';

const USAGE = `Usage:
  claude-mem imessage mac check   [--json] [--db <path>]
  claude-mem imessage mac chats   [--json] [--db <path>] [--groups]
  claude-mem imessage mac pick    [<chat-guid>] [--on|--off] [--focus <text>] [--default-focus <text>] [--json]
  claude-mem imessage mac observe [--json] [--db <path>] [--dry-run]
  claude-mem imessage mac contacts [--replace] [--json] < names.json   ({"+15551234567": "Ana", ...})`;

const observerDir = () => join(DATA_DIR, 'imessage-observer');
export const macSelectionPath = () => join(observerDir(), 'mac.json');
const contactsPath = () => join(observerDir(), 'contacts.json');
const statePath = () => join(observerDir(), 'chats.json');

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Prints one JSON line (for the app) or a plain line (for a person). */
function emitter(json: boolean) {
  return {
    json,
    event(value: Record<string, unknown>): void {
      if (json) process.stdout.write(JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n');
    },
    info(message: string): void {
      if (json) this.event({ type: 'log', level: 'info', message });
      else console.log(message);
    },
    warn(message: string): void {
      if (json) this.event({ type: 'log', level: 'warn', message });
      else console.warn(message);
    },
  };
}

/**
 * The Messages database is SQLite. Bun reads it with bun:sqlite and newer
 * Node with node:sqlite; on an older Node this command runs itself again
 * under Bun, which Claude-Mem already needs.
 */
function needsBun(): boolean {
  if (process.versions.bun) return false;
  try {
    createRequire(import.meta.url)('node:sqlite');
    return false;
  } catch {
    return true;
  }
}

async function rerunUnderBun(action: string, args: string[]): Promise<number> {
  const { getBunPath } = await import('../install/setup-runtime.js');
  const bun = getBunPath();
  const script = process.argv[1];
  if (!bun || !script) {
    console.error('Reading the Messages database needs Bun or Node 22.13 or newer. Run: npx claude-mem install');
    return 1;
  }
  const child = spawn(bun, [script, 'imessage', 'mac', action, ...args], { stdio: 'inherit' });
  // Stopping this process stops the reader too, so it never outlives the app that started it.
  const forward = (signal: NodeJS.Signals) => () => { child.kill(signal); };
  const onTerm = forward('SIGTERM');
  const onInt = forward('SIGINT');
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);
  return await new Promise<number>(resolve => {
    child.once('error', () => resolve(1));
    child.once('close', code => {
      process.off('SIGTERM', onTerm);
      process.off('SIGINT', onInt);
      resolve(code ?? 1);
    });
  });
}

async function peopleBook() {
  const { normalizeNames, personLabel } = await import('../../integrations/imessage-observer/transcript.js');
  const book = { names: normalizeNames(readJson<Record<string, string>>(contactsPath(), {})), meLabel: 'Me' };
  return { book, label: (address: string) => personLabel(address, book) };
}

async function check(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { json: { type: 'boolean' }, db: { type: 'string' } }, strict: true });
  const out = emitter(Boolean(values.json));
  const { checkChatDbAccess } = await import('../../integrations/imessage-observer/chatdb.js');
  const access = checkChatDbAccess(values.db);
  let worker: { reachable: boolean; url: string; detail?: string };
  const { resolveHarnessWorkerUrl } = await import('../../integrations/harness-worker.js');
  const url = resolveHarnessWorkerUrl();
  try {
    const response = await fetch(url + '/api/health', { signal: AbortSignal.timeout(3_000) });
    worker = { reachable: response.ok, url, ...(response.ok ? {} : { detail: `health check returned ${response.status}` }) };
  } catch (error) {
    worker = { reachable: false, url, detail: error instanceof Error ? error.message : String(error) };
  }
  if (out.json) {
    out.event({ type: 'check', messages: access, worker, dataDir: DATA_DIR });
  } else {
    if (access.ok) console.log(`Messages: readable (${access.path})`);
    else if (access.reason === 'no-permission') console.log('Messages: blocked. Give this app (or your terminal) Full Disk Access in System Settings > Privacy & Security > Full Disk Access.');
    else console.log(`Messages: ${access.detail}`);
    console.log(worker.reachable ? `Claude-Mem: running at ${worker.url}` : `Claude-Mem: not reachable at ${worker.url} (${worker.detail ?? ''}). Run: npx claude-mem start`);
  }
  return access.ok ? 0 : 2;
}

async function chats(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { json: { type: 'boolean' }, db: { type: 'string' }, groups: { type: 'boolean' } }, strict: true });
  const out = emitter(Boolean(values.json));
  const { ChatDbSource } = await import('../../integrations/imessage-observer/chatdb-source.js');
  const { MacSelection } = await import('../../integrations/imessage-observer/mac-selection.js');
  const { label } = await peopleBook();
  const selection = new MacSelection(macSelectionPath());
  const projects = readJson<{ chats?: Record<string, { project: string }> }>(statePath(), {}).chats ?? {};
  const source = new ChatDbSource({ dbPath: values.db, label, isObserved: () => false, watch: false });
  const list = source.listChats()
    .filter(chat => !values.groups || chat.isGroup)
    .map(chat => ({
      ...chat,
      observed: selection.isObserved(chat.guid),
      focus: selection.file.chats[chat.guid]?.focus ?? '',
      project: projects[chat.guid]?.project ?? null,
    }));
  if (out.json) {
    out.event({ type: 'chats', defaultFocus: selection.file.defaultFocus ?? '', chats: list });
    return 0;
  }
  if (list.length === 0) console.log('No chats found in Messages.');
  for (const chat of list) {
    const mark = chat.observed ? '[x]' : '[ ]';
    console.log(`${mark} ${chat.name}${chat.isGroup ? ' (group)' : ''}  ${chat.messageCount} messages`);
    console.log(`    ${chat.guid}${chat.focus ? `\n    watching for: ${chat.focus}` : ''}`);
  }
  return 0;
}

async function pick(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: { on: { type: 'boolean' }, off: { type: 'boolean' }, focus: { type: 'string' }, 'default-focus': { type: 'string' }, json: { type: 'boolean' } },
    allowPositionals: true,
    strict: true,
  });
  const { MacSelection, writeSelection, MAX_FOCUS_CHARS } = await import('../../integrations/imessage-observer/mac-selection.js');
  const path = macSelectionPath();
  const file = new MacSelection(path).file;
  const guid = positionals[0];
  if (values['default-focus'] !== undefined) file.defaultFocus = values['default-focus'].slice(0, MAX_FOCUS_CHARS);
  if (guid) {
    const current = file.chats[guid] ?? { observe: false };
    const observe = values.off ? false : values.on ? true : current.observe;
    const focus = values.focus !== undefined ? values.focus.slice(0, MAX_FOCUS_CHARS) : current.focus;
    file.chats[guid] = { observe, ...(focus ? { focus } : {}) };
  } else if (values['default-focus'] === undefined) {
    console.error(USAGE);
    return 1;
  }
  writeSelection(path, file);
  if (values.json) emitter(true).event({ type: 'picked', guid: guid ?? null, choice: guid ? file.chats[guid] : null });
  else if (guid) console.log(`${file.chats[guid]!.observe ? 'Observing' : 'Not observing'} ${guid}${file.chats[guid]!.focus ? ` (watching for: ${file.chats[guid]!.focus})` : ''}`);
  return 0;
}

async function observe(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { json: { type: 'boolean' }, db: { type: 'string' }, 'dry-run': { type: 'boolean' } },
    strict: true,
  });
  const out = emitter(Boolean(values.json));
  const { checkChatDbAccess } = await import('../../integrations/imessage-observer/chatdb.js');
  const access = checkChatDbAccess(values.db);
  if (!access.ok) {
    out.event({ type: 'error', reason: access.reason, message: access.detail });
    if (!out.json) {
      console.error(access.reason === 'no-permission'
        ? 'Messages is blocked. Give this app (or your terminal) Full Disk Access in System Settings > Privacy & Security > Full Disk Access, then try again.'
        : access.detail);
    }
    return 2;
  }

  const { ChatDbSource } = await import('../../integrations/imessage-observer/chatdb-source.js');
  const { MacSelection } = await import('../../integrations/imessage-observer/mac-selection.js');
  const { GroupChatObserver } = await import('../../integrations/imessage-observer/observer.js');
  const { label } = await peopleBook();
  const selection = new MacSelection(macSelectionPath());
  const isObserved = (guid: string) => selection.isObserved(guid);

  let post: (route: string, body: unknown) => Promise<unknown>;
  if (values['dry-run']) {
    post = async (route: string, body: unknown) => {
      if (out.json) out.event({ type: 'dry-run', route, body });
      else console.log(`\n→ ${route}\n${JSON.stringify(body, null, 2)}`);
      return { status: 'ok' };
    };
  } else {
    const { createHarnessWorkerClient } = await import('../../integrations/harness-worker.js');
    const worker = createHarnessWorkerClient();
    await worker.ready();
    post = async (route: string, body: unknown) => (await worker.post(route, body)).json();
  }

  const source = new ChatDbSource({ dbPath: values.db, label, isObserved, log: out });
  const observer = new GroupChatObserver({
    source,
    post,
    log: out,
    statePath: values['dry-run'] ? join(observerDir(), 'chats.dry-run.json') : statePath(),
    contacts: readJson<Record<string, string>>(contactsPath(), {}),
    meLabel: 'Me',
    via: 'mac',
    isObserved,
    focusFor: guid => selection.focusFor(guid),
    clock: 'wall',
    excludedProjects: await excludedProjects(),
  });

  const status = () => out.event({
    type: 'status',
    observing: selection.observedChats().length,
    sent: observer.deliveredWindows.length,
    skipped: observer.skippedWindows,
  });
  out.event({ type: 'started', observing: selection.observedChats().length, db: access.path });
  if (!out.json) console.log(`Listening to ${selection.observedChats().length} picked chats in Messages. New messages only; press Ctrl+C to stop.`);
  const timer = out.json ? setInterval(status, 15_000) : null;
  const shutdown = () => { void observer.stop(); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  // The app closes our stdin when it quits; stop with it rather than linger.
  if (out.json) process.stdin.once('end', shutdown).resume();
  try {
    await observer.run();
  } finally {
    if (timer) clearInterval(timer);
    // Let go of stdin so the process can exit once the last hand-over is done.
    if (out.json) process.stdin.destroy();
  }
  status();
  out.event({ type: 'stopped' });
  if (!out.json) console.log(`Stopped. Sent ${observer.deliveredWindows.length} conversation windows; skipped ${observer.skippedWindows}.`);
  return 0;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/** At most this many names are kept; an address book bigger than this is cut. */
const MAX_CONTACTS = 20_000;

/**
 * Names for addresses, from the Mac app's "Use names from Contacts". Only
 * address → name pairs are kept, in the same contacts.json the Photon
 * observer reads. With --replace the file is rewritten; otherwise merged.
 */
async function contacts(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { replace: { type: 'boolean' }, json: { type: 'boolean' } }, strict: true });
  let input: unknown;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    console.error('contacts expects a JSON object of address to name on stdin.');
    return 1;
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    console.error('contacts expects a JSON object of address to name on stdin.');
    return 1;
  }
  const next: Record<string, string> = values.replace ? {} : readJson<Record<string, string>>(contactsPath(), {});
  for (const [address, name] of Object.entries(input as Record<string, unknown>)) {
    if (Object.keys(next).length >= MAX_CONTACTS) break;
    if (typeof name !== 'string' || !name.trim() || !address.trim() || address.length > 320) continue;
    next[address.trim()] = name.trim().slice(0, 120);
  }
  mkdirSync(observerDir(), { recursive: true, mode: 0o700 });
  const temp = contactsPath() + '.tmp';
  writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, contactsPath());
  try { chmodSync(contactsPath(), 0o600); } catch { /* Windows keeps its own ACLs. */ }
  const count = Object.keys(next).length;
  if (values.json) emitter(true).event({ type: 'contacts', count });
  else console.log(`Saved ${count} names.`);
  return 0;
}

async function excludedProjects(): Promise<string> {
  try {
    const { SettingsDefaultsManager } = await import('../../shared/SettingsDefaultsManager.js');
    const { USER_SETTINGS_PATH } = await import('../../shared/paths.js');
    return SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH, true, { readOnly: true }).CLAUDE_MEM_EXCLUDED_PROJECTS ?? '';
  } catch {
    return process.env.CLAUDE_MEM_EXCLUDED_PROJECTS ?? '';
  }
}

export async function runImessageMacCommand(action: string | undefined, args: string[]): Promise<number> {
  if (action === undefined || action === 'help') {
    console.log(USAGE);
    return 0;
  }
  if (!['check', 'chats', 'pick', 'observe', 'contacts'].includes(action)) {
    console.log(USAGE);
    return 1;
  }
  if (action === 'contacts') return contacts(args);
  if (action !== 'pick' && needsBun()) return rerunUnderBun(action, args);
  if (action === 'check') return check(args);
  if (action === 'chats') return chats(args);
  if (action === 'pick') return pick(args);
  return observe(args);
}
