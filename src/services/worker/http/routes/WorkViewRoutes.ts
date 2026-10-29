import type express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { z } from 'zod';
import { Database } from 'bun:sqlite';
import { CLAUDE_CONFIG_DIR, DATA_DIR, DB_PATH, getPackageRoot, USER_SETTINGS_PATH } from '../../../../shared/paths.js';
import { onContextInvalidation } from '../../../../shared/context-invalidation.js';
import { SettingsDefaultsManager } from '../../../../shared/SettingsDefaultsManager.js';
import { logger } from '../../../../utils/logger.js';
import { hasForwardedClientHeaders, hasLoopbackHostHeader, isLocalhost } from '../../../../server/middleware/request-auth-helpers.js';
import { WorkStateSource, type WorkViewSnapshot } from '../../../work-view/data-source.mjs';
import { FILE_CONTENT_TYPES } from '../../../work-view/work-product.mjs';
import { isInsideDeliverablesDir } from '../../../../shared/deliverables.js';
import { contentFingerprint, LocalReviewStore } from '../../../work-view/review-store.js';
import { MY_RULES_LIST, renderRulesFile, ruleRowFields, type SavedRule } from '../../../work-view/my-rules.mjs';
import { focusAreaRowFields, MY_FOCUS_LIST, navWordIn, OTHER_FOCUS_AREA_ID, ownerGoalsAreaRows, placementRowFields, PROPOSAL_KINDS, readFocus, routerFocusRows, seedFocusRows, seedUndoRows, type FocusArea, type RouterFocusBody } from '../../../work-view/my-focus.mjs';
import { MAX_WORK_STATE_FIELDS_JSON_CHARS } from '../../../work-view/work-state-limits.mjs';
import { AGENT_LIFECYCLE_LIST, agentStopFields } from '../../../work-view/agent-lifecycle.mjs';
import { getProjectContext } from '../../../../utils/project-name.js';
import { chatCompletionsHumanCopyProvider, HumanCopyWorker } from '../../../work-view/human-copy-worker.mjs';
import { resolveOpenRouterConfig } from '../../OpenRouterProvider.js';
import { resolveOpenAICompatConfig } from '../../OpenAICompatProvider.js';
import { resolveOpenAICompatReasoning } from '../../reasoning-budget.js';
import { AutoRefreshWorker } from '../../../work-view/auto-refresh-worker.mjs';
import { buildRefreshTask } from '../../../work-view/refresh-task.js';
import { HostedIntent } from '../../../work-view/hosted-intent.js';
import { cmemProOrigin } from '../../../../shared/cmem-gateway.js';
import { isOpenRouterApiUrl } from '../../../../shared/openrouter-base-url.js';
import { runAgentTask } from '../../../agent-runner/run.js';
import { ledgerSignature, readLedger } from '../../../work-view/request-groups.mjs';
import { configuredJudge, decideSuggestion } from '../../../work-view/request-judge.mjs';
import { configuredFocusJudge } from '../../../work-view/focus-judge.mjs';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { captureEvent } from '../../../telemetry/telemetry.js';
import { isForeignLoopbackBrowserWrite } from './SettingsRoutes.js';
import { validateBody } from '../middleware/validateBody.js';
import type { SetupScan, SetupScanState } from '../../../prompt-import/setup-scan.js';
import { readHistoryCounts, type HistoryImport } from '../../../setup/history-import.js';
import { hasActiveSetupSession, hasProConfiguration, readSetupState, setupStatePath, writeSetupState, type SetupStateFile, type SetupStateView } from '../../../../shared/setup-state.js';

// A request is ready for a human check once its explicit lifecycle reports it complete, shipped, or waiting for review.
// Statuses are compared lowercased with `_` and spaces read as `-`, matching the viewer's status normalization.
const READY_FOR_CHECK_LIFECYCLE_STATUSES = [
  'done', 'completed', 'complete', 'shipped', 'delivered',
  'needs-review', 'review', 'in-review', 'awaiting-review', 'ready-for-review',
];
type RecordedLifecycle = { explicit?: boolean; complete?: boolean | null; status?: string | null; atEpoch?: number | null } | null | undefined;

/** Mirrors the viewer's reviewIsNewerThanLifecycle (src/ui/my-work/src/live/to-work-model.ts). */
function reviewIsNewerThanLifecycle(review: { checkedAt?: string | null }, lifecycle: RecordedLifecycle): boolean {
  if (!lifecycle?.explicit || !lifecycle.atEpoch) return true;
  const reviewedAt = Date.parse(review.checkedAt ?? '');
  return Number.isFinite(reviewedAt) && reviewedAt >= lifecycle.atEpoch;
}

/** True while a process with this pid exists (signal 0 checks without signalling). */
function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Ready for a person's check: the explicit lifecycle says so, or a memory review newer than it reached 100%.
 * The viewer offers "Mark checked" on exactly these requests. */
export function isReportedReadyForCheck(request: { lifecycle?: RecordedLifecycle; progress?: { percent?: number; checkedAt?: string | null } | null }): boolean {
  const { lifecycle, progress } = request;
  if (progress?.percent === 100 && reviewIsNewerThanLifecycle(progress, lifecycle)) return true;
  if (!lifecycle?.explicit) return false;
  const status = String(lifecycle.status ?? '').trim().toLowerCase().replace(/[_ ]/g, '-');
  return lifecycle.complete === true || READY_FOR_CHECK_LIFECYCLE_STATUSES.includes(status);
}

/** Recorded files plus the text kinds an agent attaches as a deliverable, served so a browser shows them rather than downloads them. */
const DELIVERABLE_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ...FILE_CONTENT_TYPES,
  '.md': 'text/plain; charset=utf-8', '.markdown': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.rst': 'text/plain; charset=utf-8', '.json': 'text/plain; charset=utf-8',
};

const reviewBody = z.object({
  requestId: z.string().min(1).max(2000),
  expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  checked: z.boolean(),
}).strict();

// The viewer is local even when another worker surface is explicitly exposed.
// Match the existing request-auth helpers, including rejecting proxy headers.
export function workViewLoopbackOnly(req: Request, res: Response, next: NextFunction): void {
  if (!isLocalhost(req) || !hasLoopbackHostHeader(req) || hasForwardedClientHeaders(req)) {
    res.status(403).json({ error: 'Work view is available only on this computer.' });
    return;
  }
  next();
}

// Browser writes must come from the viewer's own page. The Origin check is main's
// shared settings guard (isForeignLoopbackBrowserWrite); the work view also rejects
// cross-site fetch metadata and non-JSON bodies.
export function requireWorkViewOrigin(req: Request, res: Response, next: NextFunction): void {
  const valid = req.get('sec-fetch-site') !== 'cross-site' && !isForeignLoopbackBrowserWrite(req);
  if (!valid || !req.is('application/json')) {
    res.status(403).json({ error: 'Review changes must come from the local work viewer.' });
    return;
  }
  next();
}

const ruleBody = z.object({
  action: z.enum(['approve', 'edit', 'turn-off', 'turn-on', 'dismiss', 'add', 'replace', 'restore-suggestion']),
  ruleId: z.string().min(1).max(80).optional(),
  rule: z.object({
    scopeTier: z.enum(['everywhere', 'project', 'situation']),
    scopeName: z.string().max(80),
    when: z.string().max(300),
    then: z.string().trim().min(1).max(600),
  }).strict().optional(),
}).strict();

// Area ids are short generated tokens, bounded like rule ids. A name is a nav label and a goal one sentence:
// 80 and 300 characters leave room for the evidence inside one 2000-character work-state row.
// A request id is a JSON key, bounded like reviewBody's.
const focusAreaIdField = z.string().min(1).max(80);
const focusBody = z.object({
  action: z.enum(['keep', 'rename', 'edit-goal', 'merge', 'dismiss', 'done', 'reorder', 'move-request', 'restore-suggestion']),
  focusAreaId: focusAreaIdField.optional(),
  name: z.string().trim().min(1).max(80).optional(),
  goal: z.string().trim().min(1).max(300).optional(),
  intoFocusAreaId: focusAreaIdField.optional(),
  /** reorder: every area in the owner's order, first = highest priority. */
  focusAreaIds: z.array(focusAreaIdField).min(1).optional(),
  requestId: z.string().min(1).max(2000).optional(),
}).strict();

// The focus areas owner-goals mined from the owner's prompts (save_goals.py). Same name and goal bounds as
// focusBody. The evidence is one line pointing at the owner-goals item that holds the quotes; 300 characters
// keeps the whole area inside one 2000-character work-state row. No count cap: the owner has as many areas as they have.
const ownerGoalsFocusBody = z.object({
  areas: z.array(z.object({
    name: z.string().trim().min(1).max(80),
    goal: z.string().trim().min(1).max(300),
    rank: z.number().int().positive(),
    /** The model's judgment: the saved area this one already is, or null for a new one. Never a name match. */
    matches: focusAreaIdField.nullable(),
    evidence: z.string().trim().min(1).max(300),
  }).strict()),
}).strict();

