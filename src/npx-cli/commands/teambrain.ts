/**
 * `npx claude-mem teambrain <join|start|status|share|leave>`: join a team from
 * the terminal, choose what to share with it, check it, and leave it.
 *
 * Joining reuses the installer's browser pairing (source `teambrain_join`,
 * carrying the invite token in the start request's body). The ready poll
 * delivers this account's cloud sync connection, which TeamBrain also signs
 * its requests with. A seat-only account has no CMEM Pro observer, so joining
 * never touches the observer or provider settings: it writes the sync keys,
 * the device name and the two TeamBrain keys, and nothing else.
 *
 * One sync account per install: an install that already syncs as another
 * account is refused, never switched.
 */

import * as p from '@clack/prompts';
import { parseArgs, styleText } from 'node:util';
import { hostname } from 'os';
import { cmemProOrigin } from '../../shared/cmem-gateway.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { SettingsDefaultsManager, type SettingsDefaults } from '../../shared/SettingsDefaultsManager.js';
import { shouldTrackProject } from '../../shared/should-track-project.js';
import {
  fetchTeamBrainStatus,
  leaveTeamBrainTeam,
  teamBrainConnection,
  teamBrainStartUrl,
  updateTeamBrainMembership,
  type TeamBrainConnection,
  type TeamBrainMembership,
  type TeamBrainTeamRef,
} from '../../shared/teambrain.js';
import { workerHttpRequest } from '../../shared/worker-utils.js';
import { getProjectContext } from '../../utils/project-name.js';
import {
  buildSyncConnectionSettings,
  lastOAuthStartFailure,
  log,
  mergeSettings,
  noteDeviceCode,
  openBrowser,
  startInstallerOAuthPairing,
  waitForInstallerPairing,
  waitForReturnToOpenBrowser,
  type TrialReadyResult,
} from './install.js';

declare const __DEFAULT_PACKAGE_VERSION__: string;
const CLI_VERSION = typeof __DEFAULT_PACKAGE_VERSION__ !== 'undefined' ? __DEFAULT_PACKAGE_VERSION__ : '0.0.0-dev';

const isInteractive = process.stdin.isTTY === true;

const TEAMBRAIN_REQUEST_TIMEOUT_MS = 15_000;
const WORKER_REQUEST_TIMEOUT_MS = 5_000;
/** How long `join` waits for the restarted worker to report cloud sync. */
const WORKER_RESTART_WAIT_MS = 30_000;
const WORKER_RESTART_POLL_MS = 1_000;
const MAX_LISTED_PROJECTS = 40;
const SHARE_ALL_OPTION = '__teambrain_all_projects__';

/** Invite tokens are URL-safe; the server checks the exact shape. */
const INVITE_TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;

const USAGE = [
  `Usage: ${styleText('bold', 'npx claude-mem teambrain <command>')}`,
  '  join <invite-link>  Join a team: sign in in the browser, then choose which projects to share',
  '                      (without a terminal: --share <a,b> or --share-all)',
  '  start               Create a team on cmem.ai (opens the browser)',
  '  status              Show your teams and what this install shares (the default)',
  '  share               Choose again which projects you share (--share <a,b>, --share-all, --team <id>)',
  '  leave [team-id]     Leave a team; TeamBrain removes what you shared with it',
].join('\n');

export type InviteParse = { ok: true; token: string } | { ok: false; error: string };

/**
 * An invite link (`https://cmem.ai/teambrain/app#invite=<token>`) or the bare
 * token. A link must point at the host this install pairs with: the pairing,
 * and so the sync token it delivers, go to that host only.
 */
