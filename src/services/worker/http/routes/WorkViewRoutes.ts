import type express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
import { getProjectContext } from '../../../../utils/project-name.js';
import { chatCompletionsHumanCopyProvider, HumanCopyWorker } from '../../../work-view/human-copy-worker.mjs';
import { AutoRefreshWorker } from '../../../work-view/auto-refresh-worker.mjs';
import { buildRefreshTask } from '../../../work-view/refresh-task.js';
import { runAgentTask } from '../../../agent-runner/run.js';
import { detectUsableAgents } from '../../../agent-runner/detect.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { isForeignLoopbackBrowserWrite } from './SettingsRoutes.js';
import { validateBody } from '../middleware/validateBody.js';

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
}

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
export function defaultAutoRefresh(ledgerDir: string, settingsPath = USER_SETTINGS_PATH): AutoRefreshWorker {
  const openDatabase = () => {
    const database = new Database(DB_PATH, { readonly: true, create: false });
    database.exec('PRAGMA busy_timeout = 1500');
    return database;
  };
  return new AutoRefreshWorker({
    dir: ledgerDir,
    openDatabase,
    enabled: () => SettingsDefaultsManager.loadFromFile(settingsPath, true, { readOnly: true }).CLAUDE_MEM_WORK_VIEW_AUTO_REFRESH !== 'false',
    hasUsableAgent: async () => (await detectUsableAgents()).some(agent => agent.authenticated && agent.path),
    runJob: ({ needs, reason }) => runAgentTask(buildRefreshTask({ needs, reason, dataDir: DATA_DIR, ledgerDir, pluginRoot: getPackageRoot(), openDatabase })),
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

  constructor(options: WorkViewOptions = {}) {
    super();
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.getLocalDeviceId = options.getLocalDeviceId ?? (() => '');
    const ledgerDir = options.ledgerDir === undefined ? join(DATA_DIR, 'work-view') : options.ledgerDir;
    this.source = new WorkStateSource({
      databasePath: options.databasePath ?? DB_PATH,
      pollIntervalMs: this.pollIntervalMs,
      ledgerDir,
    });
    this.reviews = new LocalReviewStore(options.reviewPath ?? join(DATA_DIR, 'work-view-reviews.db'));
    this.humanCopy = options.humanCopy === undefined
      ? new HumanCopyWorker({ provider: configuredHumanCopyProvider(), cachePath: join(DATA_DIR, 'work-view', 'human-copy.json') })
      : options.humanCopy;
    if (this.humanCopy) void this.humanCopy.load().then(() => this.humanCopy?.start());
    // A test or demo with its own ledger never starts an agent unless it passes one in.
    this.autoRefresh = options.autoRefresh === undefined
      ? (options.ledgerDir === undefined && ledgerDir ? defaultAutoRefresh(ledgerDir) : null)
      : options.autoRefresh;
    this.autoRefresh?.start();
    this.appendWorkStateEntry = options.appendWorkStateEntry ?? null;
    this.homeProject = options.homeProject;
    this.rulesFilePath = options.rulesFilePath ?? join(DATA_DIR, 'MY-RULES.md');
    this.claudeInstructionsPath = options.claudeInstructionsPath ?? join(CLAUDE_CONFIG_DIR, 'CLAUDE.md');
    // Rule rows pulled from another device change what Claude Code should load; rebuild the file then too.
    this.stopRulesSync = onContextInvalidation(({ reason }) => {
      if (reason.startsWith('SyncApply.')) this.scheduleRulesFileRebuild();
    });
  }

  private stopRulesSync: () => void;
  private rulesRebuildScheduled = false;

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
    app.get('/api/work-view/file/:kind/:id/:index', workViewLoopbackOnly, this.wrapHandler((req, res) => {
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
    app.post('/api/work-view/rules/load-in-claude-code', workViewLoopbackOnly, requireWorkViewOrigin, this.wrapHandler(this.loadRulesInClaudeCode));
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
    return { ...view, rulesFile: this.rulesFileStatus(snapshot), revision: `${snapshot.revision}:${reviewRevision}:${this.humanCopy?.revision ?? 0}:${this.autoRefresh?.revision ?? 0}` };
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
    const signature = JSON.stringify([snapshot.revision, snapshot.source.connected, snapshot.source.error]);
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