// One checked focus-step answer (request-groups.mjs record-focus): router placements and areas proposed from Other.
// Same name, sentence and request-id bounds as focusBody and reviewBody; a basis is focusBasis's 16 hex characters.
// No count caps: every request is placed, and the owner has as many areas as their work holds.
const anchorField = z.string().min(1).max(2000);
// focusBasis and the Other pass hash are 16 hex characters.
const basisField = z.string().regex(/^[0-9a-f]{16}$/);
const routerFocusBody = z.object({
  placements: z.array(z.object({
    anchorConversationKey: anchorField, focusAreaId: focusAreaIdField, basis: basisField, evidence: z.string().trim().min(1).max(300),
  }).strict()),
  proposals: z.array(z.object({
    kind: z.enum(PROPOSAL_KINDS as unknown as ['new', 'promote']),
    name: z.string().trim().min(1).max(80), goal: z.string().trim().min(1).max(300), about: z.string().trim().min(1).max(300),
    evidence: z.string().trim().min(1).max(300),
    sameAs: focusAreaIdField.nullable(),
    requests: z.array(z.object({ anchorConversationKey: anchorField, basis: basisField }).strict()).min(1),
  }).strict()),
  otherPassHash: basisField.nullable().optional(),
}).strict();

// The one-time seed (scripts/seed-focus-areas.mjs): suggested `source: seed` areas and router placements, or the undo of
// one seed from its note. Same name, sentence, id and anchor bounds as the other focus bodies; an area's `about` is the
// seed line's whole description, bounded only by the one work-state row it must fit (focusAreaRowFields checks the row).
// A confidence is the recorded probability, 0 to 1. No count caps: the seed covers every line and every routed request.
// The database the script read and expects this worker to write (a path; 4096 is PATH_MAX on macOS and Linux). A worker
// serving another data folder refuses, so a copy's settings pointing at the live port cannot write the live database.
const seedDatabasePathField = z.string().min(1).max(4096);
const seedFocusBody = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('apply'),
    areas: z.array(z.object({
      key: z.string().min(1).max(80), name: z.string().trim().min(1).max(80), goal: z.string().trim().min(1).max(300),
      about: z.string().trim().min(1).max(MAX_WORK_STATE_FIELDS_JSON_CHARS), priorityRank: z.number().int().positive(),
      evidence: z.string().trim().min(1).max(300), matches: focusAreaIdField.nullable().optional(),
    }).strict()),
    placements: z.array(z.object({
      anchorConversationKey: anchorField, area: z.string().min(1).max(80), confidence: z.number().min(0).max(1),
      basis: basisField, evidence: z.string().trim().min(1).max(300),
    }).strict()),
    databasePath: seedDatabasePathField,
  }).strict(),
  z.object({
    action: z.literal('undo'),
    focusAreaIds: z.array(focusAreaIdField),
    placements: z.array(z.object({ anchorConversationKey: anchorField, focusAreaId: focusAreaIdField, basis: basisField }).strict()),
    databasePath: seedDatabasePathField,
  }).strict(),
]);

const markAgentFinishedBody = z.object({
  agentGroupId: z.string().min(1).max(2000),
}).strict();

/** The owner's answer to the judge's "Looks like part of <request>" on a card. */
const suggestionBody = z.object({
  conversationKey: z.string().min(1).max(2000),
  action: z.enum(['join', 'not-this']),
}).strict();

// The viewer's page ids (src/ui/my-work/src/live/usage.ts `UsageView`: setup plus App.tsx `View`): a closed list, so a
// usage report can carry nothing else. A focus area is My Work filtered to that area, so it counts as `work`, never by name.
const WORK_VIEW_PAGES = ['setup', 'work', 'rules', 'suggested', 'past-focus'] as const;
const usageBody = z.discriminatedUnion('event', [
  z.object({ event: z.literal('opened'), view: z.enum(WORK_VIEW_PAGES) }).strict(),
  z.object({ event: z.literal('switched'), view: z.enum(WORK_VIEW_PAGES), previousView: z.enum(WORK_VIEW_PAGES) }).strict(),
]);

/** A path as the owner reads it: `~/...` under the home folder, else absolute. */
const homeRelative = (path: string) => path === homedir() || path.startsWith(`${homedir()}/`) ? `~${path.slice(homedir().length)}` : path;

/** The line that makes Claude Code load the approved rules with the owner's user-level instructions.
 * It names the rules file the worker actually writes, so a custom data folder is still the one loaded. */
export function myRulesImportLine(rulesFilePath: string): string {
  return `@${homeRelative(rulesFilePath)}`;
}

interface WorkStateWrite { project: string; listName: string; fields: Record<string, string | number | boolean | null> }

interface WorkViewOptions {
  databasePath?: string;
  reviewPath?: string;
  pollIntervalMs?: number;
  getLocalDeviceId?: () => string;
  humanCopy?: HumanCopyWorker | null;
  /** Runs owner-goals and request-progress when something is due. Omitted: on for the default ledger only. */
  autoRefresh?: AutoRefreshWorker | null;
  /** Overall-request ledger written by the request-progress skill; null disables it. */
  ledgerDir?: string | null;
  /** Saves one work-state row (rule changes). Without it, rules are read-only. */
  appendWorkStateEntry?: ((entry: WorkStateWrite) => void) | null;
  /** The project rule rows are saved under: the home folder's, like owner-goals. */
  homeProject?: string;
  /** <data dir>/MY-RULES.md: approved rules, rebuilt after every rule change, local or synced. */
  rulesFilePath?: string;
  /** <Claude config dir>/CLAUDE.md: the user-level file that imports MY-RULES.md. Never a project's file. */
  claudeInstructionsPath?: string;
  /** The install funnel's prompt scan. Without it the setup scan endpoints answer 503. */
  setupScan?: SetupScan | null;
  /** The install funnel's per-machine state file (choice, installer stage, completion). */
  setupStatePath?: string;
  /** Read for `alreadyPro`; defaults to ~/.claude-mem/settings.json. */
  settingsPath?: string;
  /** Finish Setup's history upload to CMEM Pro. Without it POST /api/setup/import answers 503. */
  historyImport?: HistoryImport | null;
  /** Setup extraction only. Ongoing automatic refresh continues to use the local agent runner. */
  hostedIntent?: Pick<HostedIntent, 'run' | 'state'> | null;
}

/** One overall request on the Reveal, read from the request-group ledger so new installs (prompts only) have work too. */
export interface SetupWorkItem { groupId: string; title: string; platform: string | null; lastActiveAt: string | null; progressPercent: number | null }
const SETUP_WORK_SHOWN = 5;

const setupScanBody = z.object({ improveProduct: z.boolean().optional() }).strict();
const setupScanPreferencesBody = z.object({ improveProduct: z.boolean() }).strict();
// On The Go is always CMEM Pro: standalone Cloud Sync on your own tokens has no price yet (gap G1).
const setupChoiceBody = z.object({
  branch: z.enum(['home', 'go']),
  memoryBilling: z.enum(['hosted', 'existing']),
}).strict().refine(choice => choice.branch === 'home' || choice.memoryBilling === 'hosted', {
  message: 'On The Go uses CMEM Pro (memoryBilling "hosted").',
});
const setupInstallerBody = z.object({
  stage: z.enum(['waiting-for-choice', 'home-ready', 'go-kept-existing-pro', 'go-awaiting-checkout', 'failed']),
  error: z.string().max(2000).nullable().optional(),
  /** The installer mirrors the pairing checkout it is running (funnel Phase 8). */
  checkout: z.enum(['waiting', 'paid', 'failed']).optional(),
}).strict();
const setupCheckoutBody = z.object({}).strict();
const setupCompleteBody = z.object({
  /** Finish Setup's picked tools; the installer sets up the local ones it has not installed. */
  tools: z.array(z.string().min(1).max(40)).max(20).optional(),
}).strict();
const setupImportBody = z.object({}).strict();

type HumanCopyProvider = ReturnType<typeof chatCompletionsHumanCopyProvider> & {
  configKey?: string;
  isOff?: () => boolean;
  getConfigKey?: () => string | null;
};

function withHumanCopyConfigKey(provider: ReturnType<typeof chatCompletionsHumanCopyProvider>, config: unknown[]): HumanCopyProvider {
  return Object.assign(provider, { configKey: createHash('sha256').update(JSON.stringify(config)).digest('hex') });
}