export function parseTeamBrainInvite(input: string | undefined, origin: string = cmemProOrigin()): InviteParse {
  const example = `${origin}/teambrain/app#invite=…`;
  const value = (input ?? '').trim();
  if (!value) return { ok: false, error: `Pass the invite link your team owner sent: npx claude-mem teambrain join <invite-link> (it looks like ${example})` };
  if (INVITE_TOKEN_SHAPE.test(value)) return { ok: true, token: value };

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, error: `That is not a TeamBrain invite link or token. Invite links look like ${example}` };
  }
  const token = new URLSearchParams(url.hash.replace(/^#/, '')).get('invite')?.trim() ?? '';
  if (!INVITE_TOKEN_SHAPE.test(token)) {
    return { ok: false, error: `That link carries no TeamBrain invite. Invite links look like ${example}` };
  }
  const expectedOrigin = new URL(origin).origin;
  if (url.origin !== expectedOrigin) {
    return {
      ok: false,
      error: `This invite is for ${url.origin}, but this install signs in to ${expectedOrigin}. `
        + `One install talks to one host; to join a team hosted at ${url.origin}, run this command with CMEM_PRO_ORIGIN=${url.origin}.`,
    };
  }
  return { ok: true, token };
}

export type ShareChoice =
  | { kind: 'all' }
  | { kind: 'projects'; projects: string[] }
  | { kind: 'none' };

/** --share <a,b> / --share-all. Null when neither was given. */
export function parseShareFlags(values: { share?: string; shareAll?: boolean }): { ok: true; choice: ShareChoice | null } | { ok: false; error: string } {
  if (values.shareAll && values.share !== undefined) {
    return { ok: false, error: 'Pass --share <projects> or --share-all, not both.' };
  }
  if (values.shareAll) return { ok: true, choice: { kind: 'all' } };
  if (values.share === undefined) return { ok: true, choice: null };
  const projects = [...new Set(values.share.split(',').map(project => project.trim()).filter(Boolean))];
  if (projects.length === 0) return { ok: false, error: '--share needs at least one project name, e.g. --share my-app,api' };
  return { ok: true, choice: { kind: 'projects', projects } };
}

/** The membership change a share choice makes. */
export function membershipForChoice(choice: ShareChoice): { broadcasting: boolean; projects: string[] | null } {
  if (choice.kind === 'all') return { broadcasting: true, projects: null };
  if (choice.kind === 'none') return { broadcasting: false, projects: [] };
  return { broadcasting: true, projects: choice.projects };
}

/**
 * Null when this install may join as `joiningUserId`, else why not. An
 * install whose sync identity is another account keeps it: switching would
 * push memory pulled from that account into the new one.
 */
export function differentSyncAccountRefusal(existingUserId: string, joiningUserId: string, origin: string = cmemProOrigin()): string | null {
  const current = existingUserId.trim();
  if (!current || current === joiningUserId) return null;
  return [
    `This install already syncs memory as another cmem.ai account (user ${current}); you signed in as user ${joiningUserId}.`,
    'One install syncs one account, so nothing on this install was changed.',
    'To join from here, run the join again and sign in with the account this install already syncs.',
    `If the browser account was added to the team, you can leave it at ${origin}/teambrain/app.`,
  ].join('\n');
}

/** The TeamBrain base URL from the ready body, else the host this install paired with. */
export function resolveTeamBrainUrl(fromServer: string | null, origin: string = cmemProOrigin()): { ok: true; url: string } | { ok: false; error: string } {
  const candidate = (fromServer ?? origin).trim();
  try {
    const url = new URL(candidate);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
      return { ok: false, error: `cmem.ai named a TeamBrain address that is not a plain http(s) URL (${url.protocol}).` };
    }
    return { ok: true, url: candidate.replace(/\/+$/, '') };
  } catch {
    return { ok: false, error: 'cmem.ai named a TeamBrain address that is not a URL.' };
  }
}

/**
 * The settings a join writes: the sync connection the way the installer
 * writes it, and the TeamBrain keys. An install that already syncs this same
 * account keeps its device id and name, so the hub does not see a new device.
 * Observer and provider keys are never part of it.
 */
