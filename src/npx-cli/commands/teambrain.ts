/**
 * `npx claude-mem teambrain <join|start|status|share|leave>`: join a team from
 * the terminal, choose what to share with it, check it, and leave it.
 *
 * Joining reuses the installer's browser pairing (source `teambrain_join`,
 * carrying the invite token in the start request's body). The invite is
 * redeemed when the user approves this device on the page, which names the
 * team. The ready poll delivers this account's cloud sync connection, which
 * TeamBrain also signs its requests with. A seat-only account has no CMEM Pro
 * observer, so joining never touches the observer or provider settings: it
 * writes the sync keys, the device name, the plan the sign-in reported and the
 * two TeamBrain keys, and nothing else.
 *
 * One sync account per install: an install that already syncs as another
 * account is refused, never switched, and a settings file this command cannot
 * read is never written over or moved aside.
 */

import * as p from '@clack/prompts';
import { existsSync } from 'fs';
import { parseArgs, styleText } from 'node:util';
import { hostname } from 'os';
import { readJsonFileWithBom } from '../../shared/atomic-json.js';
import { cmemProOrigin } from '../../shared/cmem-gateway.js';
import { isConnectionRefusedError } from '../../shared/connection-errors.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { relayedLine } from '../../shared/relayed-text.js';
import { SettingsDefaultsManager, type SettingsDefaults } from '../../shared/SettingsDefaultsManager.js';
import { updateSettingsDocument } from '../../shared/settings-document.js';
import { shouldTrackProject } from '../../shared/should-track-project.js';
import {
  fetchTeamBrainStatus,
  leaveTeamBrainTeam,
  parseUrl,
  teamBrainConnection,
  teamBrainStartUrl,
  teamBrainUrlProblem,
  updateTeamBrainMembership,
  type TeamBrainConnection,
  type TeamBrainMembership,
  type TeamBrainResult,
  type TeamBrainTeamRef,
} from '../../shared/teambrain.js';
import { workerHttpRequest } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import { getProjectContext } from '../../utils/project-name.js';
import {
  buildSyncConnectionSettings,
  lastOAuthStartFailure,
  log,
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
/** How long `join` and `leave` wait for the restarted worker to report its sync state. */
const WORKER_RESTART_WAIT_MS = 30_000;
const WORKER_RESTART_POLL_MS = 1_000;
const MAX_LISTED_PROJECTS = 40;
const SHARE_ALL_OPTION = '__teambrain_all_projects__';

/** Invite tokens are URL-safe; the server checks the exact shape. */
const INVITE_TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;

/** The sync connection a seat-only account loses with its last team. */
const SYNC_DISCONNECTED: Record<string, string> = {
  CLAUDE_MEM_CLOUD_SYNC_TOKEN: '',
  CLAUDE_MEM_CLOUD_SYNC_USER_ID: '',
  CLAUDE_MEM_CLOUD_SYNC_HUB_URL: '',
  CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: '',
  CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME: '',
  CLAUDE_MEM_PRO_PLAN: '',
};

const TEAMBRAIN_OFF: Record<string, string> = {
  CLAUDE_MEM_TEAMBRAIN_URL: '',
  CLAUDE_MEM_TEAMBRAIN_TEAM_ID: '',
};

const USAGE = [
  `Usage: ${styleText('bold', 'npx claude-mem teambrain <command>')}`,
  '  join <invite-link>  Join a team: sign in, approve this device on the page, then choose which projects to share',
  '                      (without a terminal: --share <a,b> or --share-all)',
  '  start               Create a team on cmem.ai (opens the browser)',
  '  status              Show your teams and what this install shares (the default)',
  '  share               Choose again which projects you share (--share <a,b>, --share-all, --team <id>)',
  '  leave [team-id]     Leave a team; TeamBrain removes what you shared with it',
].join('\n');

/** A server- or user-supplied name, safe to print: one line, no control or escape characters. */
function printable(value: string): string {
  return relayedLine(value);
}

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

  const url = parseUrl(value);
  if (!url) return { ok: false, error: `That is not a TeamBrain invite link or token. Invite links look like ${example}` };
  const token = new URLSearchParams(url.hash.replace(/^#/, '')).get('invite')?.trim() ?? '';
  if (!INVITE_TOKEN_SHAPE.test(token)) {
    return { ok: false, error: `That link carries no TeamBrain invite. Invite links look like ${example}` };
  }
  const expected = parseUrl(origin);
  if (!expected) return { ok: false, error: `CMEM_PRO_ORIGIN (${printable(origin)}) is not a valid URL.` };
  if (url.origin !== expected.origin) {
    return {
      ok: false,
      error: `This invite is for ${url.origin}, but this install signs in to ${expected.origin}. `
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
 * Null when this install may join as `joiningUserId`, else why not. The ids
 * are the sync user id as saved in settings.json and as the environment
 * leaves it, so an exported variable cannot hide the account the file syncs.
 * An install whose sync identity is another account keeps it: switching would
 * push memory pulled from that account into the new one.
 */
export function differentSyncAccountRefusal(
  existingUserIds: readonly string[],
  joiningUserId: string,
  origin: string = cmemProOrigin(),
): string | null {
  const other = existingUserIds.map(userId => userId.trim()).find(userId => userId !== '' && userId !== joiningUserId);
  if (!other) return null;
  return [
    `This install already syncs memory as another cmem.ai account (user ${printable(other)}); you signed in as user ${printable(joiningUserId)}.`,
    'One install syncs one account, so nothing on this install was changed.',
    'To join from here, run the join again and sign in with the account this install already syncs.',
    `If the browser account was added to the team, you can leave it at ${origin}/teambrain/app.`,
  ].join('\n');
}

/**
 * The TeamBrain base URL from the ready body, else the host this install
 * paired with. It receives the sync token, so it must be https, except plain
 * http to localhost or to the exact CMEM_PRO_ORIGIN (teamBrainUrlProblem).
 */
export function resolveTeamBrainUrl(
  fromServer: string | null,
  origin: string = cmemProOrigin(),
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; url: string } | { ok: false; error: string } {
  const candidate = (fromServer ?? origin).trim();
  const url = parseUrl(candidate);
  if (!url) return { ok: false, error: `The TeamBrain address (${printable(candidate)}) is not a URL.` };
  const problem = teamBrainUrlProblem(url, env);
  if (problem) {
    return { ok: false, error: `The TeamBrain address (${printable(candidate)}) ${problem}, so this install will not send its sync token there.` };
  }
  return { ok: true, url: candidate.replace(/\/+$/, '') };
}

/**
 * The settings a join writes: the sync connection the way the installer
 * writes it, the plan the sign-in reported (a seat-only account loses sync
 * when it leaves its last team; Pro keeps it), and the TeamBrain keys. An
 * install that already syncs this same account keeps its device id and name,
 * so the hub does not see a new device. Observer and provider keys are never
 * part of it.
 */
export function buildTeamBrainJoinSettings(
  ready: Pick<TrialReadyResult, 'userId' | 'setupToken' | 'hubUrl' | 'plan'>,
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
    CLAUDE_MEM_PRO_PLAN: ready.plan,
    CLAUDE_MEM_TEAMBRAIN_URL: join.teambrainUrl,
    CLAUDE_MEM_TEAMBRAIN_TEAM_ID: join.teamId,
  };
}

/**
 * Why settings.json cannot be read as a settings object, or null when it can
 * (or does not exist yet). A join or leave stops on it rather than writing
 * over the file or moving it aside.
 */
export function unreadableSettingsProblem(path: string = USER_SETTINGS_PATH): string | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = readJsonFileWithBom<unknown>(path);
  } catch (error: unknown) {
    const cause = error instanceof Error ? error : new Error(String(error));
    logger.warn('SETTINGS', 'settings.json could not be parsed', { path }, cause);
    return `${path} could not be read (${printable(cause.message)})`;
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? null
    : `${path} does not hold a JSON object`;
}

function settingsFileProblemMessage(problem: string, command: string): string {
  return `${problem}. Fix or remove it, then run ${command} again; claude-mem will not write over a settings file it cannot read.`;
}

/** Settings as the worker sees them: settings.json with environment overrides. */
function readEffectiveSettings(): SettingsDefaults {
  return SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH, true, { readOnly: true });
}

/** Settings exactly as saved in settings.json. */
function readSavedSettings(): SettingsDefaults {
  return SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH, false, { readOnly: true });
}

/**
 * Merge `updates` into settings.json. The installer's recovery (moving an
 * unreadable file aside) is never used here: such a write is refused, and the
 * reason returned. Null when the write landed.
 */
function writeSettings(updates: Record<string, string>): string | null {
  const result = updateSettingsDocument(USER_SETTINGS_PATH, updates);
  if (result.status !== 'refused') return null;
  const cause = result.error instanceof Error ? result.error : new Error(String(result.error));
  logger.warn('SETTINGS', 'TeamBrain settings could not be saved', { path: USER_SETTINGS_PATH }, cause);
  return `${USER_SETTINGS_PATH} could not be updated (${printable(cause.message)})`;
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

function describeProjects(projects: readonly string[]): string {
  return projects.map(printable).join(', ');
}

function describeSharing(team: TeamBrainMembership): string {
  if (!team.broadcasting) return 'not sharing';
  if (team.projects === null) return 'sharing all projects';
  if (team.projects.length === 0) return 'sharing no projects';
  return `sharing ${describeProjects(team.projects)}`;
}

function describeChoice(choice: ShareChoice): string {
  if (choice.kind === 'all') return 'all projects (including new ones)';
  if (choice.kind === 'none') return 'no projects';
  return describeProjects(choice.projects);
}

function describeTeam(team: TeamBrainMembership, isInstallTeam: boolean): string {
  const seats = team.seatsUsed !== null && team.seatLimit !== null ? ` · ${team.seatsUsed} of ${team.seatLimit} seats` : '';
  const marker = isInstallTeam ? styleText('dim', '  (this install)') : '';
  return `  ${styleText('bold', team.name)} ${styleText('dim', `(id ${printable(team.id)})`)} · ${team.role} · ${describeSharing(team)}${seats}${marker}`;
}

/** This checkout's project keys (a worktree reads its parent's too), unless the folder is excluded. */
function checkoutProjects(): string[] {
  const cwd = process.cwd();
  if (!shouldTrackProject(cwd)) return [];
  return getProjectContext(cwd).allProjects;
}

type WorkerJson = { ok: true; value: Record<string, unknown> } | { ok: false; reason: string };

async function readWorkerJson(response: Response, what: string): Promise<WorkerJson> {
  let value: unknown;
  try {
    value = await response.json();
  } catch (error: unknown) {
    const cause = error instanceof Error ? error : new Error(String(error));
    logger.warn('SYSTEM', `The worker's ${what} answer is not JSON`, { status: response.status }, cause);
    return { ok: false, reason: `the worker's ${what} answer is not JSON` };
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? { ok: true, value: value as Record<string, unknown> }
    : { ok: false, reason: `the worker's ${what} answer is not a JSON object` };
}

async function listLocalProjects(): Promise<{ ok: true; projects: string[] } | { ok: false; reason: string }> {
  let response: Response;
  try {
    response = await workerHttpRequest('/api/projects', { timeoutMs: WORKER_REQUEST_TIMEOUT_MS });
  } catch (error: unknown) {
    const cause = error instanceof Error ? error : new Error(String(error));
    logger.debug('SYSTEM', 'Project list request failed', {}, cause);
    return { ok: false, reason: isConnectionRefusedError(error) ? 'the worker is not running' : printable(cause.message) || cause.name };
  }
  if (!response.ok) return { ok: false, reason: `the worker answered HTTP ${response.status}` };
  const body = await readWorkerJson(response, 'project list');
  if (!body.ok) return body;
  const projects = body.value.projects;
  if (!Array.isArray(projects)) return { ok: false, reason: 'the worker sent no project list' };
  return { ok: true, projects: projects.filter((project): project is string => typeof project === 'string' && project.trim() !== '') };
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
      ...projects.map(project => (checkout.includes(project)
        ? { value: project, label: printable(project), hint: 'this checkout' }
        : { value: project, label: printable(project) })),
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

type WorkerHealth =
  | { state: 'running'; pid: number | null }
  | { state: 'not_running' }
  | { state: 'unknown'; reason: string };

/** Whether the worker answers its health check: a refused connection means it is not running. */
async function workerHealth(): Promise<WorkerHealth> {
  let response: Response;
  try {
    response = await workerHttpRequest('/api/health', { timeoutMs: WORKER_REQUEST_TIMEOUT_MS });
  } catch (error: unknown) {
    if (isConnectionRefusedError(error)) return { state: 'not_running' };
    const cause = error instanceof Error ? error : new Error(String(error));
    logger.warn('SYSTEM', 'Worker health check failed', {}, cause);
    return { state: 'unknown', reason: printable(cause.message) || cause.name };
  }
  // 503 is a degraded worker, which still reports its pid.
  if (!response.ok && response.status !== 503) {
    logger.warn('SYSTEM', 'Worker health check answered with an error status', { status: response.status });
    return { state: 'unknown', reason: `the worker answered its health check with HTTP ${response.status}` };
  }
  const body = await readWorkerJson(response, 'health');
  if (!body.ok) return { state: 'unknown', reason: body.reason };
  return { state: 'running', pid: typeof body.value.pid === 'number' ? body.value.pid : null };
}

async function workerSyncStatus(): Promise<{ configured: boolean; hubError: string | null } | null> {
  let response: Response;
  try {
    response = await workerHttpRequest('/api/sync/status', { timeoutMs: WORKER_REQUEST_TIMEOUT_MS });
  } catch (error: unknown) {
    // Expected while the worker restarts; the caller asks again.
    logger.debug('SYSTEM', 'Sync status not answered yet', {}, error instanceof Error ? error : new Error(String(error)));
    return null;
  }
  if (!response.ok) return null;
  const body = await readWorkerJson(response, 'sync status');
  if (!body.ok) return null;
  const hub = body.value.hub as { reachable?: unknown; error?: unknown } | undefined;
  const hubError = hub && hub.reachable === false
    ? (typeof hub.error === 'string' && hub.error ? printable(hub.error) : 'unreachable')
    : null;
  return { configured: body.value.configured === true, hubError };
}

async function requestWorkerRestart(): Promise<string | null> {
  let response: Response;
  try {
    response = await workerHttpRequest('/api/admin/restart', { method: 'POST', timeoutMs: WORKER_REQUEST_TIMEOUT_MS });
  } catch (error: unknown) {
    const cause = error instanceof Error ? error : new Error(String(error));
    logger.warn('SYSTEM', 'Worker restart request failed', {}, cause);
    return printable(cause.message) || cause.name;
  }
  return response.ok ? null : `HTTP ${response.status}`;
}

/**
 * The worker reads the sync connection when it starts, so a changed one needs
 * a restart (the cloud-sync skill's step 3: POST /api/admin/restart, then
 * poll /api/sync/status until it reports the new state). A worker that is not
 * running picks it up when it starts; one whose state cannot be read is
 * reported as such, never assumed.
 */
async function restartWorkerForSyncChange(syncOn: boolean): Promise<void> {
  const before = await workerHealth();
  if (before.state === 'not_running') {
    log.info(syncOn
      ? 'The claude-mem worker is not running; cloud sync starts with it (npx claude-mem start).'
      : 'The claude-mem worker is not running; it starts without cloud sync.');
    return;
  }
  if (before.state === 'unknown') {
    log.warn(`Could not check the claude-mem worker (${before.reason}). Restart it so the change applies: npx claude-mem restart`);
    return;
  }
  const restartProblem = await requestWorkerRestart();
  if (restartProblem) {
    log.warn(`Could not restart the claude-mem worker (${restartProblem}). Restart it so the change applies: npx claude-mem restart`);
    return;
  }

  const deadline = Date.now() + WORKER_RESTART_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, WORKER_RESTART_POLL_MS));
    const health = await workerHealth();
    if (health.state !== 'running' || (before.pid !== null && health.pid === before.pid)) continue;
    const sync = await workerSyncStatus();
    if (!sync || sync.configured !== syncOn) continue;
    if (!syncOn) log.success('The worker restarted without cloud sync.');
    else if (sync.hubError) log.warn(`Cloud sync is set up, but the sync hub did not answer yet: ${sync.hubError}`);
    else log.success('Cloud sync is on: this install syncs to your account.');
    return;
  }
  log.warn(`The worker restart could not be confirmed within ${WORKER_RESTART_WAIT_MS / 1000}s. Check it with: npx claude-mem doctor`);
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
    log.error(`This account is not in team ${printable(wanted)}. Its teams:\n${teams.map(candidate => describeTeam(candidate, false)).join('\n')}`);
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

/** parseArgs, or null after printing the usage when the flags are not this command's. */
function parseFlags<T>(parse: () => T): T | null {
  try {
    return parse();
  } catch (error: unknown) {
    // parseArgs throws a TypeError whose code names the problem (ERR_PARSE_ARGS_*).
    if (error instanceof Error && String((error as { code?: unknown }).code ?? '').startsWith('ERR_PARSE_ARGS')) {
      console.error(styleText('red', error.message));
      console.error(USAGE);
      return null;
    }
    throw error;
  }
}

async function runJoin(argv: string[]): Promise<number> {
  const parsed = parseFlags(() => parseArgs({
    args: argv,
    options: { share: { type: 'string' }, 'share-all': { type: 'boolean' } },
    allowPositionals: true,
    strict: true,
  }));
  if (!parsed) return 1;
  const invite = parseTeamBrainInvite(parsed.positionals[0]);
  if (!invite.ok) {
    log.error(invite.error);
    return 1;
  }
  const shareFlags = parseShareFlags({ share: parsed.values.share, shareAll: parsed.values['share-all'] === true });
  if (!shareFlags.ok) {
    log.error(shareFlags.error);
    return 1;
  }
  // Checked before the browser, so nobody signs in for a join that cannot be saved.
  const settingsProblem = unreadableSettingsProblem();
  if (settingsProblem) {
    log.error(settingsFileProblemMessage(settingsProblem, 'the join'));
    return 1;
  }

  const pairing = await startInstallerOAuthPairing({ source: 'teambrain_join', teamInvite: invite.token });
  if (!pairing) {
    log.error(startFailureMessage());
    return 1;
  }
  log.info(`Sign in, then approve this device on the page to join the team: ${pairing.authorizationUrl}`);
  noteDeviceCode(pairing, 'Approving this device on the page, which names the team, joins it.');
  if (isInteractive) {
    await waitForReturnToOpenBrowser('Hit return to open it in your browser…');
    openBrowser(pairing.authorizationUrl);
  } else {
    log.info('AGENT: show this link to the user. This command waits until they approve this device.');
  }

  const outcome = await waitForInstallerPairing(pairing, 'teambrain_join', CLI_VERSION);
  if (!outcome || outcome.kind !== 'ready') return 1;

  const settingsProblemNow = unreadableSettingsProblem();
  if (settingsProblemNow) {
    log.error(settingsFileProblemMessage(settingsProblemNow, 'the join'));
    return 1;
  }
  const saved = readSavedSettings();
  const effective = readEffectiveSettings();
  const refusal = differentSyncAccountRefusal(
    [saved.CLAUDE_MEM_CLOUD_SYNC_USER_ID, effective.CLAUDE_MEM_CLOUD_SYNC_USER_ID],
    outcome.userId,
  );
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

  const restartNeeded = syncConnectionChanged(effective, outcome);
  const writeProblem = writeSettings(buildTeamBrainJoinSettings(outcome, saved, { teambrainUrl: connection.teambrainUrl, teamId: team.id }));
  if (writeProblem) {
    log.error(`${writeProblem}. ${team.name} counts you as a member, but this install did not save the connection; fix the file and run the join again.`);
    return 1;
  }
  log.success(`Joined ${team.name}. Your memory stays private; you choose what the team sees.`);

  const choice = shareFlags.choice ?? (isInteractive ? await promptShareChoice(team.name, membership) : null);
  if (choice) {
    if (!await applyShareChoice(connection, team, choice)) return 1;
  } else {
    log.info('Not sharing any projects yet. Choose them with: npx claude-mem teambrain share');
  }

  if (restartNeeded) await restartWorkerForSyncChange(true);
  log.info('Your next session starts with the team brief, and agents can use the team_search tool. Check anytime: npx claude-mem teambrain status');
  return 0;
}

async function runShare(argv: string[]): Promise<number> {
  const parsed = parseFlags(() => parseArgs({
    args: argv,
    options: { share: { type: 'string' }, 'share-all': { type: 'boolean' }, team: { type: 'string' } },
    allowPositionals: false,
    strict: true,
  }));
  if (!parsed) return 1;
  const shareFlags = parseShareFlags({ share: parsed.values.share, shareAll: parsed.values['share-all'] === true });
  if (!shareFlags.ok) {
    log.error(shareFlags.error);
    return 1;
  }
  if (!shareFlags.choice && !isInteractive) {
    log.error('Without a terminal, name what to share: npx claude-mem teambrain share --share <a,b> (or --share-all)');
    return 1;
  }
  const connection = requireJoined(readEffectiveSettings());
  if (!connection) return 1;
  const chosen = await chooseTeam(connection, parsed.values.team);
  if (!chosen) return 1;

  const choice = shareFlags.choice ?? await promptShareChoice(chosen.team.name, chosen.team);
  if (!choice) {
    log.info('Nothing changed.');
    return 0;
  }
  return await applyShareChoice(connection, chosen.team, choice) ? 0 : 1;
}

async function runStatus(): Promise<number> {
  const connection = teamBrainConnection(readEffectiveSettings());
  if (!connection) {
    console.log(`${styleText('bold', 'TeamBrain:')} not joined on this install`);
    console.log(`  Start a team:  ${styleText('cyan', 'npx claude-mem teambrain start')}`);
    console.log(`  Join a team:   ${styleText('cyan', 'npx claude-mem teambrain join <invite-link>')}`);
    return 0;
  }
  console.log(`${styleText('bold', 'TeamBrain:')} ${printable(connection.teambrainUrl)}`);
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

/**
 * After a team is left, what this install keeps, from the teams the account
 * is still in (asked again, so it reflects the leave):
 * - still in a team: TeamBrain stays on, pointing at that team if the one it
 *   pointed at is gone;
 * - in no team: both TeamBrain keys are cleared, and a seat-only account
 *   (plan teambrain_seat at join) also loses its sync connection, which the
 *   seat was its only access to; a Pro account keeps syncing;
 * - unknown (the list could not be read): this install's own team is cleared
 *   from it, both keys, and sync is left as it is.
 * Every outcome says exactly what changed.
 */
async function settleInstallAfterLeave(
  connection: TeamBrainConnection,
  leftTeamId: string,
  settings: SettingsDefaults,
): Promise<number> {
  const leftInstallTeam = !connection.teamId || connection.teamId === leftTeamId;
  const after = await fetchTeamBrainStatus(connection, TEAMBRAIN_REQUEST_TIMEOUT_MS);
  const save = (updates: Record<string, string>): boolean => {
    const problem = writeSettings(updates);
    if (problem) log.error(`${problem}. The team was left on cmem.ai, but this install still points at it; fix the file and run leave again.`);
    return !problem;
  };

  if (!after.ok) {
    log.warn(`Could not read which teams this account is still in: ${after.reason}`);
    if (!leftInstallTeam) {
      log.info('Nothing on this install changed: it stays connected to its own team. Cloud sync settings were not changed.');
      return 0;
    }
    if (!save(TEAMBRAIN_OFF)) return 1;
    log.info('Cleared CLAUDE_MEM_TEAMBRAIN_URL and CLAUDE_MEM_TEAMBRAIN_TEAM_ID on this install. Cloud sync settings were not changed. To use another team you are in, join it again with its invite link.');
    return 0;
  }

  const remaining = after.value;
  if (remaining.length > 0) {
    if (leftInstallTeam) {
      if (!save({ CLAUDE_MEM_TEAMBRAIN_TEAM_ID: remaining[0].id })) return 1;
      log.info(`This install now uses ${remaining[0].name}.`);
    }
    log.info(`Still in: ${remaining.map(team => team.name).join(', ')}. Cloud sync settings were not changed.`);
    return 0;
  }

  const seatOnly = settings.CLAUDE_MEM_PRO_PLAN.trim() === 'teambrain_seat';
  if (!save(seatOnly ? { ...TEAMBRAIN_OFF, ...SYNC_DISCONNECTED } : TEAMBRAIN_OFF)) return 1;
  log.info('This account is in no team now, so TeamBrain is off on this install (CLAUDE_MEM_TEAMBRAIN_URL and CLAUDE_MEM_TEAMBRAIN_TEAM_ID cleared).');
  if (!seatOnly) {
    log.info('Cloud sync settings were not changed.');
    return 0;
  }
  log.info('Cloud sync is off for this install too: a TeamBrain seat was its only sync access (CLAUDE_MEM_CLOUD_SYNC_* cleared). Your memory stays on this machine.');
  await restartWorkerForSyncChange(false);
  return 0;
}

async function runLeave(argv: string[]): Promise<number> {
  const parsed = parseFlags(() => parseArgs({ args: argv, options: {}, allowPositionals: true, strict: true }));
  if (!parsed) return 1;
  const settingsProblem = unreadableSettingsProblem();
  if (settingsProblem) {
    log.error(settingsFileProblemMessage(settingsProblem, 'leave'));
    return 1;
  }
  const settings = readEffectiveSettings();
  const connection = requireJoined(settings);
  if (!connection) return 1;

  const before = await fetchTeamBrainStatus(connection, TEAMBRAIN_REQUEST_TIMEOUT_MS);
  if (!before.ok) log.warn(`Could not read your teams before leaving: ${before.reason}`);
  const teams = before.ok ? before.value : null;
  const namedTeamId = parsed.positionals[0]?.trim() ?? '';
  const teamId = namedTeamId || connection.teamId || (teams?.length === 1 ? teams[0].id : '');
  if (!teamId) {
    log.error(before.ok
      ? 'Name the team to leave: npx claude-mem teambrain leave <team-id> (see npx claude-mem teambrain status)'
      : 'Name the team to leave: npx claude-mem teambrain leave <team-id>');
    return 1;
  }
  const team = teams?.find(candidate => candidate.id === teamId);
  const teamName = team?.name ?? `team ${printable(teamId)}`;

  if (teams && !team) {
    if (namedTeamId) {
      log.error(`This account is not in team ${printable(teamId)}.${teams.length > 0 ? ` Its teams:\n${teams.map(candidate => describeTeam(candidate, false)).join('\n')}` : ''}`);
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
    const left: TeamBrainResult<null> = await leaveTeamBrainTeam(connection, teamId, TEAMBRAIN_REQUEST_TIMEOUT_MS);
    if (!left.ok) {
      log.error(`Could not leave ${teamName}: ${left.reason}`);
      return 1;
    }
    log.success(`Left ${teamName}.`);
  }
  return settleInstallAfterLeave(connection, teamId, settings);
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
  switch (subCommand) {
    case 'join':
      return runJoin(argv.slice(1));
    case 'start':
      return runStart();
    case 'status':
      return runStatus();
    case 'share':
      return runShare(argv.slice(1));
    case 'leave':
      return runLeave(argv.slice(1));
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      return 0;
    default:
      console.error(styleText('red', `Unknown teambrain command: ${printable(subCommand)}`));
      console.error(USAGE);
      return 1;
  }
}
