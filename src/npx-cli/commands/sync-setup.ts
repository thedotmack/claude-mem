import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, parse } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { loadDocument, settingsTarget, updateSettingsDocument } from '../../shared/settings-document.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { isWorkerAutostartDisabled } from '../../shared/worker-autostart.js';
import { isLoopbackHostname } from '../../shared/worker-url.js';
import { compareVersionsDescending, ensureWorkerRunning, getWorkerBaseUrl, resolvePluginRoot, workerHttpRequest } from '../../shared/worker-utils.js';
import { localWorkspaceRoot } from '../../utils/project-name.js';
import { restartWorkerToPickUpCloudSync } from '../install/worker-sync-restart.js';
import { marketplaceDirectory, readPluginVersion } from '../utils/paths.js';
import { buildSyncConnectionSettings, installSyncCaptureHost, log, noteDeviceCode, openBrowser, runInstallCommand, startInstallerOAuthPairing, waitForInstallerPairing } from './install.js';

const PERSONAL_PLANS = ['cloud_sync', 'pro', 'trial'];
const CAPTURE_HOSTS = ['claude-code', 'codex-cli', 'gemini-cli', 'cursor', 'opencode', 'antigravity-cli'];

export const SYNC_SETUP_HELP = 'Usage: npx claude-mem sync setup [--account <account-id>] [--agent <host>]\nConnect this local workspace to your existing cmem.ai account and sync its last 30 days of attributable user prompts.\nHosts: ' + CAPTURE_HOSTS.join(', ');

async function syncConfigured(): Promise<boolean> {
  const response = await workerHttpRequest('/api/sync/status', { timeoutMs: 30_000 });
  if (!response.ok) throw new Error(`The local worker could not verify Cloud Sync (HTTP ${response.status}).`);
  const status = z.object({ configured: z.boolean(), hub: z.object({ reachable: z.boolean().nullable() }).optional() }).parse(await response.json());
  if (status.configured === false) return false;
  if (status.configured !== true || status.hub?.reachable !== true) throw new Error('The local worker could not reach its authenticated SyncHub. Check the connection and retry.');
  return true;
}

/** Strip trial/offer parameters: the existing-entitlement route only authorizes a device. */
export function existingAccountApprovalUrl(validatedCheckoutUrl: string, pairingId: string): string {
  const url = new URL(validatedCheckoutUrl);
  url.search = '';
  url.searchParams.set('pairing', pairingId);
  return url.href;
}

async function approveExistingAccount(expected: string | undefined, configured: boolean, managed: boolean): Promise<string> {
  const pairing = await startInstallerOAuthPairing();
  if (!pairing) throw new Error('Could not start device approval with cmem.ai. Retry when connected.');
  const url = existingAccountApprovalUrl(pairing.checkoutUrl, pairing.pairingId);
  noteDeviceCode(pairing);
  console.log(`Approve this computer using your existing cmem.ai account: ${url}`);
  openBrowser(url);
  const ready = await waitForInstallerPairing(pairing, 'enrollment', readPluginVersion());
  if (ready?.kind !== 'ready' || !PERSONAL_PLANS.includes(ready.plan)) {
    throw new Error('This device needs an approved personal Cloud Sync connection.');
  }
  if (expected && ready.userId !== expected) throw new Error('The approved account differs from the account that opened setup. Open device approval with that account.');

  const saved = loadDocument(USER_SETTINGS_PATH);
  if (saved.error) throw new Error('Could not read the existing Claude-Mem settings.');
  const savedId = settingsTarget(saved.document ?? {}).CLAUDE_MEM_CLOUD_SYNC_USER_ID;
  if ([savedId, process.env.CLAUDE_MEM_CLOUD_SYNC_USER_ID].some(id => typeof id === 'string' && id.trim() && id.trim() !== ready.userId)) {
    throw new Error('This installation belongs to another Cloud Sync account. Open the workspace for the account you just approved.');
  }
  if (configured) {
    if (savedId !== ready.userId && process.env.CLAUDE_MEM_CLOUD_SYNC_USER_ID !== ready.userId) throw new Error('Could not match the approved account to this worker.');
    const attested = updateSettingsDocument(USER_SETTINGS_PATH, { CLAUDE_MEM_PRO_PLAN: ready.plan });
    if (attested.status === 'refused') throw new Error('Could not save the confirmed personal Cloud Sync plan.');
    return ready.userId;
  }
  const connection = buildSyncConnectionSettings(ready);
  if (savedId === ready.userId) {
    delete connection.CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID;
    delete connection.CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME;
  }
  const written = updateSettingsDocument(USER_SETTINGS_PATH, { ...connection, CLAUDE_MEM_PRO_PLAN: ready.plan });
  if (written.status === 'refused') throw new Error('Device approval succeeded, but the sync connection could not be saved.');
  if (!await restartWorkerToPickUpCloudSync({ log, managedExternally: managed }) || !await syncConfigured()) {
    throw new Error('The local worker has not confirmed this connection. Restart it and rerun sync setup.');
  }
  return ready.userId;
}

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const importCounts = z.object({
  eligible: count, confirmed: count, queued: count, failed: count, skippedSources: count, detectedAgents: z.array(z.string()),
});