export function buildTeamBrainJoinSettings(
  ready: Pick<TrialReadyResult, 'userId' | 'setupToken' | 'hubUrl'>,
  existing: Pick<SettingsDefaults, 'CLAUDE_MEM_CLOUD_SYNC_USER_ID'>,
  join: { teambrainUrl: string; teamId: string },
  deviceName: string = hostname(),
): Record<string, string> {
  const syncConnection = buildSyncConnectionSettings(ready, deviceName);
  if (existing.CLAUDE_MEM_CLOUD_SYNC_USER_ID.trim() === ready.userId) {
    delete syncConnection.CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID;
    delete syncConnection.CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME;
  }
  return {
    ...syncConnection,
    CLAUDE_MEM_TEAMBRAIN_URL: join.teambrainUrl,
    CLAUDE_MEM_TEAMBRAIN_TEAM_ID: join.teamId,
  };
}

function readSettings(): SettingsDefaults {
  return SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH, true, { readOnly: true });
}

function syncConnectionChanged(existing: SettingsDefaults, ready: Pick<TrialReadyResult, 'userId' | 'setupToken' | 'hubUrl'>): boolean {
  return existing.CLAUDE_MEM_CLOUD_SYNC_TOKEN.trim() !== ready.setupToken
    || existing.CLAUDE_MEM_CLOUD_SYNC_USER_ID.trim() !== ready.userId
    || existing.CLAUDE_MEM_CLOUD_SYNC_HUB_URL.trim().replace(/\/+$/, '') !== ready.hubUrl.replace(/\/+$/, '');
}

function startFailureMessage(): string {
  switch (lastOAuthStartFailure()) {
    case 'http_error':
      return 'cmem.ai did not accept the join request. The invite may have expired or run out of uses: ask the team owner for a new invite link.';
    case 'bad_body':
      return 'cmem.ai sent an unexpected answer to the join request. Update claude-mem (npx claude-mem update) and try again.';
    case 'timeout':
      return `${cmemProOrigin()} did not answer in time. Check your connection and run the join again.`;
    default:
      return `Could not reach ${cmemProOrigin()}. Check your connection and run the join again.`;
  }
}

function describeSharing(team: TeamBrainMembership): string {
  if (!team.broadcasting) return 'not sharing';
  if (team.projects === null) return 'sharing all projects';
  if (team.projects.length === 0) return 'sharing no projects';
  return `sharing ${team.projects.join(', ')}`;
}

function describeChoice(choice: ShareChoice): string {
  if (choice.kind === 'all') return 'all projects (including new ones)';
  if (choice.kind === 'none') return 'no projects';
  return choice.projects.join(', ');
}

function describeTeam(team: TeamBrainMembership, isInstallTeam: boolean): string {
  const seats = team.seatsUsed !== null && team.seatLimit !== null ? ` · ${team.seatsUsed} of ${team.seatLimit} seats` : '';
  const marker = isInstallTeam ? styleText('dim', '  (this install)') : '';
  return `  ${styleText('bold', team.name)} ${styleText('dim', `(id ${team.id})`)} · ${team.role} · ${describeSharing(team)}${seats}${marker}`;
}

/** This checkout's project keys (a worktree reads its parent's too), unless the folder is excluded. */
function checkoutProjects(): string[] {
  const cwd = process.cwd();
  if (!shouldTrackProject(cwd)) return [];
  return getProjectContext(cwd).allProjects;
}

