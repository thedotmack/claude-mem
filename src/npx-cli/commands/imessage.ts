/**
 * `claude-mem imessage …` — the iMessage group chat observer.
 *
 *   imessage setup     Save the Photon line's address and token, install the Photon SDK
 *   imessage observe   Listen to every group chat the line is in and make observations
 *   imessage chats     List the chats being observed and their projects
 *
 * See docs/integrations/imessage-observer.md.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { DATA_DIR } from '../../shared/paths.js';

const USAGE = `Usage:
  claude-mem imessage setup [--address <host:port>] [--token <token>] [--no-tls]
  claude-mem imessage observe [--chat <guid>]... [--include-direct] [--replay <file.jsonl>] [--dry-run]
  claude-mem imessage chats`;

export interface ImessageConfig {
  address?: string;
  token?: string;
  tls?: boolean;
  meLabel?: string;
  includeDirect?: boolean;
  onlyChats?: string[];
}

export function observerDir(): string {
  return join(DATA_DIR, 'imessage-observer');
}

const configPath = () => join(observerDir(), 'config.json');
const contactsPath = () => join(observerDir(), 'contacts.json');
const statePath = () => join(observerDir(), 'chats.json');

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function readConfig(): ImessageConfig {
  const saved = readJson<ImessageConfig>(configPath(), {});
  return {
    ...saved,
    address: process.env.PHOTON_IMESSAGE_ADDRESS || saved.address,
    token: process.env.PHOTON_IMESSAGE_TOKEN || saved.token,
  };
}

function writePrivate(path: string, value: unknown): void {
  mkdirSync(observerDir(), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* Windows keeps its own ACLs. */ }
}

const log = {
  info: (message: string) => console.log(message),
  warn: (message: string) => console.warn(message),
};

async function setup(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { address: { type: 'string' }, token: { type: 'string' }, 'no-tls': { type: 'boolean' } },
    strict: true,
  });
  const current = readJson<ImessageConfig>(configPath(), {});
  let address = values.address ?? current.address;
  let token = values.token ?? current.token;
  if ((!address || !token) && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    console.log('Your Photon line\'s server address and token are on your Photon dashboard.');
    if (!address) address = (await rl.question('Photon server address (host:port): ')).trim();
    if (!token) token = (await rl.question('Photon token: ')).trim();
    rl.close();
  }
  if (!address || !token) {
    console.error('Setup needs the Photon server address and token (--address and --token, or run it in a terminal).');
    return 1;
  }
  writePrivate(configPath(), { ...current, address, token, tls: values['no-tls'] ? false : current.tls ?? true });
  if (!existsSync(contactsPath())) writePrivate(contactsPath(), {});

  const { PHOTON_PACKAGES } = await import('../../integrations/imessage-observer/photon-source.js');
  const dir = observerDir();
  if (!existsSync(join(dir, 'package.json'))) {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'claude-mem-imessage-observer', private: true, type: 'module' }, null, 2) + '\n');
  }
  console.log('Installing the Photon iMessage SDK into ' + dir + ' ...');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['install', '--no-audit', '--no-fund', '--prefix', dir, ...PHOTON_PACKAGES], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error('Installing the Photon SDK failed. Your address and token are saved; run setup again to retry the install.');
    return 1;
  }
  console.log('\nDone. Add your Photon line to any iMessage group chat, then run:\n  npx claude-mem imessage observe');
  return 0;
}

async function observe(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      chat: { type: 'string', multiple: true },
      'include-direct': { type: 'boolean' },
      replay: { type: 'string' },
      'dry-run': { type: 'boolean' },
    },
    strict: true,
  });
  const config = readConfig();
  const { GroupChatObserver } = await import('../../integrations/imessage-observer/observer.js');

  let source;
  if (values.replay) {
    const { ReplaySource } = await import('../../integrations/imessage-observer/replay-source.js');
    source = ReplaySource.fromFile(values.replay);
  } else {
    if (!config.address || !config.token) {
      console.error('No Photon line is set up yet. Run: npx claude-mem imessage setup');
      return 1;
    }
    const { PhotonSource } = await import('../../integrations/imessage-observer/photon-source.js');
    source = new PhotonSource({ address: config.address, token: config.token, tls: config.tls, installDir: observerDir(), log });
  }

  let post;
  if (values['dry-run']) {
    post = async (route: string, body: unknown) => {
      console.log(`\n→ ${route}\n${JSON.stringify(body, null, 2)}`);
      return { status: 'ok' };
    };
  } else {
    const { createHarnessWorkerClient } = await import('../../integrations/harness-worker.js');
    const worker = createHarnessWorkerClient();
    await worker.ready();
    post = async (route: string, body: unknown) => (await worker.post(route, body)).json();
  }

  const observer = new GroupChatObserver({
    source,
    post,
    log,
    statePath: values['dry-run'] ? join(observerDir(), 'chats.dry-run.json') : statePath(),
    contacts: readJson<Record<string, string>>(contactsPath(), {}),
    meLabel: config.meLabel,
    onlyChats: values.chat ?? config.onlyChats,
    includeDirect: values['include-direct'] ?? config.includeDirect,
    clock: values.replay ? 'event' : 'wall',
  });
  const shutdown = () => { void observer.stop(); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await observer.run();
  console.log(`Stopped. Sent ${observer.deliveredWindows.length} conversation windows; skipped ${observer.skippedWindows}.`);
  return 0;
}

function listChats(): number {
  const state = readJson<{ chats?: Record<string, { project: string; name: string }> }>(statePath(), {});
  const rows = Object.entries(state.chats ?? {});
  if (rows.length === 0) {
    console.log('No chats observed yet.');
    return 0;
  }
  for (const [guid, chat] of rows) console.log(`${chat.name}\n  project: ${chat.project}\n  chat: ${guid}`);
  return 0;
}

export async function runImessageCommand(action: string | undefined, args: string[]): Promise<number> {
  try {
    if (action === 'setup') return await setup(args);
    if (action === 'observe') return await observe(args);
    if (action === 'chats') return listChats();
    console.log(USAGE);
    return action === undefined || action === 'help' ? 0 : 1;
  } catch (error) {
    console.error(`iMessage observer: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
