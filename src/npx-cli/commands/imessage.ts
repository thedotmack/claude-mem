/**
 * `claude-mem imessage …` — the iMessage group chat observer.
 *
 *   imessage setup     Sign in to Photon (or paste a line's address and token), install the Photon SDK
 *   imessage observe   Listen to every group chat the line is in and make observations
 *   imessage chats     List the chats being observed and their projects
 *
 * See docs/imessage-group-observer.md.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { DATA_DIR } from '../../shared/paths.js';
import { PHOTON_CLI, signInWithPhoton } from '../../integrations/imessage-observer/photon-signup.js';

const USAGE = `Usage:
  claude-mem imessage setup [--login] [--project-id <id> --project-secret <secret>]
                            [--address <host:port> --token <token>] [--no-tls]
  claude-mem imessage observe [--chat <guid>]... [--include-direct] [--replay <file.jsonl>] [--dry-run]
  claude-mem imessage chats`;

export interface ImessageConfig {
  /** Photon project (from the browser sign-in). Its lines and tokens are looked up live. */
  projectId?: string;
  projectSecret?: string;
  /** Or one line's server address and token, pasted by hand. */
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
    projectId: process.env.PHOTON_PROJECT_ID || process.env.SPECTRUM_PROJECT_ID || saved.projectId,
    projectSecret: process.env.PHOTON_PROJECT_SECRET || process.env.SPECTRUM_PROJECT_SECRET || saved.projectSecret,
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

/** Runs Photon's own command-line tool through npx. */
function runPhotonCli(args: string[], options: { interactive: boolean }): { status: number | null; stdout: string } {
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  // PHOTON_CLI is a fixed package name, never user input.
  const result = spawnSync(npx, ['--yes', PHOTON_CLI, ...args], {
    stdio: options.interactive ? 'inherit' : ['inherit', 'pipe', 'inherit'],
    encoding: 'utf8',
  });
  return { status: result.status, stdout: typeof result.stdout === 'string' ? result.stdout : '' };
}

/** Checks the saved project with Photon and says which number to add to group chats. */
async function checkProjectLines(projectId: string, projectSecret: string): Promise<boolean> {
  const { PhotonCloudLines } = await import('../../integrations/imessage-observer/photon-cloud.js');
  try {
    const lines = await new PhotonCloudLines({ projectId, projectSecret }).lines();
    if (lines.length === 0) {
      console.error('Your Photon project has no dedicated iMessage line yet. Add one on the Photon dashboard (https://app.photon.codes), then run setup again.');
      return false;
    }
    console.log(lines.length === 1 ? '\nYour Photon line:' : '\nYour Photon lines:');
    for (const line of lines) console.log(`  ${line.phone}`);
    console.log('Add this number to the iMessage group chats you want remembered.');
    return true;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return false;
  }
}