export function importSummary(data: z.infer<typeof importCounts>): string {
  if (!importCounts.safeParse(data).success) throw new Error('The worker returned incomplete import counts. Rerun sync setup to verify.');
  const counts = data.eligible === 0 ? 'No attributable prompts in this workspace during the last 30 days.'
    : `${data.eligible} eligible prompts. ${data.confirmed} confirmed synced, ${data.queued} queued, ${data.failed} failed.`;
  return [counts, data.detectedAgents.length === 0 ? 'No supported transcript source was detected on this computer.' : '',
    data.skippedSources ? `${data.skippedSources} sources could not be read.` : ''].filter(Boolean).join(' ');
}

export async function runSyncCommand(argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) { console.log(SYNC_SETUP_HELP); return 0; }
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: { account: { type: 'string' }, agent: { type: 'string' } } });
  if (positionals.length !== 1 || positionals[0] !== 'setup' || (values.agent !== undefined && !CAPTURE_HOSTS.includes(values.agent))
    || (values.account !== undefined && !z.string().uuid().safeParse(values.account).success)) {
    console.error(SYNC_SETUP_HELP); return 1;
  }
  const workspace = realpathSync(localWorkspaceRoot(process.cwd()) ?? process.cwd());
  if ([parse(workspace).root, realpathSync(homedir())].includes(workspace)) throw new Error('Run sync setup inside the project folder you want to sync.');
  const doc = loadDocument(USER_SETTINGS_PATH);
  if (doc.error) throw new Error('Could not read the existing Claude-Mem settings.');
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH, true, { readOnly: true });
  if (settings.CLAUDE_MEM_WORKER_URL.trim() || !isLoopbackHostname(new URL(getWorkerBaseUrl({ readOnly: true })).hostname)
    || settings.CLAUDE_MEM_RUNTIME !== 'worker') throw new Error('Open a local agent workspace with a local Claude-Mem worker to import its transcripts.');
  const managed = isWorkerAutostartDisabled(settings);
  const root = resolvePluginRoot();
  if (!managed && !root) await runInstallCommand({ setup: 'defer' });
  else if (!managed && root?.version && compareVersionsDescending(readPluginVersion(), root.version) < 0) await runInstallCommand({ update: true });
  if (process.exitCode || !await ensureWorkerRunning()) throw new Error('The local Claude-Mem worker did not start. Run npx claude-mem doctor and retry.');
  // A host chosen on the receipt, or one identifying its own shell, is a reliable install target.
  // Never turn on hooks in every app that happened to leave transcripts on disk.
  const host = values.agent ?? (process.env.CODEX_THREAD_ID ? 'codex-cli'
    : process.env.CLAUDECODE === '1' ? 'claude-code' : process.env.CURSOR_AGENT ? 'cursor' : undefined);
  const configured = await syncConfigured();
  const hasPersonalConnection = configured && PERSONAL_PLANS.includes(settings.CLAUDE_MEM_PRO_PLAN);
  const account = hasPersonalConnection && values.account ? values.account : await approveExistingAccount(values.account, configured, managed);
  console.log('Checking this workspace’s last 30 days of prompts…');
  const response = await workerHttpRequest('/api/sync/setup/import-prompts', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspace, expectedAccount: account }), timeoutMs: 0,
  });
  if (!response.ok) {
    if (response.status === 404) throw new Error('Update your local worker with npx claude-mem@latest update, then run sync setup again.');
    if (response.status === 403 || response.status === 409) throw new Error('The worker could not authorize this import. Check your personal Cloud Sync account and retry.');
    throw new Error(`The workspace import did not finish (HTTP ${response.status}). Rerun sync setup to verify.`);
  }
  const counts = importCounts.parse(await response.json());
  console.log(importSummary(counts));
  if (host && (values.agent || !root)) {
    const needsLocalPlugin = managed && (!root || (host === 'codex-cli' &&
      !existsSync(join(marketplaceDirectory(), '.agents', 'plugins', 'marketplace.json'))));
    if (needsLocalPlugin) {
      console.log('Future capture still needs the local agent plugin. Run npx --yes claude-mem@latest install --setup defer --no-auto-start, then rerun this sync setup command with --agent ' + host + '.');
    } else {
      await installSyncCaptureHost(host);
    }
  }
  if (!root && !host) {
    console.log('For future sessions, rerun sync setup with --agent and your host: ' + CAPTURE_HOSTS.join(', ') + '.');
  }
  return counts.failed || counts.skippedSources ? 1 : 0;
}