async function listLocalProjects(): Promise<{ ok: true; projects: string[] } | { ok: false; reason: string }> {
  try {
    const response = await workerHttpRequest('/api/projects', { timeoutMs: WORKER_REQUEST_TIMEOUT_MS });
    if (!response.ok) return { ok: false, reason: `the worker answered HTTP ${response.status}` };
    const body = await response.json() as { projects?: unknown };
    if (!Array.isArray(body.projects)) return { ok: false, reason: 'the worker sent no project list' };
    return { ok: true, projects: body.projects.filter((project): project is string => typeof project === 'string' && project.trim() !== '') };
  } catch (error: unknown) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** TTY only: a multi-select of local projects, defaulting to what is shared now, else this checkout. */
async function promptShareChoice(teamName: string, current: TeamBrainMembership | null): Promise<ShareChoice | null> {
  const checkout = checkoutProjects();
  const listed = await listLocalProjects();
  if (!listed.ok) {
    log.warn(`Could not read your project list from the claude-mem worker (${listed.reason}); listing this checkout's projects only.`);
  }
  const sharedNow = current?.broadcasting && current.projects ? current.projects : [];
  const projects = [...new Set([...checkout, ...sharedNow, ...(listed.ok ? listed.projects.slice(0, MAX_LISTED_PROJECTS) : [])])];
  const initialValues = current?.broadcasting
    ? (current.projects === null ? [SHARE_ALL_OPTION] : current.projects)
    : checkout;

  const picked = await p.multiselect<string>({
    message: `Share which projects with ${teamName}? Teammates see observations from them, from now on.`,
    options: [
      { value: SHARE_ALL_OPTION, label: 'All projects, including new ones' },
      ...projects.map(project => (checkout.includes(project) ? { value: project, label: project, hint: 'this checkout' } : { value: project, label: project })),
    ],
    initialValues,
    required: false,
    maxItems: 12,
  });
  if (p.isCancel(picked)) return null;
  if (picked.includes(SHARE_ALL_OPTION)) return { kind: 'all' };
  if (picked.length === 0) return { kind: 'none' };
  return { kind: 'projects', projects: picked };
}

async function applyShareChoice(connection: TeamBrainConnection, team: TeamBrainTeamRef, choice: ShareChoice): Promise<boolean> {
  const result = await updateTeamBrainMembership(connection, { teamId: team.id, ...membershipForChoice(choice) }, TEAMBRAIN_REQUEST_TIMEOUT_MS);
  if (!result.ok) {
    log.error(`Could not update what you share with ${team.name}: ${result.reason}`);
    return false;
  }
  log.success(choice.kind === 'none'
    ? `Not sharing any projects with ${team.name}.`
    : `Sharing ${describeChoice(choice)} with ${team.name}.`);
  return true;
}

async function workerHealth(): Promise<{ pid: number | null } | null> {
  try {
    const response = await workerHttpRequest('/api/health', { timeoutMs: WORKER_REQUEST_TIMEOUT_MS });
    if (!response.ok && response.status !== 503) return null;
    const body = await response.json().catch(() => ({})) as { pid?: unknown };
    return { pid: typeof body.pid === 'number' ? body.pid : null };
  } catch {
    // Nothing listening: the worker is not running.
    return null;
  }
}

async function workerSyncStatus(): Promise<{ configured: boolean; hubError: string | null } | null> {
  try {
    const response = await workerHttpRequest('/api/sync/status', { timeoutMs: WORKER_REQUEST_TIMEOUT_MS });
    if (!response.ok) return null;
    const body = await response.json() as { configured?: unknown; hub?: { reachable?: unknown; error?: unknown } };
    const hubError = body.hub && body.hub.reachable === false
      ? (typeof body.hub.error === 'string' && body.hub.error ? body.hub.error : 'unreachable')
      : null;
    return { configured: body.configured === true, hubError };
  } catch {
    // Still restarting.
    return null;
  }
}

/**
 * The worker reads the sync connection when it starts, so a new one needs a
 * restart (the cloud-sync skill's step 3: POST /api/admin/restart, then poll
 * /api/sync/status). A worker that is not running picks it up when it starts.
 */
async function restartWorkerForCloudSync(): Promise<void> {
  const before = await workerHealth();
  if (!before) {
    log.info('The claude-mem worker is not running; cloud sync starts with it (npx claude-mem start).');
    return;
  }
  try {
    const response = await workerHttpRequest('/api/admin/restart', { method: 'POST', timeoutMs: WORKER_REQUEST_TIMEOUT_MS });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error: unknown) {
    log.warn(`Could not restart the claude-mem worker (${error instanceof Error ? error.message : String(error)}). Restart it so cloud sync starts: npx claude-mem restart`);
    return;
  }

  const deadline = Date.now() + WORKER_RESTART_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, WORKER_RESTART_POLL_MS));
    const health = await workerHealth();
    if (!health || (before.pid !== null && health.pid === before.pid)) continue;
    const sync = await workerSyncStatus();
    if (!sync?.configured) continue;
    if (sync.hubError) log.warn(`Cloud sync is set up, but the sync hub did not answer yet: ${sync.hubError}`);
    else log.success('Cloud sync is on: this install syncs to your account.');
    return;
  }
  log.warn('The worker restarted, but cloud sync has not reported in yet. Check it with: npx claude-mem doctor');
}

