import type express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { z } from 'zod';
import { Database } from 'bun:sqlite';
import { CLAUDE_CONFIG_DIR, DATA_DIR, DB_PATH, getPackageRoot, USER_SETTINGS_PATH } from '../../../../shared/paths.js';
import { onContextInvalidation } from '../../../../shared/context-invalidation.js';
import { SettingsDefaultsManager } from '../../../../shared/SettingsDefaultsManager.js';
import { resolveOpenRouterChatCompletionsUrl } from '../../../../shared/openrouter-base-url.js';
import { logger } from '../../../../utils/logger.js';
import { hasForwardedClientHeaders, hasLoopbackHostHeader, isLocalhost } from '../../../../server/middleware/request-auth-helpers.js';
import { WorkStateSource, type WorkViewSnapshot } from '../../../work-view/data-source.mjs';
import { FILE_CONTENT_TYPES } from '../../../work-view/work-product.mjs';
import { contentFingerprint, LocalReviewStore } from '../../../work-view/review-store.js';
import { MY_RULES_LIST, renderRulesFile, ruleRowFields, type SavedRule } from '../../../work-view/my-rules.mjs';
import { AGENT_LIFECYCLE_LIST, agentStopFields } from '../../../work-view/agent-lifecycle.mjs';
import { getProjectContext } from '../../../../utils/project-name.js';
import { chatCompletionsHumanCopyProvider, HumanCopyWorker } from '../../../work-view/human-copy-worker.mjs';
import { AutoRefreshWorker } from '../../../work-view/auto-refresh-worker.mjs';
import { buildRefreshTask } from '../../../work-view/refresh-task.js';
import { HostedIntent } from '../../../work-view/hosted-intent.js';
import { cmemProOrigin } from '../../../../shared/cmem-gateway.js';
import { runAgentTask } from '../../../agent-runner/run.js';
import { ledgerSignature, readLedger } from '../../../work-view/request-groups.mjs';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
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

const markAgentFinishedBody = z.object({
  agentGroupId: z.string().min(1).max(2000),
}).strict();

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

type HumanCopyProvider = ReturnType<typeof chatCompletionsHumanCopyProvider>;

/** Readable request summaries use the observer endpoint the user already
 * configured. Other providers keep the recorded wording. */
export function configuredHumanCopyProvider(settingsPath = USER_SETTINGS_PATH): HumanCopyProvider | null {
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath, true, { readOnly: true });
  const apiKey = settings.CLAUDE_MEM_OPENROUTER_API_KEY?.trim();
  if (settings.CLAUDE_MEM_PROVIDER !== 'openrouter' || !apiKey) return null;
  return chatCompletionsHumanCopyProvider({
    url: resolveOpenRouterChatCompletionsUrl(settings.CLAUDE_MEM_OPENROUTER_BASE_URL),
    apiKey,
    model: settings.CLAUDE_MEM_OPENROUTER_MODEL,
  });
}

/** My Work's automatic refresh on the user's own logged-in agent, unless
 * CLAUDE_MEM_WORK_VIEW_AUTO_REFRESH is 'false' (checked on every tick). */
export function defaultAutoRefresh(ledgerDir: string, settingsPath = USER_SETTINGS_PATH, setupPath = setupStatePath(), setupActive = () => false): AutoRefreshWorker {
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
      const task = buildRefreshTask({ needs, reason, dataDir: DATA_DIR, ledgerDir, pluginRoot: getPackageRoot(), openDatabase });
      return { ...(await runAgentTask(task)), steps: task.steps };
    },
    log: (level, message, data) => (level === 'info' ? logger.info : logger.warn).call(logger, 'WORKER', message, data),
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
      ? new HumanCopyWorker({ provider: configuredHumanCopyProvider(), cachePath: join(DATA_DIR, 'work-view', 'human-copy.json') })
      : options.humanCopy;
    this.humanCopy?.pauseWhile(() => this.setupIsActive());
    if (this.humanCopy) void this.humanCopy.load().then(() => this.humanCopy?.start());
    // A test or demo with its own ledger never starts an agent unless it passes one in.
    this.autoRefresh = options.autoRefresh === undefined
      ? (options.ledgerDir === undefined && ledgerDir ? defaultAutoRefresh(ledgerDir, options.settingsPath, options.setupStatePath,
        () => this.setupIsActive()) : null)
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
    app.post('/api/work-view/review', workViewLoopbackOnly, requireWorkViewOrigin, validateBody(reviewBody), this.wrapHandler(this.review));
    app.post('/api/work-view/rules', workViewLoopbackOnly, requireWorkViewOrigin, validateBody(ruleBody), this.wrapHandler(this.saveRule));
    app.post('/api/work-view/agents/mark-finished', workViewLoopbackOnly, requireWorkViewOrigin, validateBody(markAgentFinishedBody), this.wrapHandler(this.markAgentFinished));
    app.post('/api/work-view/rules/load-in-claude-code', workViewLoopbackOnly, requireWorkViewOrigin, this.wrapHandler(this.loadRulesInClaudeCode));
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
    res.json(updated);
    this.publish(updated);
  };

  /**
   * The owner says a subagent finished when no recorded stop covers it (one that
   * finished before the SubagentStop hook existed). Saved like a hook stop, with
   * its own source, so a later tool call from the agent still reopens it.
   */
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
    const signature = JSON.stringify([snapshot.revision, snapshot.source.connected, snapshot.source.error, snapshot.setup]);
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