/** Resolve the explicitly selected copy endpoint, or follow today's primary-provider behavior. */
function resolveConfiguredHumanCopyProvider(settingsPath: string): HumanCopyProvider | null {
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath, true, { readOnly: true });
  // Unset keeps today's behaviour: only an OpenRouter primary writes card wording. Any other endpoint, an
  // OpenAI-compatible primary included, spends tokens on it only once selected here.
  const selection = settings.CLAUDE_MEM_WORK_VIEW_COPY_PROVIDER?.trim() || (settings.CLAUDE_MEM_PROVIDER === 'openrouter' ? 'openrouter' : '');
  const modelOverride = settings.CLAUDE_MEM_WORK_VIEW_COPY_MODEL?.trim();

  if (selection === 'openrouter') {
    const config = resolveOpenRouterConfig(settingsPath);
    const model = modelOverride || config.model;
    if (!config.apiUrl || !config.apiKey || !model) return null;
    const fallbackModels = !modelOverride && isOpenRouterApiUrl(config.apiUrl) ? config.fallbackModels : [];
    return withHumanCopyConfigKey(chatCompletionsHumanCopyProvider({
      url: config.apiUrl, apiKey: config.apiKey, model, ...(fallbackModels.length ? { fallbackModels } : {}),
    }), ['openrouter', config.apiUrl, config.apiKey, model, fallbackModels]);
  }
  if (selection === 'openai-compatible') {
    const config = resolveOpenAICompatConfig(settingsPath);
    const model = modelOverride || config.model;
    if (!config.apiUrl || !model || (config.requiresApiKey && !config.apiKey)) return null;
    // The observer's reasoning setting for this endpoint applies to card wording too, and a strict server that
    // rejects the field gets one resend without it (the observer's own rule, OpenAICompatProvider).
    const sendReasoningOff = resolveOpenAICompatReasoning(settings.CLAUDE_MEM_OPENAI_COMPAT_REASONING) !== 'on';
    return withHumanCopyConfigKey(chatCompletionsHumanCopyProvider({ url: config.apiUrl, apiKey: config.apiKey, model, sendReasoningOff }),
      ['openai-compatible', config.apiUrl, config.apiKey, model, sendReasoningOff]);
  }
  return null;
}

/**
 * My Work summaries follow an OpenRouter primary provider by default, as before.
 * Any other configured endpoint is used only when selected here;
 * the observer's quota-fallback key is never activated merely because it exists.
 * Settings and credentials are resolved for each availability check/request so
 * saves take effect without rebuilding the routes.
 */
export function configuredHumanCopyProvider(settingsPath = USER_SETTINGS_PATH): HumanCopyProvider {
  const provider = (async (input: unknown) => {
    const resolved = resolveConfiguredHumanCopyProvider(settingsPath);
    if (!resolved) throw new Error('No supported My Work summary provider is configured.');
    return resolved(input);
  }) as HumanCopyProvider & { isAvailable: () => boolean; isOff: () => boolean; getConfigKey: () => string | null };
  provider.isAvailable = () => {
    try { return resolveConfiguredHumanCopyProvider(settingsPath) !== null; }
    catch { return false; }
  };
  provider.isOff = () => {
    try { return SettingsDefaultsManager.loadFromFile(settingsPath, true, { readOnly: true }).CLAUDE_MEM_WORK_VIEW_COPY_PROVIDER?.trim() === 'off'; }
    catch { return false; }
  };
  provider.getConfigKey = () => {
    try { return resolveConfiguredHumanCopyProvider(settingsPath)?.configKey ?? null; }
    catch { return null; }
  };
  return provider;
}

/** My Work's automatic refresh on the user's own logged-in agent, unless
 * CLAUDE_MEM_WORK_VIEW_AUTO_REFRESH is 'false' (checked on every tick). */
export function defaultAutoRefresh(ledgerDir: string, settingsPath = USER_SETTINGS_PATH, setupPath = setupStatePath(), setupActive = () => false,
  localDeviceId: () => string, saveFocus: (body: RouterFocusBody) => { placed: number; focusAreaIds: string[] }): AutoRefreshWorker {
  const openDatabase = () => {
    const database = new Database(DB_PATH, { readonly: true, create: false });
    database.exec('PRAGMA busy_timeout = 1500');
    return database;
  };
  return new AutoRefreshWorker({
    dir: ledgerDir,
    openDatabase,
    // Setup's only extraction is hosted. Once setup is complete, ongoing refresh keeps its existing local path.
    enabled: () => !setupActive() && (readSetupState(setupPath).status === 'complete' || !hasActiveSetupSession(setupPath))
      && SettingsDefaultsManager.loadFromFile(settingsPath, true, { readOnly: true }).CLAUDE_MEM_WORK_VIEW_AUTO_REFRESH !== 'false',
    runJob: async ({ needs, reason }) => {
      // The judges are read from settings per run, so a provider change applies to the next refresh.
      const task = buildRefreshTask({ needs, reason, dataDir: DATA_DIR, ledgerDir, pluginRoot: getPackageRoot(), openDatabase, localDeviceId, saveFocus,
        judge: configuredJudge(settingsPath), focusJudge: configuredFocusJudge(settingsPath) });
      return { ...(await runAgentTask(task)), steps: task.steps };
    },
    log: (level, message, data) => (level === 'info' ? logger.info : logger.warn).call(logger, 'WORKER', message, data),
    localDeviceId,
  });
}

export class WorkViewRoutes extends BaseRouteHandler {
  private source: WorkStateSource;
  private reviews: LocalReviewStore;
  private clients = new Set<Response>();
  private poll: ReturnType<typeof setInterval> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private signature = '';
  private closed = false;
  private pollIntervalMs: number;
  private getLocalDeviceId: () => string;
  private humanCopy: HumanCopyWorker | null;
  private autoRefresh: AutoRefreshWorker | null;
  private appendWorkStateEntry: ((entry: WorkStateWrite) => void) | null;
  private homeProject: string | undefined;
  private rulesFilePath: string;
  private claudeInstructionsPath: string;
  private setupScan: SetupScan | null;
  private setupStatePath: string;
  private settingsPath: string;
  private unsubscribeSetupScan: (() => void) | null = null;
  private ledgerDir: string | null;
  private databasePath: string;
  private setupWorkCache: { signature: string; work: SetupWorkItem[] | null } | null = null;
  private historyImport: HistoryImport | null;
  private unsubscribeHistoryImport: (() => void) | null = null;
  private hostedIntent: Pick<HostedIntent, 'run' | 'state'> | null;

  constructor(options: WorkViewOptions = {}) {
    super();
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.getLocalDeviceId = options.getLocalDeviceId ?? (() => '');
    const ledgerDir = options.ledgerDir === undefined ? join(DATA_DIR, 'work-view') : options.ledgerDir;
    this.ledgerDir = ledgerDir;
    this.databasePath = options.databasePath ?? DB_PATH;
    this.source = new WorkStateSource({
      databasePath: options.databasePath ?? DB_PATH,
      pollIntervalMs: this.pollIntervalMs,
      ledgerDir,
    });
    this.reviews = new LocalReviewStore(options.reviewPath ?? join(DATA_DIR, 'work-view-reviews.db'));
    this.humanCopy = options.humanCopy === undefined
      ? new HumanCopyWorker({ provider: configuredHumanCopyProvider(), cachePath: join(DATA_DIR, 'work-view', 'human-copy.json'),
        warn: message => logger.warn('WORKER', message) })
      : options.humanCopy;
    this.humanCopy?.pauseWhile(() => this.setupIsActive());
    if (this.humanCopy) void this.humanCopy.load().then(() => this.humanCopy?.start());
    // A test or demo with its own ledger never starts an agent unless it passes one in.
    this.autoRefresh = options.autoRefresh === undefined
      ? (options.ledgerDir === undefined && ledgerDir ? defaultAutoRefresh(ledgerDir, options.settingsPath, options.setupStatePath,
        () => this.setupIsActive(), () => this.getLocalDeviceId(), body => this.recordRouterFocus(body)) : null)
      : options.autoRefresh;
    this.autoRefresh?.start();
    this.appendWorkStateEntry = options.appendWorkStateEntry ?? null;
    this.homeProject = options.homeProject;
    this.rulesFilePath = options.rulesFilePath ?? join(DATA_DIR, 'MY-RULES.md');
    this.claudeInstructionsPath = options.claudeInstructionsPath ?? join(CLAUDE_CONFIG_DIR, 'CLAUDE.md');
    this.setupScan = options.setupScan ?? null;
    this.setupStatePath = options.setupStatePath ?? setupStatePath();
    this.settingsPath = options.settingsPath ?? USER_SETTINGS_PATH;
    this.historyImport = options.historyImport ?? null;
    this.hostedIntent = options.hostedIntent === undefined
      ? (this.setupScan && ledgerDir && this.appendWorkStateEntry ? new HostedIntent({
        origin: () => cmemProOrigin(),
        intentConfigPath: join(dirname(this.settingsPath), 'intent-install.json'),
        credentials: () => {
          const settings = SettingsDefaultsManager.loadFromFile(this.settingsPath, true, { readOnly: true });
          return { token: settings.CLAUDE_MEM_CLOUD_SYNC_TOKEN?.trim() ?? '', userId: settings.CLAUDE_MEM_CLOUD_SYNC_USER_ID?.trim() ?? '' };
        },
        ledgerDir,
        openDatabase: () => new Database(this.databasePath, { readonly: true, create: false }),
        appendWorkStateEntry: entry => this.appendWorkStateEntry!(entry),
        homeProject: () => this.homeProject ?? getProjectContext(homedir()).primary,
        localDeviceId: () => this.getLocalDeviceId(),
      }) : null)
      : options.hostedIntent;
    if (this.hostedIntent) this.setupScan?.setExtractor((prompts, improveProduct) => this.hostedIntent!.run(prompts, improveProduct));
    this.unsubscribeHistoryImport = this.historyImport?.subscribe(state => this.broadcast('setup-import', state)) ?? null;
    // Hosted extraction is awaited inside the scan, so failures stay in the scan screen's error slot.
    this.unsubscribeSetupScan = this.setupScan?.subscribe(state => {
      this.publish();
      this.broadcast('setup-scan', state);
    }) ?? null;
    // Rule rows pulled from another device change what Claude Code should load; rebuild the file then too.
    this.stopRulesSync = onContextInvalidation(({ reason }) => {
      if (reason.startsWith('SyncApply.')) this.scheduleRulesFileRebuild();
    });
  }