async function chooseTeam(
  connection: TeamBrainConnection,
  requestedTeamId: string | undefined,
): Promise<{ team: TeamBrainMembership; teams: TeamBrainMembership[] } | null> {
  const status = await fetchTeamBrainStatus(connection, TEAMBRAIN_REQUEST_TIMEOUT_MS);
  if (!status.ok) {
    log.error(`Could not read your TeamBrain teams: ${status.reason}`);
    return null;
  }
  const teams = status.value;
  const wanted = requestedTeamId?.trim() || connection.teamId;
  const team = wanted ? teams.find(candidate => candidate.id === wanted) : teams.length === 1 ? teams[0] : undefined;
  if (team) return { team, teams };
  if (teams.length === 0) {
    log.error('This account is not in a TeamBrain team. Join one with: npx claude-mem teambrain join <invite-link>');
  } else if (wanted) {
    log.error(`This account is not in team ${wanted}. Its teams:\n${teams.map(candidate => describeTeam(candidate, false)).join('\n')}`);
  } else {
    log.error(`This account is in several teams; name one with --team <id>:\n${teams.map(candidate => describeTeam(candidate, false)).join('\n')}`);
  }
  return null;
}

function requireJoined(settings: SettingsDefaults): TeamBrainConnection | null {
  const connection = teamBrainConnection(settings);
  if (!connection) {
    log.error('This install has not joined a TeamBrain team. Join one: npx claude-mem teambrain join <invite-link> (or start one: npx claude-mem teambrain start)');
  }
  return connection;
}

async function runJoin(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { share: { type: 'string' }, 'share-all': { type: 'boolean' } },
    allowPositionals: true,
    strict: true,
  });
  const invite = parseTeamBrainInvite(positionals[0]);
  if (!invite.ok) {
    log.error(invite.error);
    return 1;
  }
  const shareFlags = parseShareFlags({ share: values.share, shareAll: values['share-all'] === true });
  if (!shareFlags.ok) {
    log.error(shareFlags.error);
    return 1;
  }

  const pairing = await startInstallerOAuthPairing({ source: 'teambrain_join', teamInvite: invite.token });
  if (!pairing) {
    log.error(startFailureMessage());
    return 1;
  }
  log.info(`Sign in to join the team: ${pairing.authorizationUrl}`);
  noteDeviceCode(pairing);
  if (isInteractive) {
    await waitForReturnToOpenBrowser('Hit return to open it in your browser…');
    openBrowser(pairing.authorizationUrl);
  } else {
    log.info('AGENT: show this link to the user. This command waits until they finish signing in.');
  }

  const outcome = await waitForInstallerPairing(pairing, 'teambrain_join', CLI_VERSION);
  if (!outcome || outcome.kind !== 'ready') return 1;

  const existing = readSettings();
  const refusal = differentSyncAccountRefusal(existing.CLAUDE_MEM_CLOUD_SYNC_USER_ID, outcome.userId);
  if (refusal) {
    log.error(refusal);
    return 1;
  }
  const teambrainUrl = resolveTeamBrainUrl(outcome.teambrainUrl);
  if (!teambrainUrl.ok) {
    log.error(teambrainUrl.error);
    return 1;
  }

  // The connection works before it is saved, so the team can be confirmed first.
  const connection: TeamBrainConnection = {
    teambrainUrl: teambrainUrl.url,
    syncToken: outcome.setupToken,
    syncUserId: outcome.userId,
    teamId: outcome.team?.id ?? '',
  };
  let team: TeamBrainTeamRef | null = outcome.team;
  let membership: TeamBrainMembership | null = null;
  if (!team) {
    const chosen = await chooseTeam(connection, undefined);
    if (!chosen) return 1;
    team = chosen.team;
    membership = chosen.team;
    connection.teamId = team.id;
  }

  const restartNeeded = syncConnectionChanged(existing, outcome);
  if (!mergeSettings(buildTeamBrainJoinSettings(outcome, existing, { teambrainUrl: connection.teambrainUrl, teamId: team.id }))) {
    return 1;
  }
  log.success(`Joined ${team.name}. Your memory stays private; you choose what the team sees.`);

  const choice = shareFlags.choice ?? (isInteractive ? await promptShareChoice(team.name, membership) : null);
  if (choice) {
    if (!await applyShareChoice(connection, team, choice)) return 1;
  } else {
    log.info('Not sharing any projects yet. Choose them with: npx claude-mem teambrain share');
  }

  if (restartNeeded) await restartWorkerForCloudSync();
  log.info('Your next session starts with the team brief, and agents can use the team_search tool. Check anytime: npx claude-mem teambrain status');
  return 0;
}