async function setup(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      login: { type: 'boolean' },
      'project-id': { type: 'string' },
      'project-secret': { type: 'string' },
      address: { type: 'string' },
      token: { type: 'string' },
      'no-tls': { type: 'boolean' },
    },
    strict: true,
  });
  const current = readJson<ImessageConfig>(configPath(), {});
  const next: ImessageConfig = { ...current };
  const tty = Boolean(process.stdin.isTTY);
  const rl = tty ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const ask = async (question: string) => rl ? await rl.question(question) : '';

  try {
    let mode: 'login' | 'project' | 'line' | null = null;
    if (values.login) mode = 'login';
    else if (values['project-id'] || values['project-secret']) mode = 'project';
    else if (values.address || values.token) mode = 'line';
    else if (tty) {
      console.log('Connect your Photon iMessage line:');
      console.log('  1. Sign in to Photon in your browser (recommended)');
      console.log('  2. Paste a line\'s server address and token');
      mode = (await ask('Choose [1]: ')).trim() === '2' ? 'line' : 'login';
    } else if ((current.projectId && current.projectSecret) || (current.address && current.token)) {
      mode = null; // Already set up: only reinstall the SDK.
    } else {
      console.error('Setup needs a terminal for the Photon sign-in, or --project-id and --project-secret, or --address and --token.');
      return 1;
    }

    if (mode === 'login') {
      if (!tty) {
        console.error('The Photon sign-in needs a terminal. Run setup in a terminal, or pass --project-id and --project-secret.');
        return 1;
      }
      const signedIn = await signInWithPhoton({ run: runPhotonCli, ask, log: message => console.log(message) });
      console.log(`Using the Photon project "${signedIn.projectName}".`);
      Object.assign(next, { projectId: signedIn.projectId, projectSecret: signedIn.projectSecret, address: undefined, token: undefined });
    } else if (mode === 'project') {
      const projectId = values['project-id'] ?? current.projectId;
      const projectSecret = values['project-secret'] ?? current.projectSecret;
      if (!projectId || !projectSecret) {
        console.error('Pass both --project-id and --project-secret (Photon dashboard, project Settings).');
        return 1;
      }
      Object.assign(next, { projectId, projectSecret, address: undefined, token: undefined });
    } else if (mode === 'line') {
      let address = values.address ?? current.address;
      let token = values.token ?? current.token;
      if (!address) address = (await ask('Photon server address (host:port): ')).trim();
      if (!token) token = (await ask('Photon token: ')).trim();
      if (!address || !token) {
        console.error('Setup needs both the Photon server address and token.');
        return 1;
      }
      Object.assign(next, { address, token, projectId: undefined, projectSecret: undefined, tls: values['no-tls'] ? false : current.tls ?? true });
    }
  } finally {
    rl?.close();
  }

  writePrivate(configPath(), next);
  if (!existsSync(contactsPath())) writePrivate(contactsPath(), {});
  if (next.projectId && next.projectSecret && !(await checkProjectLines(next.projectId, next.projectSecret))) {
    console.error('Your Photon sign-in is saved. Run setup again once the line is ready.');
    return 1;
  }

  const { PHOTON_PACKAGES } = await import('../../integrations/imessage-observer/photon-source.js');
  const dir = observerDir();
  if (!existsSync(join(dir, 'package.json'))) {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'claude-mem-imessage-observer', private: true, type: 'module' }, null, 2) + '\n');
  }
  console.log('Installing the Photon iMessage SDK into ' + dir + ' ...');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['install', '--no-audit', '--no-fund', '--prefix', dir, ...PHOTON_PACKAGES], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error('Installing the Photon SDK failed. Your Photon details are saved; run setup again to retry the install.');
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
    const { PhotonSource } = await import('../../integrations/imessage-observer/photon-source.js');
    if (config.projectId && config.projectSecret) {
      const { PhotonCloudLines } = await import('../../integrations/imessage-observer/photon-cloud.js');
      const cloud = new PhotonCloudLines({ projectId: config.projectId, projectSecret: config.projectSecret });
      const lines = async () => (await cloud.lines()).map(line => ({ address: line.address, token: line.token, label: line.phone }));
      source = new PhotonSource({ lines, installDir: observerDir(), log });
    } else if (config.address && config.token) {
      source = new PhotonSource({ lines: [{ address: config.address, token: config.token }], tls: config.tls, installDir: observerDir(), log });
    } else {
      console.error('No Photon line is set up yet. Run: npx claude-mem imessage setup');
      return 1;
    }
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
    excludedProjects: await excludedProjects(),
  });
  const shutdown = () => { void observer.stop(); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await observer.run();
  console.log(`Stopped. Sent ${observer.deliveredWindows.length} conversation windows; skipped ${observer.skippedWindows}.`);
  return 0;
}

/** Claude-Mem's project exclusions, from settings.json or the environment. */
async function excludedProjects(): Promise<string> {
  try {
    const { SettingsDefaultsManager } = await import('../../shared/SettingsDefaultsManager.js');
    const { USER_SETTINGS_PATH } = await import('../../shared/paths.js');
    return SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH, true, { readOnly: true }).CLAUDE_MEM_EXCLUDED_PROJECTS ?? '';
  } catch {
    return process.env.CLAUDE_MEM_EXCLUDED_PROJECTS ?? '';
  }
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