  private stopRulesSync: () => void;
  private rulesRebuildScheduled = false;

  private setupIsActive(): boolean {
    const statePath = this.setupStatePath ?? setupStatePath();
    const scanPhase = this.setupScan?.state().phase ?? 'idle';
    if (!['idle', 'done', 'failed'].includes(scanPhase)) return true;
    return readSetupState(statePath).status !== 'complete' && hasActiveSetupSession(statePath);
  }

  private scheduleRulesFileRebuild(): void {
    if (this.rulesRebuildScheduled || this.closed) return;
    this.rulesRebuildScheduled = true;
    setImmediate(() => {
      this.rulesRebuildScheduled = false;
      if (this.closed) return;
      try { this.rebuildRulesFileFromSavedRules(); }
      catch (error) { logger.warn('HTTP', 'Could not rebuild MY-RULES.md after sync', { error: error instanceof Error ? error.message : String(error) }); }
    });
  }

  /** Rewrites MY-RULES.md when the saved rules render differently. Never from an unreadable source, which reads as no rules. */
  rebuildRulesFileFromSavedRules(): boolean {
    const view = this.source.read().agentView;
    if (!view.source.connected) return false;
    const markdown = renderRulesFile((view.rules ?? []) as SavedRule[]).markdown;
    let current: string | null = null;
    try { current = readFileSync(this.rulesFilePath, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (current === markdown) return false;
    this.writeRulesFile((view.rules ?? []) as SavedRule[]);
    return true;
  }

  setupRoutes(app: express.Application): void {
    app.get('/api/work-view', workViewLoopbackOnly, this.wrapHandler((_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(this.snapshot());
    }));
    app.get('/api/work-view/events', workViewLoopbackOnly, this.wrapHandler(this.events));
    app.get('/api/work-view/evidence/:kind/:id', workViewLoopbackOnly, this.wrapHandler((req, res) => {
      const id = this.parseIntParam(req, res, 'id');
      if (id === null) return;
      const evidence = this.source.evidence(this.toStringParam(req.params.kind), id);
      res.setHeader('Cache-Control', 'no-store');
      if (!evidence) { this.notFound(res, 'Recorded evidence not found.'); return; }
      res.json(evidence);
    }));
    // A recorded work-product file, found through the record that names it.
    // Pages and images render sandboxed so they cannot act as the viewer.
    // It reads real files, so another local page (which worker CORS lets read responses) is refused:
    // a cross-origin fetch carries its Origin, while the viewer opens files from its own origin.
    app.get('/api/work-view/file/:kind/:id/:index', workViewLoopbackOnly, this.wrapHandler((req, res) => {
      if (req.get('sec-fetch-site') === 'cross-site' || isForeignLoopbackBrowserWrite(req)) {
        res.status(403).json({ error: 'Recorded files open only from the local work viewer.' });
        return;
      }
      const id = this.parseIntParam(req, res, 'id');
      if (id === null) return;
      const index = this.parseIntParam(req, res, 'index');
      if (index === null) return;
      const path = this.source.file(this.toStringParam(req.params.kind), id, index);
      if (!path) { this.notFound(res, 'Recorded file not found.'); return; }
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', 'sandbox allow-scripts');
      res.type(FILE_CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream');
      res.sendFile(path, { dotfiles: 'allow' });
    }));
    // A deliverable the Stop hook copied into the project bucket (~/.claude-mem/deliverables/<project>/), found
    // through its record; the filename in the URL must be the copy's own, so a link never names another file.
    // Same sandbox and same-origin rules as a recorded file. Text and markdown open inline as plain text.
    app.get('/api/deliverables/:id/:filename', workViewLoopbackOnly, this.wrapHandler((req, res) => {
      if (req.get('sec-fetch-site') === 'cross-site' || isForeignLoopbackBrowserWrite(req)) {
        res.status(403).json({ error: 'Deliverables open only from the local work viewer.' });
        return;
      }
      const id = this.parseIntParam(req, res, 'id');
      if (id === null) return;
      const deliverable = this.source.deliverable(id);
      if (!deliverable || basename(deliverable.path) !== this.toStringParam(req.params.filename) || !isInsideDeliverablesDir(deliverable.path)) {
        this.notFound(res, 'Deliverable not found.');
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', 'sandbox allow-scripts');
      res.type(DELIVERABLE_CONTENT_TYPES[extname(deliverable.path).toLowerCase()] ?? 'application/octet-stream');
      res.sendFile(deliverable.path, { dotfiles: 'allow' });
    }));
    app.post('/api/work-view/review', workViewLoopbackOnly, requireWorkViewOrigin, validateBody(reviewBody), this.wrapHandler(this.review));
    app.post('/api/work-view/rules', workViewLoopbackOnly, requireWorkViewOrigin, validateBody(ruleBody), this.wrapHandler(this.saveRule));
    app.post('/api/work-view/focus', workViewLoopbackOnly, requireWorkViewOrigin, validateBody(focusBody), this.wrapHandler(this.saveFocus));
    // System-written suggestions only: every row is decided_by system, status suggested, under a new id, so
    // nothing posted here can stand in for an owner decision or change an area the owner decided.
    app.post('/api/work-view/focus/owner-goals', workViewLoopbackOnly, requireWorkViewOrigin, validateBody(ownerGoalsFocusBody), this.wrapHandler(this.suggestOwnerGoalsAreas));
    // The focus step's answer (request-groups.mjs record-focus run by the request-progress skill): router placements
    // and suggested areas only, so nothing posted here can stand in for an owner decision.
    app.post('/api/work-view/focus/router', workViewLoopbackOnly, requireWorkViewOrigin, validateBody(routerFocusBody), this.wrapHandler(this.saveRouterFocus));
    // The one-time seed and its undo: system rows only (suggested seed areas, router placements, system withdrawals and
    // cleared router placements), so nothing posted here can stand in for or change an owner decision.
    app.post('/api/work-view/focus/seed', workViewLoopbackOnly, requireWorkViewOrigin, validateBody(seedFocusBody), this.wrapHandler(this.saveSeedFocus));
    app.post('/api/work-view/agents/mark-finished', workViewLoopbackOnly, requireWorkViewOrigin, validateBody(markAgentFinishedBody), this.wrapHandler(this.markAgentFinished));
    app.post('/api/work-view/suggestions', workViewLoopbackOnly, requireWorkViewOrigin, validateBody(suggestionBody), this.wrapHandler(this.answerSuggestion));
    app.post('/api/work-view/rules/load-in-claude-code', workViewLoopbackOnly, requireWorkViewOrigin, this.wrapHandler(this.loadRulesInClaudeCode));
    app.post('/api/work-view/usage', workViewLoopbackOnly, requireWorkViewOrigin, validateBody(usageBody), this.wrapHandler(this.recordUsage));
    app.get('/api/setup/scan', workViewLoopbackOnly, this.wrapHandler((_req, res) => {
      if (!this.setupScan) { res.status(503).json({ error: 'The prompt scan is unavailable on this worker.' }); return; }
      res.setHeader('Cache-Control', 'no-store');
      res.json(this.setupScan.state());
    }));
    app.post('/api/setup/scan', workViewLoopbackOnly, requireWorkViewOrigin, validateBody(setupScanBody), this.wrapHandler((req, res) => {
      if (!this.setupScan) { res.status(503).json({ error: 'The prompt scan is unavailable on this worker.' }); return; }
      res.setHeader('Cache-Control', 'no-store');
      res.status(202).json(this.setupScan.start(req.body.improveProduct));
    }));
    app.post('/api/setup/scan/preferences', workViewLoopbackOnly, requireWorkViewOrigin, validateBody(setupScanPreferencesBody), this.wrapHandler((req, res) => {
      if (!this.setupScan) { res.status(503).json({ error: 'The prompt scan is unavailable on this worker.' }); return; }
      if (this.setupScan.state().phase === 'uploading') { res.status(409).json({ error: 'The setup upload has already started.' }); return; }
      res.setHeader('Cache-Control', 'no-store');
      res.json(this.setupScan.setImproveProduct(req.body.improveProduct));
    }));
    // The funnel hand-off. The page posts the storage choice and the finish; the installer polls the state and
    // reports what it did with the choice. Node's fetch sends no Origin, so the installer passes the same guard.
    app.get('/api/setup/state', workViewLoopbackOnly, this.wrapHandler((_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(this.setupStateView());
    }));
    app.post('/api/setup/choice', workViewLoopbackOnly, requireWorkViewOrigin, validateBody(setupChoiceBody), this.wrapHandler(this.saveSetupChoice));
    app.post('/api/setup/installer', workViewLoopbackOnly, requireWorkViewOrigin, validateBody(setupInstallerBody), this.wrapHandler(this.saveInstallerStage));
    app.post('/api/setup/checkout', workViewLoopbackOnly, requireWorkViewOrigin, validateBody(setupCheckoutBody), this.wrapHandler(this.requestCheckout));
    app.post('/api/setup/import', workViewLoopbackOnly, requireWorkViewOrigin, validateBody(setupImportBody), this.wrapHandler(this.startHistoryImport));
    app.post('/api/setup/complete', workViewLoopbackOnly, requireWorkViewOrigin, validateBody(setupCompleteBody), this.wrapHandler(this.completeSetup));
  }

  private setupStateView(state: SetupStateFile = readSetupState(this.setupStatePath)): SetupStateView {
    const settings = SettingsDefaultsManager.loadFromFile(this.settingsPath, true, { readOnly: true }) as unknown as Record<string, unknown>;
    const historyImport = this.historyImport?.state() ?? null;
    const backgroundWorkRunning: NonNullable<SetupStateView['backgroundWorkRunning']> = [];
    const refresh = this.autoRefresh?.status() ?? null;
    // A 'running' record whose process is gone was cut off; only a live run counts.
    // The setup scan counts too: when it finishes it starts the extraction run.
    const scanPhase = this.setupScan?.state().phase ?? 'idle';
    const scanning = !['idle', 'done', 'failed'].includes(scanPhase);
    if (scanning || (refresh?.state === 'running' && processIsAlive(Number((refresh as { pid?: number }).pid)))) backgroundWorkRunning.push('extraction');
    if (historyImport?.state === 'running') backgroundWorkRunning.push('history-import');
    return { ...state, alreadyPro: hasProConfiguration(settings), history: this.historyCounts(), historyImport, backgroundWorkRunning };
  }

  /** This machine's own observations, for the import offer. A missing database is a new install: nothing to import. */
  private historyCounts(): { projects: number; sessions: number; observations: number } | null {
    if (!existsSync(this.databasePath)) return { projects: 0, sessions: 0, observations: 0 };
    const database = new Database(this.databasePath, { readonly: true, create: false });
    try { return readHistoryCounts(database); }
    finally { database.close(); }
  }

  /** Finish Setup's "Import full history" (On The Go only, after checkout). */
  private startHistoryImport = (_req: Request, res: Response): void => {
    if (!this.historyImport) { res.status(503).json({ error: 'Bringing your memory is unavailable on this worker.' }); return; }
    const state = readSetupState(this.setupStatePath);
    if (state.choice?.branch !== 'go') { res.status(409).json({ error: 'Bringing your memory to CMEM is part of On The Go.' }); return; }
    try {
      const started = this.historyImport.start();
      res.setHeader('Cache-Control', 'no-store');
      res.status(202).json(started);
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  };

  private saveSetupState(state: SetupStateFile, res: Response): void {
    writeSetupState(state, this.setupStatePath);
    const view = this.setupStateView(state);
    this.broadcast('setup-state', view);
    res.setHeader('Cache-Control', 'no-store');
    res.json(view);
  }

  /** The choice can change until the installer acts on it; after that the installer holds the result. */
  private saveSetupChoice = (req: Request, res: Response): void => {
    const { branch, memoryBilling } = req.body as z.infer<typeof setupChoiceBody>;
    const state = readSetupState(this.setupStatePath);
    if (state.status === 'complete') { res.status(409).json({ error: 'Setup is already complete.', state: this.setupStateView(state) }); return; }
    const applied = state.installer && state.installer.stage !== 'waiting-for-choice' && state.installer.stage !== 'failed';
    if (applied && (state.choice?.branch !== branch || state.choice?.memoryBilling !== memoryBilling)) {
      res.status(409).json({ error: 'The installer already applied the earlier choice.', state: this.setupStateView(state) });
      return;
    }
    if (applied) { res.setHeader('Cache-Control', 'no-store'); res.json(this.setupStateView(state)); return; }
    this.saveSetupState({ ...state, choice: { branch, memoryBilling, chosenAt: new Date().toISOString() } }, res);
  };

  private saveInstallerStage = (req: Request, res: Response): void => {
    const { stage, error, checkout } = req.body as z.infer<typeof setupInstallerBody>;
    const state = readSetupState(this.setupStatePath);
    const now = new Date().toISOString();
    // A new installer run starts a fresh hand-off: a choice or checkout left by an earlier, interrupted run is not applied.
    const fresh = stage === 'waiting-for-choice';
    const choice = fresh ? null : state.choice;
    const checkoutState = fresh ? null : checkout
      ? { state: checkout, requests: state.checkout?.requests ?? 0, error: checkout === 'failed' ? error ?? null : null, updatedAt: now }
      : state.checkout;
    this.saveSetupState({ ...state, choice, checkout: checkoutState, installer: { stage, error: checkout ? state.installer?.error ?? null : error ?? null, updatedAt: now } }, res);
  };

  /** The page's Continue on Checkout: the installer holding the On The Go pairing opens the checkout (again, on a repeat). */
  private requestCheckout = (_req: Request, res: Response): void => {
    const state = readSetupState(this.setupStatePath);
    if (state.checkout?.state === 'paid') { res.setHeader('Cache-Control', 'no-store'); res.json(this.setupStateView(state)); return; }
    if (state.choice?.branch !== 'go' || state.installer?.stage !== 'go-awaiting-checkout') {
      res.status(409).json({ error: 'Checkout opens once the terminal has started your CMEM Pro sign-in.', state: this.setupStateView(state) });
      return;
    }
    const requests = (state.checkout?.requests ?? 0) + 1;
    this.saveSetupState({ ...state, checkout: { state: 'requested', requests, error: null, updatedAt: new Date().toISOString() } }, res);
  };

  private completeSetup = (req: Request, res: Response): void => {
    const { tools } = req.body as z.infer<typeof setupCompleteBody>;
    const state = readSetupState(this.setupStatePath);
    if (state.status === 'complete') { res.setHeader('Cache-Control', 'no-store'); res.json(this.setupStateView(state)); return; }
    if (!state.choice) { res.status(409).json({ error: 'Choose where to keep your memory before finishing setup.', state: this.setupStateView(state) }); return; }
    if (state.installer?.stage === 'go-awaiting-checkout' && state.checkout?.state !== 'paid') {
      res.status(409).json({ error: 'Finish checkout before finishing setup.', state: this.setupStateView(state) });
      return;
    }
    this.saveSetupState({ ...state, status: 'complete', tools: tools ?? state.tools, completedAt: new Date().toISOString() }, res);
  };

  private broadcast(event: string, value: unknown): void {
    if (this.closed) return;
    for (const client of this.clients) this.send(client, event, value);
  }

  private snapshot(): WorkViewSnapshot {
    this.source.localDeviceId = this.getLocalDeviceId();
    const snapshot = this.source.read().agentView;
    for (const request of snapshot.humanRequests) {
      request.contentFingerprint = contentFingerprint(request);
      request.review = this.reviews.read(request.id, request.contentFingerprint);
    }
    const reviewRevision = createHash('sha256').update(JSON.stringify(snapshot.humanRequests.map(request => [request.id, request.contentFingerprint, request.review]))).digest('hex').slice(0, 16);
    // Generated wording is display only: it never changes what was reviewed.
    const view = this.humanCopy ? this.humanCopy.observe(snapshot) as WorkViewSnapshot : snapshot;
    return { ...view, rulesFile: this.rulesFileStatus(snapshot), setup: this.setupView(view), revision: `${snapshot.revision}:${reviewRevision}:${this.humanCopy?.revision ?? 0}` };
  }

  /**
   * The funnel's view of setup: the scan and the extraction run (the automatic refresh's status). `step` is what is
   * being extracted now, read from what has landed: goals first, then work (request groups), then rules (the story).
   */
  private setupView(snapshot: WorkViewSnapshot) {
    const hosted = this.hostedIntent?.state();
    if (hosted && hosted.state !== 'idle') return { scan: this.setupScan?.state() ?? null, work: this.setupWork(), extraction: hosted };
    const refresh = this.autoRefresh?.status() ?? null;
    const view = snapshot as unknown as { goals?: unknown; story?: { groups?: number; story?: unknown } | null };
    const step = refresh?.state !== 'running' ? null : !view.goals ? 'goals' : !view.story?.groups ? 'work' : 'rules';
    return {
      scan: this.setupScan?.state() ?? null,
      work: this.setupWork(),
      extraction: refresh ? {
        state: refresh.state, reason: refresh.reason ?? null, step, agent: refresh.agent ?? null,
        startedAt: refresh.startedAt ?? null, finishedAt: refresh.finishedAt ?? null, error: refresh.error ?? null,
      } : null,
    };
  }

  /**
   * The newest overall requests in the ledger, with the latest prompt time of their conversations. `null` until the
   * grouping has run. A review without evidence (state `unknown`, every new install) gives no percent, so no bar.
   * Re-read only when the ledger changes.
   */
  private setupWork(): SetupWorkItem[] | null {
    if (!this.ledgerDir) return null;
    const signature = ledgerSignature(this.ledgerDir);
    if (this.setupWorkCache?.signature === signature) return this.setupWorkCache.work;
    const ledger = readLedger(this.ledgerDir);
    const groupIds = Object.keys(ledger.groups.groups);
    let work: SetupWorkItem[] | null = null;
    if (groupIds.length) {
      const conversationsOf = new Map<string, Array<[string, string]>>();
      for (const [key, groupId] of Object.entries(ledger.groups.conversations as Record<string, string>)) {
        const [, platform, contentSessionId] = JSON.parse(key) as [string, string, string];
        if (!conversationsOf.has(groupId)) conversationsOf.set(groupId, []);
        conversationsOf.get(groupId)!.push([platform, contentSessionId]);
      }
      const database = existsSync(this.databasePath) ? new Database(this.databasePath, { readonly: true, create: false }) : null;
      try {
        const lastPrompt = database?.prepare(`SELECT MAX(up.created_at_epoch) AS at FROM user_prompts up JOIN sdk_sessions s ON s.id = up.session_db_id
          WHERE s.platform_source = ? AND s.content_session_id = ?`);
        work = groupIds.map((groupId) => {
          const group = ledger.groups.groups[groupId];
          const lastEpoch = Math.max(0, ...(conversationsOf.get(groupId) ?? []).map(([platform, id]) => Number((lastPrompt?.get(platform, id) as { at: number | null } | null)?.at ?? 0)), group.anchorAsk?.atEpoch ?? 0);
          const review = ledger.progress[groupId];
          let platform: string | null = null;
          try { platform = (JSON.parse(group.anchor) as string[])[1] ?? null; } catch { /* An anchor that is not a conversation key names no agent. */ }
          return {
            groupId, title: String(group.title), platform, lastActiveAt: lastEpoch ? new Date(lastEpoch).toISOString() : null,
            progressPercent: review && review.state !== 'unknown' && Number.isFinite(review.percent) ? review.percent : null,
          };
        }).sort((left, right) => String(right.lastActiveAt ?? '').localeCompare(String(left.lastActiveAt ?? ''))).slice(0, SETUP_WORK_SHOWN);
      } finally { database?.close(); }
    }
    this.setupWorkCache = { signature, work };
    return work;
  }

  private rulesFileStatus(snapshot: WorkViewSnapshot) {
    const rules = (snapshot.rules ?? []) as SavedRule[];
    let instructions = '';
    try { instructions = readFileSync(this.claudeInstructionsPath, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return {
      path: homeRelative(this.rulesFilePath),
      instructionsPath: homeRelative(this.claudeInstructionsPath),
      approvedCount: renderRulesFile(rules).approvedCount,
      loadedInClaudeCode: instructions.split('\n').some(line => line.trim() === myRulesImportLine(this.rulesFilePath)),
    };
  }

  /** Rewrites MY-RULES.md through a temp file beside it, so a reader never sees half a file. */
  private writeRulesFile(rules: SavedRule[]): void {
    mkdirSync(dirname(this.rulesFilePath), { recursive: true });
    const temp = join(dirname(this.rulesFilePath), `.MY-RULES.md.${process.pid}.tmp`);
    writeFileSync(temp, renderRulesFile(rules).markdown, { mode: 0o644 });
    renameSync(temp, this.rulesFilePath);
  }

  private saveRule = (req: Request, res: Response): void => {
    const { action, ruleId, rule } = req.body as z.infer<typeof ruleBody>;
    if (!this.appendWorkStateEntry) { res.status(503).json({ error: 'Saving rules is unavailable on this worker.' }); return; }
    const snapshot = this.snapshot();
    if (!snapshot.source.connected) { res.status(503).json({ error: 'Local work is unavailable. Reconnect before changing rules.' }); return; }
    const rules = (snapshot.rules ?? []) as SavedRule[];
    const current = ruleId ? rules.find(entry => entry.ruleId === ruleId) : undefined;
    if (action !== 'add' && !current) { this.notFound(res, 'That rule is not in your rules.'); return; }
    if (['edit', 'add', 'replace'].includes(action) && !rule) { this.badRequest(res, 'Write the rule before saving it.'); return; }
    if (rule && rule.scopeTier !== 'everywhere' && !rule.scopeName.trim()) { this.badRequest(res, 'Name the project or situation this rule is for.'); return; }
    const written = rule ? {
      scopeTier: rule.scopeTier, scopeName: rule.scopeTier === 'everywhere' ? 'Everywhere' : rule.scopeName.trim(),
      when: rule.when.trim(), then: rule.then.trim(),
    } : {};
    const now = new Date().toISOString();
    const ownRule = (): SavedRule => ({
      ruleId: `own_${randomBytes(6).toString('hex')}`, scopeId: '', scopeTier: 'everywhere', scopeName: 'Everywhere', when: '', then: '',
      ...written, setBy: 'owner', status: 'on', kind: 'directive', source: 'you', timesSeen: 1, latestAt: now,
      quotes: [], replacedBy: null, replacedAt: null, savedAt: null,
    });
    const rows: Record<string, string | number | boolean | null>[] = [];
    if (action === 'add') rows.push(ruleRowFields(ownRule()));
    else if (action === 'replace') {
      const replacement = ownRule();
      rows.push(ruleRowFields(replacement), ruleRowFields({ ...current!, status: 'replaced', replacedBy: replacement.ruleId, replacedAt: now }));
    } else if (action === 'approve') rows.push(ruleRowFields({ ...current!, ...written, setBy: current!.setBy === 'learned' ? 'approved' : current!.setBy, status: 'on' }));
    else if (action === 'edit') rows.push(ruleRowFields({ ...current!, ...written }));
    else if (action === 'turn-on' || action === 'turn-off') {
      if (current!.status !== 'on' && current!.status !== 'off') { res.status(409).json({ error: 'Only a rule you set or approved can be turned on or off.', snapshot }); return; }
      rows.push(ruleRowFields({ ...current!, status: action === 'turn-on' ? 'on' : 'off' }));
    } else if (action === 'dismiss') rows.push(ruleRowFields({ ...current!, status: 'dismissed' }));
    else {
      // Back to the learned suggestion: clearing every saved field lets the story's version show again.
      if (!current!.ruleId.startsWith('pref_')) { res.status(409).json({ error: 'Only a learned rule can go back to being a suggestion.', snapshot }); return; }
      rows.push({ task: `Rule: ${current!.ruleId}`, rule_id: current!.ruleId, scope_tier: null, scope_name: null, when: null, then: null, set_by: null, status: null, source: null, replaced_by: null, replaced_at: null, quotes: null, times_seen: null, latest_at: null });
    }
    const project = this.homeProject ?? getProjectContext(homedir()).primary;
    for (const fields of rows) this.appendWorkStateEntry({ project, listName: MY_RULES_LIST, fields });
    const updated = this.snapshot();
    this.writeRulesFile((updated.rules ?? []) as SavedRule[]);
    logger.debug('HTTP', 'My Rules updated', { action });
    res.setHeader('Cache-Control', 'no-store');
    // The first row is the rule this change saved, so the page can name it without guessing from the snapshot.
    res.json({ ...updated, savedRuleId: rows[0].rule_id });
    this.publish(updated);
  };

  /** The owner's focus decisions, saved as my-focus rows. Owner rows are never overridden by a refresh. */
  private saveFocus = (req: Request, res: Response): void => {
    const { action, focusAreaId, name, goal, intoFocusAreaId, focusAreaIds, requestId } = req.body as z.infer<typeof focusBody>;
    if (!this.appendWorkStateEntry) { res.status(503).json({ error: 'Saving focus areas is unavailable on this worker.' }); return; }
    const snapshot = this.snapshot();
    if (!snapshot.source.connected) { res.status(503).json({ error: 'Local work is unavailable. Reconnect before changing focus areas.' }); return; }
    const areas = (snapshot.focusAreas ?? []) as FocusArea[];
    const areaById = new Map(areas.map(area => [area.focusAreaId, area]));
    const ownRow = (area: FocusArea, change: Partial<FocusArea>) => focusAreaRowFields({ ...area, ...change, decidedBy: 'owner' });
    const rows: Record<string, string | number | boolean | null>[] = [];

    if (action === 'reorder') {
      if (!focusAreaIds) { this.badRequest(res, 'List the focus areas in the order you want.'); return; }
      if (new Set(focusAreaIds).size !== focusAreaIds.length) { this.badRequest(res, 'Each focus area can appear once in the order.'); return; }
      const missing = focusAreaIds.find(id => !areaById.has(id));
      if (missing) { this.notFound(res, 'That focus area is not in your focus areas.'); return; }
      // The whole order of the kept areas at once, so no two share a rank. Only kept areas: an owner row on a suggestion
      // would freeze it against later refreshes, and done, dismissed and merged areas are not in the rail.
      const kept = areas.filter(area => area.status === 'kept' && !area.mergedInto).map(area => area.focusAreaId);
      if (focusAreaIds.length !== kept.length || !kept.every(id => focusAreaIds.includes(id))) {
        this.badRequest(res, 'List every kept focus area, each once, in the order you want.'); return;
      }
      focusAreaIds.forEach((id, index) => rows.push(ownRow(areaById.get(id)!, { ownerRank: index + 1 })));
    } else if (action === 'move-request') {
      if (!requestId || !focusAreaId) { this.badRequest(res, 'Choose the request and the focus area to move it to.'); return; }
      const request = snapshot.humanRequests.find(item => item.id === requestId);
      if (!request) { this.notFound(res, 'That request is not in your work.'); return; }
      if (!request.anchorConversationKey) { res.status(409).json({ error: 'This request has no conversation to file it under.', snapshot }); return; }
      if (focusAreaId !== OTHER_FOCUS_AREA_ID) {
        const target = areaById.get(focusAreaId);
        if (!target) { this.notFound(res, 'That focus area is not in your focus areas.'); return; }
        if (target.status === 'dismissed' || target.mergedInto) { res.status(409).json({ error: 'Move it to an area that is still in your focus.', snapshot }); return; }
      }
      rows.push(placementRowFields({ anchorConversationKey: request.anchorConversationKey, focusAreaId, placedBy: 'owner', evidence: 'Moved by you in My Work.' }));
    } else {
      const area = focusAreaId ? areaById.get(focusAreaId) : undefined;
      if (!area) { this.notFound(res, 'That focus area is not in your focus areas.'); return; }
      if (area.mergedInto && action !== 'restore-suggestion') { res.status(409).json({ error: 'This area was merged into another. Undo the merge first.', snapshot }); return; }
      if (action === 'keep') rows.push(ownRow(area, { status: 'kept' }));
      else if (action === 'dismiss') rows.push(ownRow(area, { status: 'dismissed' }));
      else if (action === 'done') rows.push(ownRow(area, { status: 'done' }));
      else if (action === 'rename') {
        if (!name) { this.badRequest(res, 'Write the new name before saving it.'); return; }
        const navWord = navWordIn(name);
        if (navWord) { this.badRequest(res, `"${name}" reuses the nav word "${navWord}". Pick a name that means only this area.`); return; }
        rows.push(ownRow(area, { name }));
      } else if (action === 'edit-goal') {
        if (!goal) { this.badRequest(res, 'Write the goal before saving it.'); return; }
        rows.push(ownRow(area, { goal }));
      } else if (action === 'merge') {
        if (!intoFocusAreaId) { this.badRequest(res, 'Choose the area to merge it into.'); return; }
        if (intoFocusAreaId === area.focusAreaId) { this.badRequest(res, 'An area cannot be merged into itself.'); return; }
        const target = areaById.get(intoFocusAreaId);
        if (!target) { this.notFound(res, 'That focus area is not in your focus areas.'); return; }
        // A target that is itself merged or dismissed could close a merge loop or hide the requests.
        if (target.status === 'dismissed' || target.mergedInto) { res.status(409).json({ error: 'Merge it into an area that is still in your focus.', snapshot }); return; }
        rows.push(ownRow(area, { mergedInto: target.focusAreaId }));
      } else {
        // Back to a suggestion: the undo for keep, merge and dismiss. An area the owner wrote was never a suggestion.
        if (area.source === 'owner') { res.status(409).json({ error: 'Only a suggested area can go back to being a suggestion.', snapshot }); return; }
        // owner-restore hands the area back: later refresh rows apply to it again.
        rows.push(focusAreaRowFields({ ...area, status: 'suggested', mergedInto: null, decidedBy: 'owner-restore' }));
      }
    }
    const project = this.homeProject ?? getProjectContext(homedir()).primary;
    for (const fields of rows) this.appendWorkStateEntry({ project, listName: MY_FOCUS_LIST, fields });
    const updated = this.snapshot();
    logger.debug('HTTP', 'My Focus updated', { action });
    res.setHeader('Cache-Control', 'no-store');
    res.json(updated);
    this.publish(updated);
  };

  /** Owner-goals' mined focus areas, as my-focus suggestions. Answers each mined area's id, in order. */
  private suggestOwnerGoalsAreas = (req: Request, res: Response): void => {
    const { areas } = req.body as z.infer<typeof ownerGoalsFocusBody>;
    if (!this.appendWorkStateEntry) { res.status(503).json({ error: 'Saving focus areas is unavailable on this worker.' }); return; }
    const snapshot = this.snapshot();
    if (!snapshot.source.connected) { res.status(503).json({ error: 'Local work is unavailable. Reconnect before saving focus areas.' }); return; }
    let planned: ReturnType<typeof ownerGoalsAreaRows>;
    try { planned = ownerGoalsAreaRows(areas, (snapshot.focusAreas ?? []) as FocusArea[]); }
    catch (error) { this.badRequest(res, error instanceof Error ? error.message : String(error)); return; }
    const project = this.homeProject ?? getProjectContext(homedir()).primary;
    for (const fields of planned.rows) this.appendWorkStateEntry({ project, listName: MY_FOCUS_LIST, fields });
    logger.debug('HTTP', 'Owner-goals focus areas saved', { mined: areas.length, rows: planned.rows.length });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ focusAreaIds: planned.focusAreaIds });
    if (planned.rows.length) this.publish();
  };

  /**
   * The focus step's answer as my-focus rows: router placements and `suggested` areas, written as the system. The
   * whole answer is checked against the saved areas before the first row is written, so a refusal (TypeError)
   * writes nothing. The automatic refresh calls this in-process; the skill's CLI reaches it through saveRouterFocus.
   */
  recordRouterFocus = (body: RouterFocusBody): { placed: number; focusAreaIds: string[] } => {
    if (!this.appendWorkStateEntry) throw new Error('Saving focus areas is unavailable on this worker.');
    const snapshot = this.snapshot();
    if (!snapshot.source.connected) throw new Error('Local work is unavailable. Reconnect before placing requests.');
    let planned: ReturnType<typeof routerFocusRows>;
    // Every row is built and size-checked before the first write: a refusal here (an unknown or dismissed area, a row too
    // long to save) wrote nothing, so it is a TypeError the refresh may answer again.
    try { planned = routerFocusRows(body, (snapshot.focusAreas ?? []) as FocusArea[]); }
    catch (error) { throw error instanceof RangeError ? new TypeError(error.message) : error; }
    const project = this.homeProject ?? getProjectContext(homedir()).primary;
    let written = 0;
    try {
      for (const fields of planned.rows) { this.appendWorkStateEntry({ project, listName: MY_FOCUS_LIST, fields }); written++; }
    } catch (error) {
      // A failure after a write is never a refusal: asking again would suggest the same areas twice.
      if (written) this.publish();
      throw new Error(`Saving the focus step stopped after ${written} of ${planned.rows.length} rows: ${error instanceof Error ? error.message : String(error)}`);
    }
    logger.debug('HTTP', 'Focus step saved', { placed: planned.placed, proposed: planned.focusAreaIds.length });
    if (planned.rows.length) this.publish();
    return { placed: planned.placed, focusAreaIds: planned.focusAreaIds };
  };

  private saveRouterFocus = (req: Request, res: Response): void => {
    let saved: { placed: number; focusAreaIds: string[] };
    try { saved = this.recordRouterFocus(req.body as z.infer<typeof routerFocusBody>); }
    catch (error) {
      if (error instanceof TypeError) { this.badRequest(res, error.message); return; }
      res.status(503).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json(saved);
  };

  /** The seed's rows, checked against the saved areas and placements before the first write (a refusal writes nothing). */
  private saveSeedFocus = (req: Request, res: Response): void => {
    const body = req.body as z.infer<typeof seedFocusBody>;
    if (!this.appendWorkStateEntry) { res.status(503).json({ error: 'Saving focus areas is unavailable on this worker.' }); return; }
    if (!this.snapshot().source.connected) { res.status(503).json({ error: 'Local work is unavailable. Reconnect before seeding focus areas.' }); return; }
    const served = existsSync(this.databasePath) ? realpathSync(this.databasePath) : this.databasePath;
    const expected = existsSync(body.databasePath) ? realpathSync(body.databasePath) : body.databasePath;
    if (served !== expected) { res.status(409).json({ error: `This worker serves ${served}, not ${expected}. Nothing was written.` }); return; }
    const database = new Database(this.databasePath, { readonly: true, create: false });
    let planned: ReturnType<typeof seedFocusRows> | ReturnType<typeof seedUndoRows>;
    try {
      const focus = readFocus(database, { localDeviceId: this.getLocalDeviceId() });
      planned = body.action === 'apply' ? seedFocusRows(body, focus) : seedUndoRows(body, focus);
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError) { this.badRequest(res, error.message); return; }
      throw error;
    } finally { database.close(); }
    const project = this.homeProject ?? getProjectContext(homedir()).primary;
    let written = 0;
    try {
      for (const fields of planned.rows) { this.appendWorkStateEntry({ project, listName: MY_FOCUS_LIST, fields }); written++; }
    } finally { if (written) this.publish(); }
    logger.debug('HTTP', 'Focus seed saved', { action: body.action, rows: written });
    const { rows: _rows, ...result } = planned;
    res.setHeader('Cache-Control', 'no-store');
    res.json({ action: body.action, rows: written, ...result });
  };

  /**
   * The owner says a subagent finished when no recorded stop covers it (one that
   * finished before the SubagentStop hook existed). Saved like a hook stop, with
   * its own source, so a later tool call from the agent still reopens it.
   */
  /** Counts the viewer opening on a page, or switching page, through the worker's own consent-gated, whitelist-scrubbed
   * telemetry (telemetry.ts), so the page loads no analytics SDK. The report names the page only — never what it showed. */
  private recordUsage = (req: Request, res: Response): void => {
    const report = req.body as z.infer<typeof usageBody>;
    if (report.event === 'opened') captureEvent('work_view_opened', { view: report.view });
    else captureEvent('work_view_switched', { view: report.view, previous_view: report.previousView });
    res.status(204).end();
  };

  private markAgentFinished = (req: Request, res: Response): void => {
    const { agentGroupId } = req.body as z.infer<typeof markAgentFinishedBody>;
    if (!this.appendWorkStateEntry) { res.status(503).json({ error: 'Saving agent state is unavailable on this worker.' }); return; }
    const snapshot = this.snapshot();
    if (!snapshot.source.connected) { res.status(503).json({ error: 'Local work is unavailable. Reconnect before changing an agent.' }); return; }
    const agent = (snapshot.agents as Array<{ id: string; isSubagent?: boolean; canMarkFinished?: boolean; agentId: string | null; agentType: string | null; platformSource: string | null; contentSessionId: string | null; project: string }>)
      .find(entry => entry.id === agentGroupId);
    if (!agent) { this.notFound(res, 'That agent is not in the loaded work.'); return; }
    if (!agent.isSubagent || !agent.agentId || !agent.contentSessionId) { res.status(409).json({ error: 'Only a subagent can be marked finished.', snapshot }); return; }
    if (!agent.canMarkFinished) { res.status(409).json({ error: 'This agent is already recorded as finished.', snapshot }); return; }
    const stoppedAtEpoch = Date.now();
    this.appendWorkStateEntry({
      project: agent.project,
      listName: AGENT_LIFECYCLE_LIST,
      fields: agentStopFields({
        platformSource: agent.platformSource, contentSessionId: agent.contentSessionId, agentId: agent.agentId,
        agentType: agent.agentType, stoppedAtEpoch, stopSource: 'owner-marked-finished',
      }),
    });
    logger.debug('HTTP', 'Agent marked finished by the owner');
    const updated = this.snapshot();
    res.setHeader('Cache-Control', 'no-store');
    res.json(updated);
    this.publish(updated);
  };

  /**
   * The owner's Join / Not this on a judge suggestion, written to the request ledger through the same
   * decisions the request-progress skill's `apply` takes (request-judge.mjs decideSuggestion). The
   * database is only read: projects and first asks for the decision.
   */
  private answerSuggestion = (req: Request, res: Response): void => {
    const { conversationKey, action } = req.body as z.infer<typeof suggestionBody>;
    if (!this.ledgerDir) { res.status(503).json({ error: 'Request suggestions are unavailable on this worker.' }); return; }
    if (!existsSync(this.databasePath)) { res.status(503).json({ error: 'Local work is unavailable. Reconnect before answering a suggestion.' }); return; }
    const database = new Database(this.databasePath, { readonly: true, create: false });
    let outcome: ReturnType<typeof decideSuggestion>;
    try { outcome = decideSuggestion({ dir: this.ledgerDir, database, conversationKey, action, now: Date.now() }); }
    finally { database.close(); }
    if (!outcome) { this.notFound(res, 'That suggestion is not waiting for an answer.'); return; }
    logger.debug('HTTP', 'Request suggestion answered', { action, status: outcome.status });
    const updated = this.snapshot();
    res.setHeader('Cache-Control', 'no-store');
    res.json(updated);
    this.publish(updated);
  };

  /** Adds the MY-RULES.md import to the user-level CLAUDE.md once. Never touches a project's CLAUDE.md or AGENTS.md. */
  private loadRulesInClaudeCode = (_req: Request, res: Response): void => {
    const snapshot = this.snapshot();
    if (!snapshot.source.connected) { res.status(503).json({ error: 'Local work is unavailable. Reconnect before loading rules.' }); return; }
    // Always from the saved rules: an existing file can predate rule changes received through sync.
    this.writeRulesFile((snapshot.rules ?? []) as SavedRule[]);
    if (!(snapshot.rulesFile as { loadedInClaudeCode: boolean }).loadedInClaudeCode) {
      let instructions = '';
      try { instructions = readFileSync(this.claudeInstructionsPath, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const separator = instructions === '' || instructions.endsWith('\n') ? '' : '\n';
      mkdirSync(dirname(this.claudeInstructionsPath), { recursive: true });
      appendFileSync(this.claudeInstructionsPath, `${separator}${myRulesImportLine(this.rulesFilePath)}\n`);
    }
    const updated = this.snapshot();
    res.setHeader('Cache-Control', 'no-store');
    res.json(updated);
    this.publish(updated);
  };

  private review = (req: Request, res: Response): void => {
    const { requestId, expectedFingerprint, checked } = req.body as z.infer<typeof reviewBody>;
    const snapshot = this.snapshot();
    if (!snapshot.source.connected) { res.status(503).json({ error: 'Local work is unavailable. Reconnect before reviewing.' }); return; }
    const request = snapshot.humanRequests.find(item => item.id === requestId);
    if (!request) { this.notFound(res, 'Request is outside the loaded work.'); return; }
    if (request.review?.available === false) { res.status(503).json({ error: 'Local review storage is unavailable. Your source work is unchanged.' }); return; }
    if (request.contentFingerprint !== expectedFingerprint) {
      res.status(409).json({ error: 'This work changed. Read the latest result before checking it.', snapshot });
      return;
    }
    if (checked && !isReportedReadyForCheck(request)) { res.status(409).json({ error: 'This request has not been reported complete.', snapshot }); return; }
    this.reviews.set(requestId, expectedFingerprint, checked);
    logger.debug('HTTP', 'Local work review updated', { checked });
    const updated = this.snapshot();
    res.setHeader('Cache-Control', 'no-store');
    res.json(updated);
    this.publish(updated);
  };

  private events = (req: Request, res: Response): void => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write('retry: 1000\n\n');
    this.clients.add(res);
    const socket = res.socket;
    const cleanup = () => {
      this.clients.delete(res);
      req.off('close', cleanup);
      res.off('close', cleanup);
      socket?.off('close', cleanup);
      if (!this.clients.size) this.stopTimers();
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
    socket?.on('close', cleanup);
    res.on('error', () => { cleanup(); res.destroy(); });
    this.send(res, 'work-view', this.snapshot());
    const scan: SetupScanState | undefined = this.setupScan?.state();
    if (scan && scan.phase !== 'idle') this.send(res, 'setup-scan', scan);
    // A reconnecting setup page may have missed checkout being paid or an import finishing: send where setup stands.
    // A setup state that cannot be read is logged and leaves the work feed running.
    try {
      const setupState = readSetupState(this.setupStatePath);
      if (setupState.status === 'pending') this.send(res, 'setup-state', this.setupStateView(setupState));
    } catch (error) {
      logger.error('HTTP', 'Setup state could not be read for a new event stream', {}, error as Error);
    }
    if (!this.poll) this.poll = setInterval(() => this.publish(), this.pollIntervalMs);
    if (!this.heartbeat) this.heartbeat = setInterval(() => {
      const snapshot = this.snapshot();
      for (const client of this.clients) this.send(client, 'heartbeat', { at: new Date().toISOString(), source: snapshot.source });
    }, 15000);
    this.poll?.unref(); this.heartbeat?.unref();
  };

  private send(res: Response, event: string, value: unknown): void {
    if (res.destroyed || res.writableEnded || res.writableLength > 4 * 1024 * 1024) {
      this.clients.delete(res); res.destroy(); return;
    }
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`); }
    catch { this.clients.delete(res); res.destroy(); }
  }

  private publish(snapshot = this.snapshot()): void {
    if (this.closed) return;
    // rulesFile changes without a new revision when the rules are loaded in Claude Code; other tabs must still see it.
    const signature = JSON.stringify([snapshot.revision, snapshot.source.connected, snapshot.source.error, snapshot.setup, snapshot.rulesFile]);
    if (signature === this.signature) return;
    this.signature = signature;
    for (const client of this.clients) this.send(client, 'work-view', snapshot);
  }

  private stopTimers(): void {
    if (this.poll) clearInterval(this.poll);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.poll = null; this.heartbeat = null;
  }

  getClientCount(): number { return this.clients.size; }

  close(): void {
    this.closed = true;
    this.unsubscribeSetupScan?.();
    this.unsubscribeHistoryImport?.();
    this.stopRulesSync();
    this.stopTimers();
    for (const client of this.clients) client.end();
    this.clients.clear();
    this.source.close();
    this.reviews.close();
    this.humanCopy?.close();
    this.autoRefresh?.close();
  }
}