async function runShare(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { share: { type: 'string' }, 'share-all': { type: 'boolean' }, team: { type: 'string' } },
    allowPositionals: false,
    strict: true,
  });
  const shareFlags = parseShareFlags({ share: values.share, shareAll: values['share-all'] === true });
  if (!shareFlags.ok) {
    log.error(shareFlags.error);
    return 1;
  }
  if (!shareFlags.choice && !isInteractive) {
    log.error('Without a terminal, name what to share: npx claude-mem teambrain share --share <a,b> (or --share-all)');
    return 1;
  }
  const connection = requireJoined(readSettings());
  if (!connection) return 1;
  const chosen = await chooseTeam(connection, values.team);
  if (!chosen) return 1;

  const choice = shareFlags.choice ?? await promptShareChoice(chosen.team.name, chosen.team);
  if (!choice) {
    log.info('Nothing changed.');
    return 0;
  }
  return await applyShareChoice(connection, chosen.team, choice) ? 0 : 1;
}

async function runStatus(): Promise<number> {
  const settings = readSettings();
  const connection = teamBrainConnection(settings);
  if (!connection) {
    console.log(`${styleText('bold', 'TeamBrain:')} not joined on this install`);
    console.log(`  Start a team:  ${styleText('cyan', 'npx claude-mem teambrain start')}`);
    console.log(`  Join a team:   ${styleText('cyan', 'npx claude-mem teambrain join <invite-link>')}`);
    return 0;
  }
  console.log(`${styleText('bold', 'TeamBrain:')} ${connection.teambrainUrl}`);
  const status = await fetchTeamBrainStatus(connection, TEAMBRAIN_REQUEST_TIMEOUT_MS);
  if (!status.ok) {
    console.error(styleText('red', `Could not read your teams: ${status.reason}`));
    return 1;
  }
  if (status.value.length === 0) {
    console.log('  This account is not in a team. Join one: npx claude-mem teambrain join <invite-link>');
    return 0;
  }
  for (const team of status.value) console.log(describeTeam(team, team.id === connection.teamId));
  console.log(styleText('dim', 'Change what you share: npx claude-mem teambrain share'));
  return 0;
}

async function runLeave(argv: string[]): Promise<number> {
  const { positionals } = parseArgs({ args: argv, options: {}, allowPositionals: true, strict: true });
  const connection = requireJoined(readSettings());
  if (!connection) return 1;

  const status = await fetchTeamBrainStatus(connection, TEAMBRAIN_REQUEST_TIMEOUT_MS);
  const teams = status.ok ? status.value : null;
  const namedTeamId = positionals[0]?.trim() ?? '';
  const teamId = namedTeamId || connection.teamId || (teams?.length === 1 ? teams[0].id : '');
  if (!teamId) {
    log.error(status.ok
      ? 'Name the team to leave: npx claude-mem teambrain leave <team-id> (see npx claude-mem teambrain status)'
      : `Could not read your teams to find the one to leave: ${status.reason}`);
    return 1;
  }
  const team = teams?.find(candidate => candidate.id === teamId);
  const teamName = team?.name ?? `team ${teamId}`;

  if (teams && !team) {
    if (namedTeamId) {
      log.error(`This account is not in team ${teamId}.${teams.length > 0 ? ` Its teams:\n${teams.map(candidate => describeTeam(candidate, false)).join('\n')}` : ''}`);
      return 1;
    }
    // This install's team is already gone on the server (left in the web app,
    // or removed by its owner): only this install still points at it.
    log.info(`This account is no longer in ${teamName}; removing it from this install.`);
  } else {
    if (isInteractive) {
      const confirmed = await p.confirm({ message: `Leave ${teamName}? TeamBrain removes what you shared with it.`, initialValue: false });
      if (p.isCancel(confirmed) || !confirmed) {
        log.info('Still in the team. Nothing changed.');
        return 0;
      }
    }
    const left = await leaveTeamBrainTeam(connection, teamId, TEAMBRAIN_REQUEST_TIMEOUT_MS);
    if (!left.ok) {
      log.error(`Could not leave ${teamName}: ${left.reason}`);
      return 1;
    }
    log.success(`Left ${teamName}.`);
  }

  // What this install points at next: the team it is still in, or nothing.
  const remaining = teams?.filter(team => team.id !== teamId) ?? null;
  const updates: Record<string, string> = remaining === null
    ? (connection.teamId === teamId ? { CLAUDE_MEM_TEAMBRAIN_TEAM_ID: '' } : {})
    : remaining.length === 0
      ? { CLAUDE_MEM_TEAMBRAIN_URL: '', CLAUDE_MEM_TEAMBRAIN_TEAM_ID: '' }
      : (connection.teamId === teamId || !connection.teamId ? { CLAUDE_MEM_TEAMBRAIN_TEAM_ID: remaining[0].id } : {});
  if (Object.keys(updates).length > 0 && !mergeSettings(updates)) return 1;

  if (remaining && remaining.length > 0) {
    log.info(`Still in: ${remaining.map(team => team.name).join(', ')}.`);
  }
  log.info('Your private memory and cloud sync settings are unchanged.');
  return 0;
}

function runStart(): number {
  const url = teamBrainStartUrl(cmemProOrigin());
  const headless = !process.stdout.isTTY || Boolean(process.env.CI)
    || Boolean(process.env.SSH_CONNECTION || process.env.SSH_TTY)
    || (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY);
  console.log(`Create your team's TeamBrain: ${styleText('cyan', url)}`);
  if (headless) {
    console.log('Open that link in a browser to continue.');
  } else {
    openBrowser(url);
  }
  return 0;
}

/** Resolves to the process exit code. */
export async function runTeamBrainCommand(argv: string[] = []): Promise<number> {
  const subCommand = argv[0]?.toLowerCase() ?? 'status';
  if (argv.slice(1).some(arg => arg === '--help' || arg === '-h')) {
    console.log(USAGE);
    return 0;
  }
  try {
    switch (subCommand) {
      case 'join':
        return await runJoin(argv.slice(1));
      case 'start':
        return runStart();
      case 'status':
        return await runStatus();
      case 'share':
        return await runShare(argv.slice(1));
      case 'leave':
        return await runLeave(argv.slice(1));
      case 'help':
      case '--help':
      case '-h':
        console.log(USAGE);
        return 0;
      default:
        console.error(styleText('red', `Unknown teambrain command: ${subCommand}`));
        console.error(USAGE);
        return 1;
    }
  } catch (error: unknown) {
    // parseArgs rejects unknown or malformed flags with a TypeError naming them.
    if (error instanceof TypeError && 'code' in error && String((error as { code?: unknown }).code).startsWith('ERR_PARSE_ARGS')) {
      console.error(styleText('red', error.message));
      console.error(USAGE);
      return 1;
    }
    throw error;
  }
}
