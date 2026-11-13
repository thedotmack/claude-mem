import type express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { Database } from 'bun:sqlite';
import { CLAUDE_CONFIG_DIR, DATA_DIR, DB_PATH, getPackageRoot, USER_SETTINGS_PATH } from '../../../../shared/paths.js';
import { currentContextGeneration, noteUserSettingsSaved, onContextInvalidation } from '../../../../shared/context-invalidation.js';
import { SettingsDefaultsManager } from '../../../../shared/SettingsDefaultsManager.js';
import { logger } from '../../../../utils/logger.js';
import { hasForwardedClientHeaders, hasLoopbackHostHeader, isLocalhost } from '../../../../server/middleware/request-auth-helpers.js';
import { WorkStateSource, type WorkViewSnapshot } from '../../../work-view/data-source.mjs';
import { WorkViewReadWorkerClient } from '../../../work-view/WorkViewReadWorkerClient.js';
import { boundedDurationMs, type WorkViewReadPurpose } from '../../../work-view/WorkViewReadProtocol.js';
import type { ViewerSyncStatus } from '../../../../shared/viewer-sync-status.js';
import { workViewOverview, workViewRequestDetail } from '../../../work-view/overview.js';
import { isAwaitingCheck, isReadyForCheck } from '../../../../ui/my-work/src/live/to-work-model.js';
import type { WorkViewHumanRequest as ApiHumanRequest } from '../../../../ui/my-work/src/live/work-view-api-types.js';
import { FILE_CONTENT_TYPES } from '../../../work-view/work-product.mjs';
import { isInsideDeliverablesDir } from '../../../../shared/deliverables.js';
import { contentFingerprint, priorContentFingerprint, LocalReviewStore } from '../../../work-view/review-store.js';
import { MY_RULES_LIST, renderRulesFile, ruleRowFields, type SavedRule } from '../../../work-view/my-rules.mjs';
import { focusAreaRowFields, MY_FOCUS_LIST, navWordIn, OTHER_FOCUS_AREA_ID, ownerGoalsAreaRows, placementRowFields, PROPOSAL_KINDS, readFocus, routerFocusRows, seedFocusRows, seedUndoRows, type FocusArea, type RouterFocusBody } from '../../../work-view/my-focus.mjs';
import { MAX_WORK_STATE_FIELDS_JSON_CHARS } from '../../../work-view/work-state-limits.mjs';
import { AGENT_LIFECYCLE_LIST, agentStopFields } from '../../../work-view/agent-lifecycle.mjs';
import { getProjectContext } from '../../../../utils/project-name.js';
import { chatCompletionsHumanCopyProvider, HumanCopyWorker } from '../../../work-view/human-copy-worker.mjs';
import { resolveOpenRouterConfig } from '../../OpenRouterProvider.js';
import { resolveOpenAICompatConfig } from '../../OpenAICompatProvider.js';
import { resolveOpenAICompatReasoning } from '../../reasoning-budget.js';
import { AutoRefreshWorker, refreshIntervalMs } from '../../../work-view/auto-refresh-worker.mjs';
import { buildRefreshTask } from '../../../work-view/refresh-task.js';
import { HostedIntent } from '../../../work-view/hosted-intent.js';
import { FocusShareError, FocusShares } from '../../../work-view/focus-share.js';
import { FocusSharePublisher } from '../../../work-view/focus-share-publisher.js';
import { cmemProOrigin } from '../../../../shared/cmem-gateway.js';
import { isOpenRouterApiUrl } from '../../../../shared/openrouter-base-url.js';
import { FOCUS_CHANGED_MESSAGE, focusChangeVersion } from '../../../../shared/focus-change-version.js';
import { runAgentTask, type AgentRunResult, type AgentTask } from '../../../agent-runner/run.js';
import { detectUsableAgents, type UsableAgent } from '../../../agent-runner/detect.js';
import { MAX_ANSWER_CHARS, OWNER_RUN_TOKEN_PATTERN, STAGE_DELIVERABLE_KIND, STAGE_FORMAT_ID_PATTERN, type OwnerRunStartState } from '../../../work-view/owner-runs.mjs';
import { OwnerRunStore } from '../../../work-view/owner-run-store.js';
import { deliverAnswer, resolveAnswerTarget } from '../../../work-view/answer-delivery.js';
import { readStageFormats, stageFormatInfo, type StageFormat, type StageFormatInfo } from '../../../work-view/stage-formats.js';
import { autoStageAfterRefresh, claimStage, generateStage, resolveAutoStageFormat, type StageClaim, type StageDependencies, type StageRequest } from '../../../work-view/stage-task.js';
import { focusPlanInput, planFocus, type PlanSourceRequest } from '../../../work-view/focus-plan-task.js';
import type { RecordDeliverableInput } from '../../../sqlite/deliverables.js';
import { updateSettingsDocument } from '../../../../shared/settings-document.js';
import { ledgerSignature, readLedger } from '../../../work-view/request-groups.mjs';
import { configuredJudge, decideSuggestion, jevClientFromSettings } from '../../../work-view/request-judge.mjs';
import { labelOpenWorkState } from '../../../work-view/work-state-labels.mjs';
import { configuredFocusJudge } from '../../../work-view/focus-judge.mjs';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { captureEvent } from '../../../telemetry/telemetry.js';
import { isForeignLoopbackBrowserWrite } from './SettingsRoutes.js';
import { validateBody } from '../middleware/validateBody.js';
import type { SetupScan, SetupScanState } from '../../../prompt-import/setup-scan.js';
import { readHistoryCounts, type HistoryImport } from '../../../setup/history-import.js';
import { createSetupTelemetry } from '../../../setup/telemetry.js';
import { createSetupInstallerResumer } from '../../../setup/resume-installer.js';
import { hasActiveSetupSession, hasProConfiguration, readSetupState, setupStatePath, writeSetupState, type SetupStateFile, type SetupStateView } from '../../../../shared/setup-state.js';
import { SETUP_BRANCHES, SETUP_INSTALLER_STAGES, SETUP_MEMORY_BILLINGS } from '../../../../shared/setup-funnel.js';
import { hasPendingInstallSetup, SETUP_INSTALL_STATUSES } from '../../../../shared/setup-install.js';

/** True while a process with this pid exists (signal 0 checks without signalling). */
function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** What a stage file is served under: no script, no styles, no images, no connections, forms or navigation, in a sandbox with no permissions. */
export const STAGE_CONTENT_SECURITY_POLICY = "default-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'; sandbox";

/** Recorded files plus the text kinds an agent attaches as a deliverable, served so a browser shows them rather than downloads them. */
const DELIVERABLE_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ...FILE_CONTENT_TYPES,
  '.md': 'text/plain; charset=utf-8', '.markdown': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.rst': 'text/plain; charset=utf-8', '.json': 'text/plain; charset=utf-8',
};

const reviewBody = z.object({
  requestId: z.string().min(1).max(2000),
  expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  expectedReviewHash: z.string().min(1).max(128).nullable().optional(),
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

// Reads that return share links or comments: the viewer's own page only. Worker CORS lets other local pages read
// responses, and a cross-origin fetch carries its Origin.
function requireWorkViewReadOrigin(req: Request, res: Response, next: NextFunction): void {
  if (req.get('sec-fetch-site') === 'cross-site' || isForeignLoopbackBrowserWrite(req)) {
    res.status(403).json({ error: 'Sharing is available only from the local work viewer.' });
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
  expectedVersion: z.string().min(1).optional(),
}).strict();

// The focus areas owner-goals mined from the owner's prompts (save_goals.py). Same name and goal bounds as
// focusBody. The evidence is one line pointing at the owner-goals item that holds the quotes; 300 characters
// keeps the whole area inside one 2000-character work-state row. No count cap: the owner has as many areas as they have.
const ownerGoalsFocusBody = z.object({
  save_key: z.string().regex(/^[a-f0-9]{24}:[a-f0-9]{64}$/).optional(),
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

// Owner runs: one click, one agent run (owner-runs.mjs). The token is the click's own id, made by the page.
const ownerRunToken = z.string().regex(OWNER_RUN_TOKEN_PATTERN);
const stageFormatIdField = z.string().regex(STAGE_FORMAT_ID_PATTERN);
const answerBody = z.object({ requestId: z.string().min(1).max(2000), text: z.string().trim().min(1).max(MAX_ANSWER_CHARS), token: ownerRunToken }).strict();
const stageBody = z.object({ requestId: z.string().min(1).max(2000), formatId: stageFormatIdField, token: ownerRunToken }).strict();
const autoStageBody = z.object({ formatId: stageFormatIdField.nullable() }).strict();
const focusPlanBody = z.object({ focusAreaId: focusAreaIdField.nullable(), token: ownerRunToken }).strict();

const markAgentFinishedBody = z.object({
  agentGroupId: z.string().min(1).max(2000),
}).strict();

// Shared focus pages. cmem.ai checks the page's shape (src/lib/focus-share/snapshot.ts there); here it only has to be an object.
const focusShareAreaBody = z.object({ focusAreaId: focusAreaIdField }).strict();
const focusShareCommentBody = z.object({ focusAreaId: focusAreaIdField, body: z.string().trim().min(1).max(4000) }).strict();

/** The owner's answer to the judge's "Looks like part of <request>" on a card. */
const suggestionBody = z.object({
  conversationKey: z.string().min(1).max(2000),
  action: z.enum(['join', 'not-this']),
  expectedSuggestionHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
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
  // Claude Code ends @path at an unescaped space; quoting the path is not an import.
  return `@${homeRelative(rulesFilePath).replaceAll(' ', '\\ ')}`;
}

interface WorkStateWrite { project: string; listName: string; fields: Record<string, string | number | boolean | null> }

interface WorkViewOptions {
  saveSharedReview?: (input: { descriptor: import('../../../work-view/shared-reviews.mjs').SharedReviewDescriptor; checked: boolean; expectedHash: string | null }) => { changed: number };
  prepareSharedOwnerAction?: () => Promise<void>;
  answerSharedSuggestion?: (conversationKey: string, action: 'join' | 'not-this', expectedHash: string | null) => unknown;
  persistSharedCopy?: (requestId: string, entry: { fingerprint: string; copy: unknown; generatedAt: number }) => void;
  saveSharedLedgerFile?: (name: string, value: unknown) => void;
  getSharedStatus?: () => Record<string, unknown>;
  getSyncStatus?: () => ViewerSyncStatus;
  updateViewerActivity?: (viewerId: string, visible: boolean, sequence: number) => boolean;
  databasePath?: string;
  reviewPath?: string;
  pollIntervalMs?: number;
  getLocalDeviceId?: () => string;
  humanCopy?: HumanCopyWorker | null;
  /** Runs owner-goals and request-progress when something is due. Omitted: on for the default ledger only. */
  autoRefresh?: AutoRefreshWorker | null;
  /** Overall-request ledger written by the request-progress skill; null disables it. */
  ledgerDir?: string | null;
  /** Where each tool keeps its transcripts, read for whose move a chat is; the tools' own folders unless a test names others. */
  transcriptRoots?: { claudeProjectsDir?: string; codexHome?: string };
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
  /** Starts the installed setup executor when a person opens deferred onboarding. */
  resumeSetup?: (retry?: boolean) => Promise<void>;
  setupTelemetry?: ReturnType<typeof createSetupTelemetry>;
  /** Read for `alreadyPro`; defaults to ~/.claude-mem/settings.json. */
  settingsPath?: string;
  /** Finish Setup's history upload to CMEM Pro. Without it POST /api/setup/import answers 503. */
  historyImport?: HistoryImport | null;
  /** Setup extraction only. Ongoing automatic refresh continues to use the local agent runner. */
  hostedIntent?: Pick<HostedIntent, 'run' | 'state'> | null;
  /** Shared focus pages on cmem.ai. Defaults to the cloud sync credential and focus-shares.json beside settings.json. */
  focusShares?: Pick<FocusShares, 'connected' | 'list' | 'publish' | 'stop' | 'comments' | 'comment'> | null;
  /** How often shared focus pages are republished from this worker; 0 stops the timer (tests). */
  focusSharePublishEveryMs?: number;
  /** Runs a stage or a focus plan on the owner's own agent; the shared runner (runAgentTask) unless a test injects one. */
  runAgent?: (task: AgentTask) => Promise<AgentRunResult>;
  /** Which agent tools are installed and logged in, for sending an answer. */
  detectAgents?: () => Promise<UsableAgent[]>;
  /** Starts the answer's tool and a stage's `git show`; a test injects a fake. */
  spawnImpl?: typeof spawn;
  /** Records a stage's file in the deliverables table so the deliverables route serves it. Without it a stage has no link. */
  recordDeliverable?: ((input: RecordDeliverableInput) => { id: number }) | null;
  /** The installed plugin folder holding skills/; the package root unless a test names one. */
  pluginRoot?: string;
}

/** One overall request on the Reveal, read from the request-group ledger so new installs (prompts only) have work too. */
export interface SetupWorkItem { groupId: string; title: string; platform: string | null; lastActiveAt: string | null; progressPercent: number | null }
const SETUP_WORK_SHOWN = 5;

const setupScanBody = z.object({ improveProduct: z.boolean().optional() }).strict();
const setupScanConsentBody = z.object({ upload: z.boolean(), agents: z.array(z.enum(['claude-code', 'codex', 'gemini-cli', 'antigravity-cli', 'opencode'])).optional(), improveProduct: z.boolean().optional() }).strict();
const setupScanPreferencesBody = z.object({ improveProduct: z.boolean() }).strict();
// Request-size and abuse caps on loopback writes, set about twice what the installer offers today (measured
// 2026-11-11: 19 agents in ide-detection.ts, 30 bundled skills, the longest id 17 characters). The email cap is RFC 5321's 254-character path
// limit; the note and error caps match the setup page's textarea and the installer's other setup errors.
const setupInstallId = z.string().min(1).max(80);
const setupInstallSelectionBody = z.object({
  agents: z.array(setupInstallId).min(1).max(40),
  skills: z.array(setupInstallId).max(200),
  installClaudeCode: z.boolean(),
  disableAutoMemory: z.boolean(),
  telemetryEnabled: z.boolean(),
  email: z.union([z.literal(''), z.email().max(254)]).optional(),
  note: z.string().max(2000).optional(),
  emailProvided: z.boolean().optional(),
  claudeModel: z.string().trim().min(1).max(200).optional(),
  dshProfile: z.string().trim().min(1).max(200).optional(),
}).strict();
const setupInstallCatalogBody = z.object({
  agents: z.array(z.object({ id: setupInstallId, label: z.string().max(200), hint: z.string().max(1000), detected: z.boolean() }).strict()).min(1).max(40),
  skills: z.array(z.object({ id: setupInstallId, label: z.string().max(200), description: z.string().max(2000), required: z.boolean().optional() }).strict()).max(200),
  defaults: setupInstallSelectionBody,
  reinstall: z.boolean(),
  telemetryLocked: z.boolean().optional(),
  skillsLocked: z.boolean().optional(),
  emailEnabled: z.boolean().optional(),
  signupSaved: z.boolean().optional(),
}).strict();
const setupInstallReportBody = z.object({
  status: z.enum(SETUP_INSTALL_STATUSES),
  catalog: setupInstallCatalogBody.optional(),
  error: z.string().max(2000).nullable().optional(),
}).strict();
/**
 * Localhost pages can read the worker's setup state (GET /api/setup/state and the `setup-state` event frame), and
 * the signup email and note are data no such page may read (SettingsRoutes keeps them out of /api/settings too).
 * Only the installer reads them, from the state file.
 */
function redactSetupInstall(install: SetupStateFile['install']): SetupStateFile['install'] {
  if (!install?.selection) return install;
  const { email, note: _note, ...selection } = install.selection;
  return { ...install, selection: email ? { ...selection, emailProvided: true } : selection };
}

// On The Go is always CMEM Pro: standalone Cloud Sync on your own tokens has no price yet (gap G1).
const setupChoiceBody = z.object({
  branch: z.enum(SETUP_BRANCHES),
  memoryBilling: z.enum(SETUP_MEMORY_BILLINGS),
}).strict().refine(choice => choice.branch === 'home' || choice.memoryBilling === 'hosted', {
  message: 'On The Go uses CMEM Pro (memoryBilling "hosted").',
});
const setupInstallerBody = z.object({
  stage: z.enum(SETUP_INSTALLER_STAGES),
  error: z.string().max(2000).nullable().optional(),
  /** The installer mirrors the pairing checkout it is running (funnel Phase 8). */
  checkout: z.enum(['waiting', 'paid', 'failed']).optional(),
}).strict();
const setupCheckoutBody = z.object({}).strict();
const setupResumeBody = z.object({ retry: z.boolean().optional() }).strict();
const setupCompleteBody = z.object({
  /** Finish Setup's picked tools; the installer sets up the local ones it has not installed. */
  // Abuse cap: Finish Setup lists the selected agents (19 offered today) plus 3 cloud readers, so 40 leaves room.
  tools: z.array(z.string().min(1).max(40)).max(40).optional(),
  // Checked separately so a bad analytics payload cannot block real setup.
  telemetry: z.unknown().optional(),
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
  localDeviceId: () => string, saveFocus: (body: RouterFocusBody) => { placed: number; focusAreaIds: string[] } | Promise<{ placed: number; focusAreaIds: string[] }>,
  afterRefresh: (refreshState: string, startedAtEpoch: number) => Promise<unknown> = async () => {}): AutoRefreshWorker {
  const openDatabase = () => {
    const database = new Database(DB_PATH, { readonly: true, create: false });
    database.exec('PRAGMA busy_timeout = 1500');
    return database;
  };
  // Setup's only extraction is hosted. Once setup is complete, ongoing refresh keeps its existing local path.
  const setupRunning = () => {
    const state = readSetupState(setupPath);
    return setupActive() || hasPendingInstallSetup(state) || (state.status !== 'complete' && hasActiveSetupSession(setupPath));
  };
  return new AutoRefreshWorker({
    dir: ledgerDir,
    openDatabase,
    setupRunning,
    checkMs: refreshIntervalMs(SettingsDefaultsManager.loadFromFile(settingsPath, true, { readOnly: true }).CLAUDE_MEM_WORK_VIEW_REFRESH_INTERVAL_MIN),
    enabled: () => !setupRunning()
      && SettingsDefaultsManager.loadFromFile(settingsPath, true, { readOnly: true }).CLAUDE_MEM_WORK_VIEW_AUTO_REFRESH !== 'false',
    runJob: async ({ needs, reason }) => {
      // The judges are read from settings per run, so a provider change applies to the next refresh.
      const task = buildRefreshTask({ needs, reason, dataDir: DATA_DIR, ledgerDir, pluginRoot: getPackageRoot(), openDatabase, localDeviceId, saveFocus,
        judge: configuredJudge(settingsPath), focusJudge: configuredFocusJudge(settingsPath) });
      const startedAtEpoch = Date.now();
      const outcome = { ...(await runAgentTask(task)), steps: task.steps };
      // The owner's opt-in automatic stages follow a refresh that ran; their failure is theirs, never the refresh's.
      await afterRefresh(outcome.state, startedAtEpoch).catch(error => logger.warn('WORKER', 'Automatic stages after the refresh failed', { error: error instanceof Error ? error.message : String(error) }));
      return outcome;
    },
    // Jev labels open work-state items on every check; read from settings each time, like the judges.
    labelWorkState: async () => {
      const client = jevClientFromSettings(SettingsDefaultsManager.loadFromFile(settingsPath, true, { readOnly: true }));
      if (!client) return null;
      const database = openDatabase();
      try { return await labelOpenWorkState({ dir: ledgerDir, database, client, localDeviceId: localDeviceId() }); }
      finally { database.close(); }
    },
    log: (level, message, data) => (level === 'info' ? logger.info : logger.warn).call(logger, 'WORKER', message, data),
    localDeviceId,
  });
}


/**
 * How long a background read may reuse the last activity signature (observations, prompts, sessions) instead of
 * recomputing it. 120 s is the window measured in #5124: on a 2.85 GB database with 4 live sessions, recomputing
 * activity at most every 120 s kept /api/health at a 7 ms median (85 probes, none above 0.2 s) with an event stream
 * open, versus 30 s stalls when it ran every 1 s tick. The owner asked for this window plus that health-probe
 * measurement as the regression check. Work-state, title-cache and ledger changes always bypass it.
 */
const ACTIVITY_REFRESH_WINDOW_MS = 120_000;

export class WorkViewRoutes extends BaseRouteHandler {
  private readonly saveSharedReview: WorkViewOptions['saveSharedReview'];
  private readonly prepareSharedOwnerAction: WorkViewOptions['prepareSharedOwnerAction'];
  private readonly answerSharedSuggestion: WorkViewOptions['answerSharedSuggestion'];
  private saveSharedLedgerFile: WorkViewOptions['saveSharedLedgerFile'];
  private readonly getSharedStatus: WorkViewOptions['getSharedStatus'];
  private readonly getSyncStatus: (() => ViewerSyncStatus) | undefined;
  private readonly updateViewerActivity: WorkViewOptions['updateViewerActivity'];
  private source: WorkStateSource;
  private sourceReader: WorkViewReadWorkerClient;
  private lastSnapshotDiagnostic: { purpose: WorkViewReadPurpose; postprocessMs: number } | null = null;
  private lastResponseDiagnostic: { transport: 'http' | 'sse'; writeMs: number; bytes: number } | null = null;
  private pendingBackgroundSnapshot: Promise<WorkViewSnapshot> | null = null;
  private ownerEditsDone: Promise<unknown> = Promise.resolve();
  private freshPublishReading = false;
  private freshPublishWanted = false;
  private reviews: LocalReviewStore;
  private clients = new Set<Response>();
  private overviewClients = new Set<Response>();
  private pendingBootstrap: { fence: string; promise: Promise<WorkViewSnapshot> } | null = null;
  private ownerReadFence = 0;
  private ownerEditActive = false;
  private overviewSignature = '';
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
  private setupTelemetry: ReturnType<typeof createSetupTelemetry> | null = null;
  private settingsPath: string;
  private unsubscribeSetupScan: (() => void) | null = null;
  private ledgerDir: string | null;
  private databasePath: string;
  private setupWorkCache: { signature: string; work: SetupWorkItem[] | null } | null = null;
  private historyImport: HistoryImport | null;
  private unsubscribeHistoryImport: (() => void) | null = null;
  private hostedIntent: Pick<HostedIntent, 'run' | 'state'> | null;
  private focusShares: NonNullable<WorkViewOptions['focusShares']> | null;
  private focusSharePublisher: FocusSharePublisher | null;
  private ownerRuns: OwnerRunStore | null;
  private ownerRunsInFlight = new Set<Promise<unknown>>();
  private runAgent: (task: AgentTask) => Promise<AgentRunResult>;
  private detectAgents: () => Promise<UsableAgent[]>;
  private spawnImpl: typeof spawn;
  private recordDeliverable: WorkViewOptions['recordDeliverable'];
  private pluginRoot: string;
  private stageSettingsRead: { at: number; value: { stageFormats: StageFormatInfo[]; autoStageFormat: string | null } } | null = null;
  private resumeSetup: (retry?: boolean) => Promise<void>;

  constructor(options: WorkViewOptions = {}) {
    super();
    this.saveSharedReview = options.saveSharedReview;
    this.prepareSharedOwnerAction = options.prepareSharedOwnerAction;
    this.answerSharedSuggestion = options.answerSharedSuggestion;
    this.saveSharedLedgerFile = options.saveSharedLedgerFile;
    this.getSharedStatus = options.getSharedStatus;
    this.getSyncStatus = options.getSyncStatus;
    this.updateViewerActivity = options.updateViewerActivity;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.getLocalDeviceId = options.getLocalDeviceId ?? (() => '');
    const ledgerDir = options.ledgerDir === undefined ? join(DATA_DIR, 'work-view') : options.ledgerDir;
    this.ledgerDir = ledgerDir;
    this.databasePath = options.databasePath ?? DB_PATH;
    this.source = new WorkStateSource({
      databasePath: options.databasePath ?? DB_PATH,
      pollIntervalMs: this.pollIntervalMs,
      ledgerDir,
      transcriptRoots: options.transcriptRoots,
    });
    this.sourceReader = new WorkViewReadWorkerClient({ databasePath: options.databasePath ?? DB_PATH, ledgerDir, pollIntervalMs: this.pollIntervalMs, transcriptRoots: options.transcriptRoots });
    this.reviews = new LocalReviewStore(options.reviewPath ?? join(DATA_DIR, 'work-view-reviews.db'));
    this.humanCopy = options.humanCopy === undefined
      ? new HumanCopyWorker({ provider: configuredHumanCopyProvider(), cachePath: join(DATA_DIR, 'work-view', 'human-copy.json'), persistSharedCopy: options.persistSharedCopy,
        warn: message => logger.warn('WORKER', message) })
      : options.humanCopy;
    this.humanCopy?.pauseWhile(() => this.setupIsActive());
    if (this.humanCopy) void this.humanCopy.load().then(() => this.humanCopy?.start());
    // A test or demo with its own ledger never starts an agent unless it passes one in.
    this.autoRefresh = options.autoRefresh === undefined
      ? (options.ledgerDir === undefined && ledgerDir ? defaultAutoRefresh(ledgerDir, options.settingsPath, options.setupStatePath,
        () => this.setupIsActive(), () => this.getLocalDeviceId(), body => this.recordRouterFocus(body),
        (refreshState, startedAtEpoch) => this.autoStage(refreshState, startedAtEpoch)) : null)
      : options.autoRefresh;
    this.runAgent = options.runAgent ?? (task => runAgentTask(task));
    this.detectAgents = options.detectAgents ?? (() => detectUsableAgents());
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.recordDeliverable = options.recordDeliverable ?? null;
    this.pluginRoot = options.pluginRoot ?? getPackageRoot();
    this.ownerRuns = ledgerDir ? new OwnerRunStore(ledgerDir) : null;
    // A run this worker never finished was cut off by a restart: it is marked failed, and nothing starts it again.
    try { this.ownerRuns?.repairInterrupted(); }
    catch (error) { logger.warn('WORKER', 'Owner runs could not be read at startup', { error: error instanceof Error ? error.message : String(error) }); }
    this.autoRefresh?.start();
    this.appendWorkStateEntry = options.appendWorkStateEntry ?? null;
    this.homeProject = options.homeProject;
    this.rulesFilePath = options.rulesFilePath ?? join(DATA_DIR, 'MY-RULES.md');
    this.claudeInstructionsPath = options.claudeInstructionsPath ?? join(CLAUDE_CONFIG_DIR, 'CLAUDE.md');
    this.setupScan = options.setupScan ?? null;
    this.setupStatePath = options.setupStatePath ?? setupStatePath();
    this.resumeSetup = options.resumeSetup ?? createSetupInstallerResumer(this.setupStatePath, {
      onStateChange: () => this.broadcast('setup-state', this.setupStateView()),
    });
    this.setupTelemetry = options.setupTelemetry ?? null;
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
    this.focusShares = options.focusShares === undefined
      ? new FocusShares({
        origin: () => cmemProOrigin(),
        registryPath: join(dirname(this.settingsPath), 'focus-shares.json'),
        credentials: () => {
          const settings = SettingsDefaultsManager.loadFromFile(this.settingsPath, true, { readOnly: true });
          return { token: settings.CLAUDE_MEM_CLOUD_SYNC_TOKEN?.trim() ?? '', userId: settings.CLAUDE_MEM_CLOUD_SYNC_USER_ID?.trim() ?? '' };
        },
      })
      : options.focusShares;
    // Shared pages keep updating with My Work closed (R17.3): the worker publishes them on its own timer.
    this.focusSharePublisher = this.focusShares
      ? new FocusSharePublisher({ shares: this.focusShares, snapshot: () => this.snapshot(0, 'shared-focus'), everyMs: options.focusSharePublishEveryMs })
      : null;
    this.focusSharePublisher?.start();
    if (this.hostedIntent) this.setupScan?.setExtractor((prompts, improveProduct) => this.hostedIntent!.run(prompts, improveProduct));
    this.unsubscribeHistoryImport = this.historyImport?.subscribe(state => this.broadcast('setup-import', state)) ?? null;
    // Hosted extraction is awaited inside the scan, so failures stay in the scan screen's error slot.
    this.unsubscribeSetupScan = this.setupScan?.subscribe(state => {
      this.publish();
      this.broadcast('setup-scan', state);
    }) ?? null;
    // Rule rows pulled from another device change what Claude Code should load; rebuild the file then too.
    this.stopRulesSync = onContextInvalidation(({ reason, kind, changes }) => {
      if (kind === 'removal' || reason.startsWith('SyncApply.') || changes?.kinds.some(kind => ['observation', 'summary', 'prompt', 'work_state', 'mutation'].includes(kind))
        || ['storeObservations', 'storeSummary', 'importObservation', 'importSessionSummary'].includes(reason)) {
        this.sourceReader.invalidateActivity(kind === 'removal' || (!changes && reason.startsWith('SyncApply.'))
          || Boolean(changes?.kinds.some(kind => kind === 'work_state' || kind === 'mutation')));
        if (!this.ownerEditActive) this.publish();
      }
      if (!reason.startsWith('SyncApply.')) return;
      // Older senders have no details, so keep their conservative rebuild. Known
      // observation/prompt pages cannot change MY-RULES.md.
      if (!changes || changes.kinds.includes('mutation')
        || (changes.kinds.includes('work_state') && (!changes.workStateLists || changes.workStateLists.includes(MY_RULES_LIST)))) {
        this.scheduleRulesFileRebuild();
      }
    });
  }

  private stopRulesSync: () => void;
  private rulesRebuildScheduled = false;
  private rulesRebuildWanted = false;

  private setupIsActive(): boolean {
    const statePath = this.setupStatePath ?? setupStatePath();
    const scanPhase = this.setupScan?.state().phase ?? 'idle';
    // Waiting for the upload answer is not active: a closed tab never answers, and that must not hold local work
    // paused. The installer's session below still covers a setup in progress; reopening the page rejoins the question.
    if (!['idle', 'done', 'failed', 'awaiting-consent'].includes(scanPhase)) return true;
    const state = readSetupState(statePath);
    return hasPendingInstallSetup(state) || (state.status !== 'complete' && hasActiveSetupSession(statePath));
  }

  private scheduleRulesFileRebuild(): void {
    if (this.closed) return;
    if (this.rulesRebuildScheduled) { this.rulesRebuildWanted = true; return; }
    this.rulesRebuildScheduled = true;
    setImmediate(() => {
      if (this.closed) { this.rulesRebuildScheduled = false; return; }
      void this.rebuildRulesFileFromSavedRules()
        .catch(error => logger.warn('HTTP', 'Could not rebuild MY-RULES.md after sync', { error: error instanceof Error ? error.message : String(error) }))
        .finally(() => {
          this.rulesRebuildScheduled = false;
          if (!this.rulesRebuildWanted) return;
          this.rulesRebuildWanted = false;
          this.scheduleRulesFileRebuild();
        });
    });
  }

  /** Rewrites MY-RULES.md when the saved rules render differently. Never from an unreadable source, which reads as no rules. */
  rebuildRulesFileFromSavedRules(): Promise<boolean> {
    return this.inOwnerEditOrder(async () => {
      const view = await this.sourceReader.readRules(this.getLocalDeviceId());
      if (!view.source.connected) return false;
      const markdown = renderRulesFile((view.rules ?? []) as SavedRule[]).markdown;
      let current: string | null = null;
      try { current = readFileSync(this.rulesFilePath, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (current === markdown) return false;
      this.writeRulesFile((view.rules ?? []) as SavedRule[]);
      return true;
    });
  }

  /**
   * Runs a read-check-write of the owner's state after every edit before it. The read now happens off this thread, so
   * without this two edits could both check the same view and both save (A merged into B and B into A), or a read from
   * before a save could rewrite MY-RULES.md after it. A failed edit does not stop the next one.
   */
  private inOwnerEditOrder<T>(edit: () => T | Promise<T>): Promise<T> {
    this.ownerReadFence++;
    const result = this.ownerEditsDone.then(async () => {
      this.ownerEditActive = true;
      try { return await edit(); }
      finally {
        // A bootstrap may start while this asynchronous edit is still reading.
        // Fence that read again when the edit settles, before the next caller
        // can reuse a projection from before the write.
        this.ownerReadFence++;
        this.ownerEditActive = false;
      }
    });
    this.ownerEditsDone = result.catch(() => undefined);
    return result;
  }

  private ownerEdit(handler: (req: Request, res: Response) => Promise<void>) {
    return (req: Request, res: Response) => this.inOwnerEditOrder(() => handler(req, res));
  }

  setupRoutes(app: express.Application): void {
    const setupTelemetry = this.setupTelemetry ?? createSetupTelemetry(this.setupStatePath);
    this.setupTelemetry = setupTelemetry;
    app.get('/api/setup/telemetry', workViewLoopbackOnly, requireWorkViewReadOrigin, this.wrapHandler((_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ context: setupTelemetry.context() });
    }));
    app.post('/api/setup/telemetry', workViewLoopbackOnly, requireWorkViewOrigin, this.wrapHandler((req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      // Opt-out is intentionally indistinguishable from an accepted event to the UI.
      setupTelemetry.receive(req.body);
      res.status(204).end();
    }));
    // The owner-goals script already writes through this loopback worker. Its
    // story update commits shared facts before the compatibility file changes.
    app.post('/api/work-view/shared-ledger', workViewLoopbackOnly, requireWorkViewOrigin,
      validateBody(z.object({ file: z.literal('story.json'), value: z.record(z.string(), z.unknown()) }).strict()),
      this.wrapHandler(this.ownerEdit(async (req, res) => {
        if (!this.saveSharedLedgerFile) { res.status(503).json({ error: 'Shared work persistence is unavailable.' }); return; }
        this.saveSharedLedgerFile(req.body.file, req.body.value);
        res.json({ saved: true });
      })));
    app.post('/api/work-view/activity', workViewLoopbackOnly, requireWorkViewOrigin,
      validateBody(z.object({ viewerId: z.string().min(1).max(128), visible: z.boolean(), sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict()),
      this.wrapHandler((req, res) => {
        if (!this.updateViewerActivity) { res.status(204).end(); return; }
        if (!this.updateViewerActivity(req.body.viewerId, req.body.visible, req.body.sequence)) { res.status(429).json({ error: 'Too many active viewer leases.' }); return; }
        res.status(204).end();
      }));
    app.get('/api/work-view', workViewLoopbackOnly, this.wrapHandler(async (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const snapshot = await this.snapshot(0, 'http');
      const startedAt = process.hrtime.bigint();
      res.json(snapshot);
      // Measure the existing serialization/send, not a second JSON pass for diagnostics.
      const bytes = Number(res.getHeader('Content-Length'));
      this.lastResponseDiagnostic = { transport: 'http', writeMs: boundedDurationMs(Number(process.hrtime.bigint() - startedAt) / 1e6),
        bytes: Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : 0 };
    }));
    app.get('/api/work-view/overview', workViewLoopbackOnly, this.wrapHandler(async (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json(workViewOverview(await this.bootstrapSnapshot()));
    }));
    app.get('/api/work-view/requests/:id', workViewLoopbackOnly, this.wrapHandler(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const id = this.toStringParam(req.params.id);
      if (Object.keys(req.query).some(key => key !== 'fingerprint' && key !== 'revision')
        || (req.query.fingerprint !== undefined && typeof req.query.fingerprint !== 'string')
        || (req.query.revision !== undefined && typeof req.query.revision !== 'string')) {
        this.badRequest(res, 'Invalid request fingerprint or revision.'); return;
      }
      const fingerprint = req.query.fingerprint as string | undefined;
      const revision = req.query.revision as string | undefined;
      if (!id || id.length > 2048 || (fingerprint && !/^(?:[a-f0-9]{24}|[a-f0-9]{64})$/.test(fingerprint))) {
        this.badRequest(res, 'Invalid request identity or fingerprint.'); return;
      }
      const snapshot = await this.snapshot(0, 'request-detail');
      const detail = workViewRequestDetail(snapshot, id);
      if (!detail) { this.notFound(res, 'That request is no longer available.'); return; }
      if ((fingerprint && detail.request.detailRevision !== fingerprint && detail.request.contentFingerprint !== fingerprint) || (revision && detail.revision !== revision)) {
        res.status(409).json({ error: 'That request changed. Read its current version.', overview: workViewOverview(snapshot) }); return;
      }
      res.json(detail);
    }));
    app.get('/api/work-view/diagnostics', workViewLoopbackOnly, this.wrapHandler((_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ reader: this.sourceReader.getDiagnostics(), snapshot: this.lastSnapshotDiagnostic, response: this.lastResponseDiagnostic });
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
      // A stage is text an agent wrote from untrusted conversation text. It is served as plain text under a policy that
      // runs no script and loads or sends nothing, whatever the file holds or is named.
      const stage = deliverable.kind === STAGE_DELIVERABLE_KIND;
      res.setHeader('Content-Security-Policy', stage ? STAGE_CONTENT_SECURITY_POLICY : 'sandbox allow-scripts');
      res.type(stage ? 'text/plain; charset=utf-8' : DELIVERABLE_CONTENT_TYPES[extname(deliverable.path).toLowerCase()] ?? 'application/octet-stream');
      res.sendFile(deliverable.path, { dotfiles: 'allow' });
    }));
    app.post('/api/work-view/review', workViewLoopbackOnly, requireWorkViewOrigin, validateBody(reviewBody), this.wrapHandler(this.ownerEdit(this.review)));
    app.post('/api/work-view/rules', workViewLoopbackOnly, requireWorkViewOrigin, validateBody(ruleBody), this.wrapHandler(this.ownerEdit(this.saveRule)));
    app.post('/api/work-view/focus', workViewLoopbackOnly, requireWorkViewOrigin, validateBody(focusBody), this.wrapHandler(this.ownerEdit(this.saveFocus)));
    // System-written suggestions only: every row is decided_by system, status suggested, under a new id, so
    // nothing posted here can stand in for an owner decision or change an area the owner decided.
    app.post('/api/work-view/focus/owner-goals', workViewLoopbackOnly, requireWorkViewOrigin, validateBody(ownerGoalsFocusBody), this.wrapHandler(this.ownerEdit(this.suggestOwnerGoalsAreas)));
    // The focus step's answer (request-groups.mjs record-focus run by the request-progress skill): router placements
    // and suggested areas only, so nothing posted here can stand in for an owner decision.
    app.post('/api/work-view/focus/router', workViewLoopbackOnly, requireWorkViewOrigin, validateBody(routerFocusBody), this.wrapHandler(this.saveRouterFocus));
    // The one-time seed and its undo: system rows only (suggested seed areas, router placements, system withdrawals and
    // cleared router placements), so nothing posted here can stand in for or change an owner decision.
    app.post('/api/work-view/focus/seed', workViewLoopbackOnly, requireWorkViewOrigin, validateBody(seedFocusBody), this.wrapHandler(this.ownerEdit(this.saveSeedFocus)));
    app.post('/api/work-view/agents/mark-finished', workViewLoopbackOnly, requireWorkViewOrigin, validateBody(markAgentFinishedBody), this.wrapHandler(this.ownerEdit(this.markAgentFinished)));
    app.post('/api/work-view/suggestions', workViewLoopbackOnly, requireWorkViewOrigin, validateBody(suggestionBody), this.wrapHandler(this.ownerEdit(this.answerSuggestion)));
    app.post('/api/work-view/rules/load-in-claude-code', workViewLoopbackOnly, requireWorkViewOrigin, this.wrapHandler(this.ownerEdit(this.loadRulesInClaudeCode)));
    app.post('/api/work-view/refresh', workViewLoopbackOnly, requireWorkViewOrigin, validateBody(z.object({}).strict()), this.wrapHandler(this.startManualRefresh));
    // Owner runs. Each answers as soon as its one run has started; the snapshot carries how it ended.
    app.post('/api/work-view/answer', workViewLoopbackOnly, requireWorkViewOrigin, validateBody(answerBody), this.wrapHandler(this.startAnswer));
    app.post('/api/work-view/stage', workViewLoopbackOnly, requireWorkViewOrigin, validateBody(stageBody), this.wrapHandler(this.startStage));
    app.post('/api/work-view/stage/auto', workViewLoopbackOnly, requireWorkViewOrigin, validateBody(autoStageBody), this.wrapHandler(this.ownerEdit(this.saveAutoStageFormat)));
    app.post('/api/work-view/focus/plan', workViewLoopbackOnly, requireWorkViewOrigin, validateBody(focusPlanBody), this.wrapHandler(this.startFocusPlan));
    app.get('/api/work-view/focus/plan', workViewLoopbackOnly, requireWorkViewReadOrigin, this.wrapHandler((_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ plan: this.ownerRuns?.read().plan ?? null });
    }));
    app.post('/api/work-view/usage', workViewLoopbackOnly, requireWorkViewOrigin, validateBody(usageBody), this.wrapHandler(this.recordUsage));
    // Shared focus pages: this worker signs the cmem.ai calls, so the sync credential never reaches the page.
    app.get('/api/work-view/focus/shares', workViewLoopbackOnly, requireWorkViewReadOrigin, this.wrapHandler(this.listFocusShares));
    app.post('/api/work-view/focus/share', workViewLoopbackOnly, requireWorkViewOrigin, validateBody(focusShareAreaBody), this.wrapHandler(this.publishFocusShare));
    app.post('/api/work-view/focus/share/stop', workViewLoopbackOnly, requireWorkViewOrigin, validateBody(focusShareAreaBody), this.wrapHandler(this.stopFocusShare));
    app.get('/api/work-view/focus/share/comments', workViewLoopbackOnly, requireWorkViewReadOrigin, this.wrapHandler(this.focusShareComments));
    app.post('/api/work-view/focus/share/comments', workViewLoopbackOnly, requireWorkViewOrigin, validateBody(focusShareCommentBody), this.wrapHandler(this.commentOnFocusShare));
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
    app.post('/api/setup/scan/consent', workViewLoopbackOnly, requireWorkViewOrigin, validateBody(setupScanConsentBody), this.wrapHandler(async (req, res) => {
      if (!this.setupScan) { res.status(503).json({ error: 'The prompt scan is unavailable on this worker.' }); return; }
      res.setHeader('Cache-Control', 'no-store');
      try { res.json(await this.setupScan.confirmUpload(req.body.upload, req.body.agents, req.body.improveProduct)); } catch (error) {
        res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
      }
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
    app.post('/api/setup/install', workViewLoopbackOnly, requireWorkViewOrigin, validateBody(setupInstallSelectionBody), this.wrapHandler(this.configureSetupInstall));
    app.post('/api/setup/install/installer', workViewLoopbackOnly, requireWorkViewOrigin, validateBody(setupInstallReportBody), this.wrapHandler(this.reportSetupInstall));
    app.post('/api/setup/resume', workViewLoopbackOnly, requireWorkViewOrigin, validateBody(setupResumeBody), this.wrapHandler(async (req, res) => {
      const state = readSetupState(this.setupStatePath);
      if (state.status !== 'pending' || !state.install) { res.status(409).json({ error: 'There is no pending installation to resume.' }); return; }
      try { await this.resumeSetup(req.body.retry); } catch (error) {
        res.status(503).json({ error: error instanceof Error ? error.message : String(error) }); return;
      }
      res.status(202).json(this.setupStateView());
    }));
    app.post('/api/setup/installer', workViewLoopbackOnly, requireWorkViewOrigin, validateBody(setupInstallerBody), this.wrapHandler(this.saveInstallerStage));
    app.post('/api/setup/checkout', workViewLoopbackOnly, requireWorkViewOrigin, validateBody(setupCheckoutBody), this.wrapHandler(this.requestCheckout));
    app.post('/api/setup/import', workViewLoopbackOnly, requireWorkViewOrigin, validateBody(setupImportBody), this.wrapHandler(this.startHistoryImport));
    app.post('/api/setup/complete', workViewLoopbackOnly, requireWorkViewOrigin, validateBody(setupCompleteBody), this.wrapHandler(this.completeSetup));
  }

  private setupStateView(state: SetupStateFile = readSetupState(this.setupStatePath)): SetupStateView {
    const settings = SettingsDefaultsManager.loadFromFile(this.settingsPath, true, { readOnly: true }) as unknown as Record<string, unknown>;
    const historyImport = this.historyImport?.state() ?? null;
    return { ...state, install: redactSetupInstall(state.install), alreadyPro: hasProConfiguration(settings), history: this.historyCounts(), historyImport, backgroundWorkRunning: this.backgroundWorkRunning({ countScanWaitingForUploadAnswer: true }) };
  }

  /**
   * Long work this worker is doing now that a restart would kill (SetupStateView.backgroundWorkRunning): the
   * extraction run and the history import. GET /api/setup/state reports it, and the installer waits for it before
   * any restart (browser-setup.ts waitForBackgroundWorkToFinish); the auto-updater counts it as busy
   * (worker-service.ts runningBackgroundJobNames). Reads refresh.json; throws when that file cannot be read.
   *
   * countScanWaitingForUploadAnswer: whether a setup scan held at the "upload your prompts?" question
   * ('awaiting-consent') counts as the extraction run. The installer's view counts it, as it always has. The
   * auto-updater does not: the held scan runs nothing and waits in memory with no time limit (a closed tab never
   * answers), and a restart drops it anyway, so counting it would read busy until the worker restarts.
   * setupIsActive leaves that phase out for the same reason.
   */
  backgroundWorkRunning({ countScanWaitingForUploadAnswer }: { countScanWaitingForUploadAnswer: boolean }): NonNullable<SetupStateView['backgroundWorkRunning']> {
    const backgroundWorkRunning: NonNullable<SetupStateView['backgroundWorkRunning']> = [];
    const refresh = this.autoRefresh?.status() ?? null;
    // A 'running' record whose process is gone was cut off; only a live run counts.
    // The setup scan counts too: when it finishes it starts the extraction run.
    const scanPhase = this.setupScan?.state().phase ?? 'idle';
    const scanning = !['idle', 'done', 'failed'].includes(scanPhase)
      && (countScanWaitingForUploadAnswer || scanPhase !== 'awaiting-consent');
    if (scanning || (refresh?.state === 'running' && processIsAlive(Number((refresh as { pid?: number }).pid)))) backgroundWorkRunning.push('extraction');
    if (this.historyImport?.state().state === 'running') backgroundWorkRunning.push('history-import');
    return backgroundWorkRunning;
  }

  /**
   * My Work's card-wording requests running now (HumanCopyWorker): chat
   * completions of up to 90 s each (human-copy-worker.mjs sends with
   * AbortSignal.timeout(90000)), whose spend is lost when the worker stops
   * first. The auto-updater counts them as busy (worker-service.ts
   * runningBackgroundJobNames). In memory; no I/O.
   */
  cardWordingRequestsRunning(): number {
    return this.humanCopy?.status().generating ?? 0;
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

  /** Only choices from this installer's catalog can become filesystem actions. */
  private configureSetupInstall = async (req: Request, res: Response): Promise<void> => {
    const selection = req.body as z.infer<typeof setupInstallSelectionBody>;
    const state = readSetupState(this.setupStatePath);
    const install = state.install;
    if (state.status === 'complete' || !install || (install.status !== 'waiting' && install.status !== 'failed')) {
      res.status(409).json({ error: 'The installer is not waiting for installation choices.' }); return;
    }
    const unique = (values: string[]) => new Set(values).size === values.length;
    if (!unique(selection.agents) || !unique(selection.skills)
      || selection.agents.some(id => !install.catalog.agents.some(agent => agent.id === id))
      || selection.skills.some(id => !install.catalog.skills.some(skill => skill.id === id))
      || install.catalog.skills.some(skill => skill.required && !selection.skills.includes(skill.id))) {
      res.status(400).json({ error: 'Choose agents and skills offered by this installer, including required skills.' }); return;
    }
    if (install.catalog.telemetryLocked && selection.telemetryEnabled !== install.catalog.defaults.telemetryEnabled) {
      res.status(400).json({ error: 'Usage sharing is controlled by your existing preference.' }); return;
    }
    if (install.catalog.skillsLocked && (selection.skills.length !== install.catalog.defaults.skills.length
      || selection.skills.some(id => !install.catalog.defaults.skills.includes(id)))) {
      res.status(400).json({ error: 'Skill selection is controlled by your environment.' }); return;
    }
    if (install.catalog.emailEnabled === false && (selection.email || selection.note)) {
      res.status(400).json({ error: 'Email signup is unavailable for this installation.' }); return;
    }
    // Served views drop the email, so a retry that still wants the stored signup says so instead of resending it.
    const { emailProvided, ...chosen } = selection;
    const keepStoredEmail = emailProvided === true && !chosen.email && install.status === 'failed' && !!install.selection?.email;
    const stored = keepStoredEmail ? { ...chosen, email: install.selection!.email, note: chosen.note ?? install.selection!.note } : chosen;
    writeSetupState({ ...state, install: { ...install, selection: stored, status: 'installing', error: null } }, this.setupStatePath);
    try { await this.resumeSetup(true); } catch (error) {
      res.status(503).json({ error: error instanceof Error ? error.message : String(error) }); return;
    }
    this.saveSetupState(readSetupState(this.setupStatePath), res);
  };

  private reportSetupInstall = (req: Request, res: Response): void => {
    const { status, catalog, error } = req.body as z.infer<typeof setupInstallReportBody>;
    const state = readSetupState(this.setupStatePath);
    if (state.status === 'complete') { res.status(409).json({ error: 'Setup is already complete.' }); return; }
    if (status === 'waiting') {
      if (!catalog) { res.status(400).json({ error: 'Installation choices require a catalog.' }); return; }
      this.saveSetupState({ ...state, install: { status, catalog, selection: null, error: null } }, res);
      return;
    }
    if (!state.install?.selection || state.install.status !== 'installing' || status === 'installing') {
      res.status(409).json({ error: 'Choose installation options before reporting the result.' }); return;
    }
    // The signup has been applied once the install is ready; a failed run keeps it on disk for the explicit retry.
    const { email: _email, note: _note, ...withoutSignup } = state.install.selection;
    const selection = status === 'ready' ? withoutSignup : state.install.selection;
    this.saveSetupState({ ...state, install: { ...state.install, selection, status, error: error ?? null } }, res);
  };

  /** The choice can change until the installer acts on it; after that the installer holds the result. */
  private saveSetupChoice = (req: Request, res: Response): void => {
    const { branch, memoryBilling } = req.body as z.infer<typeof setupChoiceBody>;
    const state = readSetupState(this.setupStatePath);
    if (state.status === 'complete') { res.status(409).json({ error: 'Setup is already complete.', state: this.setupStateView(state) }); return; }
    if (state.install && state.install.status !== 'ready') { res.status(409).json({ error: 'Finish installing your agents before choosing memory storage.' }); return; }
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
    if (state.install && state.install.status !== 'ready') { res.status(409).json({ error: 'Finish installing your agents before completing setup.' }); return; }
    if (!state.choice) { res.status(409).json({ error: 'Choose where to keep your memory before finishing setup.', state: this.setupStateView(state) }); return; }
    const providerReady = state.choice.branch === 'home'
      ? state.installer?.stage === 'home-ready'
      : state.installer?.stage === 'go-kept-existing-pro'
        || (state.installer?.stage === 'go-awaiting-checkout' && state.checkout?.state === 'paid');
    if (!providerReady) {
      res.status(409).json({ error: 'Finish setting up your memory provider before finishing setup.', state: this.setupStateView(state) });
      return;
    }
    const captureCompletion = this.setupTelemetry?.prepareCompletion(req.body.telemetry);
    this.saveSetupState({ ...state, status: 'complete', tools: tools ?? state.tools, completedAt: new Date().toISOString() }, res);
    // Synchronous enqueue after the successful write, before the installer can
    // remove its session marker or restart this worker.
    captureCompletion?.();
  };

  private broadcast(event: string, value: unknown): void {
    if (this.closed) return;
    for (const client of this.clients) this.send(client, event, value);
  }

  /**
   * The view a rules or focus-area write checks against before it writes. Rules and focus areas come only from
   * work-state rows and the ledger, which every read checks fresh, so the activity signature may be reused inside
   * ACTIVITY_REFRESH_WINDOW_MS: with live sessions committing every few seconds, a fresh read here rebuilt the whole
   * view once before the write and again after it (#5124). The view each route answers with is still read fresh.
   * Not for checks against requests, agents or evidence (move-request, mark-finished, review): those read fresh.
   */
  private ownerStateSnapshot(): Promise<WorkViewSnapshot> {
    return this.snapshot(ACTIVITY_REFRESH_WINDOW_MS, 'owner-state');
  }

  /**
   * The event stream's tick and heartbeat, the only reads that may share a result: nothing they send promises to show
   * a write. Every other read posts its own request, so it starts after any write that came before it (the reader
   * answers strictly in order). That order also means a tick's older read can never arrive after a newer publish.
   */
  private backgroundSnapshot(): Promise<WorkViewSnapshot> {
    this.pendingBackgroundSnapshot ??= this.snapshot(ACTIVITY_REFRESH_WINDOW_MS, 'background')
      .finally(() => { this.pendingBackgroundSnapshot = null; });
    return this.pendingBackgroundSnapshot;
  }

  /** Only simultaneous read-only bootstrap callers share this work. Owner edits
   * and every committed context change fence it off; write responses always use
   * their own fresh ordered read. No completed snapshot is cached here. */
  private bootstrapSnapshot(): Promise<WorkViewSnapshot> {
    // File-writing agents and the copy worker can finish outside an HTTP edit.
    // Their cheap signatures participate without scanning the source database.
    const fence = JSON.stringify([currentContextGeneration(), this.ownerReadFence,
      this.ledgerDir ? ledgerSignature(this.ledgerDir) : null, this.humanCopy?.revision ?? 0]);
    if (this.pendingBootstrap?.fence === fence) return this.pendingBootstrap.promise;
    const promise = this.snapshot(0, 'overview');
    this.pendingBootstrap = { fence, promise };
    void promise.finally(() => {
      if (this.pendingBootstrap?.promise === promise) this.pendingBootstrap = null;
    }).catch(() => undefined);
    return promise;
  }

  private async snapshot(maxActivityAgeMs = 0, purpose: WorkViewReadPurpose = 'snapshot'): Promise<WorkViewSnapshot> {
    const read = await this.sourceReader.read(maxActivityAgeMs, this.getLocalDeviceId(), purpose);
    const startedAt = process.hrtime.bigint();
    this.source.agentRevision = read.agentRevision;
    // A coalesced bootstrap may have multiple consumers. Enrichment must never
    // mutate the reader's cached or shared raw projection.
    const snapshot = structuredClone(read.agentView);
    const sharedEnabled = this.getSharedStatus?.().enabled === true;
    for (const request of snapshot.humanRequests) {
      const legacyFingerprint = contentFingerprint(request);
      request.legacyContentFingerprint = legacyFingerprint;
      request.contentFingerprint = request.sharedReviewDescriptor?.complete ? request.sharedReviewDescriptor.fingerprint : legacyFingerprint;
      const shared = request.sharedReview;
      if (sharedEnabled) {
        request.review = shared ?? { checked: false, checkedAtEpoch: null, actor: null, available: false, mode: 'shared' };
      } else {
        let override = this.reviews.readOverride(request.id, request.contentFingerprint, shared?.hash ?? null);
        let legacy = this.reviews.read(request.id, legacyFingerprint);
        if (request.sourceProductHash && (!legacy.checked || !override)) {
          const prior = priorContentFingerprint(request);
          const priorReview = this.reviews.read(request.id, prior);
          const priorOverride = this.reviews.readOverride(request.id, prior, shared?.hash ?? null);
          const productsAt = request.sourceProductRecordedAtEpoch;
          // Products can arrive after the old check but before the first
          // upgraded read. Unknown or equal timestamps cannot prove order.
          const productsPredateChecks = [priorReview, priorOverride].every(review => !review?.checked ||
            (typeof productsAt === 'number' && Number.isFinite(productsAt) &&
              typeof review.checkedAtEpoch === 'number' && productsAt < review.checkedAtEpoch));
          if ((priorReview.checked || priorOverride) && productsPredateChecks) {
            this.reviews.adoptFingerprint(request.id, prior, legacyFingerprint);
            legacy = this.reviews.read(request.id, legacyFingerprint);
            override = this.reviews.readOverride(request.id, request.contentFingerprint, shared?.hash ?? null);
          }
        }
        const accepted = override ?? (shared?.matches || shared?.conflict ? shared : legacy);
        request.review = { ...accepted, mode: 'local', legacy: !override && accepted === legacy && legacy.checked };
      }
    }
    const reviewRevision = createHash('sha256').update(JSON.stringify(snapshot.humanRequests.map(request => [request.id, request.contentFingerprint, request.review]))).digest('hex').slice(0, 16);
    // Generated wording is display only: it never changes what was reviewed.
    const view = this.humanCopy ? this.humanCopy.observe(snapshot) as WorkViewSnapshot : snapshot;
    const result = { ...view,
      sharedState: { ...((view.sharedState && typeof view.sharedState === 'object') ? view.sharedState : {}),
        ...(this.getSharedStatus?.() ?? { enabled: false }) },
      ...(this.saveSharedLedgerFile ? { sharedPersistenceVersion: 1 } : {}),
      rulesFile: this.rulesFileStatus(snapshot), ...this.stageSettings(), setup: this.setupView(view), revision: `${snapshot.revision}:${reviewRevision}:${this.humanCopy?.revision ?? 0}` };
    this.lastSnapshotDiagnostic = { purpose, postprocessMs: boundedDurationMs(Number(process.hrtime.bigint() - startedAt) / 1e6) };
    return this.getSyncStatus ? { ...result, sync: this.getSyncStatus() } : result;
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

  private saveRule = async (req: Request, res: Response): Promise<void> => {
    const { action, ruleId, rule } = req.body as z.infer<typeof ruleBody>;
    if (!this.appendWorkStateEntry) { res.status(503).json({ error: 'Saving rules is unavailable on this worker.' }); return; }
    const snapshot = await this.ownerStateSnapshot();
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
      rows.push({ task: `Rule: ${current!.ruleId}`, rule_id: current!.ruleId, scope_tier: null, scope_name: null, when: null, then: null, set_by: null, status: null, source: null, replaced_by: null, replaced_at: null, quotes: null, quotes_total: null, times_seen: null, latest_at: null });
    }
    const project = this.homeProject ?? getProjectContext(homedir()).primary;
    for (const fields of rows) this.appendWorkStateEntry({ project, listName: MY_RULES_LIST, fields });
    const updated = await this.snapshot();
    this.writeRulesFile((updated.rules ?? []) as SavedRule[]);
    logger.debug('HTTP', 'My Rules updated', { action });
    res.setHeader('Cache-Control', 'no-store');
    // The first row is the rule this change saved, so the page can name it without guessing from the snapshot.
    res.json({ ...updated, savedRuleId: rows[0].rule_id });
    this.publish(updated);
  };

  /** The owner's focus decisions, saved as my-focus rows. Owner rows are never overridden by a refresh. */
  private saveFocus = async (req: Request, res: Response): Promise<void> => {
    const { action, focusAreaId, name, goal, intoFocusAreaId, focusAreaIds, requestId, expectedVersion } = req.body as z.infer<typeof focusBody>;
    if (!this.appendWorkStateEntry) { res.status(503).json({ error: 'Saving focus areas is unavailable on this worker.' }); return; }
    // Moving a request looks the request up, and a request can be minutes old: that check reads fresh.
    const snapshot = await (action === 'move-request' ? this.snapshot() : this.ownerStateSnapshot());
    if (!snapshot.source.connected) { res.status(503).json({ error: 'Local work is unavailable. Reconnect before changing focus areas.' }); return; }
    const areas = (snapshot.focusAreas ?? []) as FocusArea[];
    // ownerEdit serializes this fresh read, version check and every row below with other owner writes.
    if (expectedVersion !== undefined && expectedVersion !== focusChangeVersion(req.body, areas, snapshot.humanRequests)) {
      res.status(409).json({ error: FOCUS_CHANGED_MESSAGE, snapshot }); return;
    }
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
    const updated = await this.snapshot();
    logger.debug('HTTP', 'My Focus updated', { action });
    res.setHeader('Cache-Control', 'no-store');
    res.json(updated);
    this.publish(updated);
  };

  /** Owner-goals' mined focus areas, as my-focus suggestions. Answers each mined area's id, in order. */
  private suggestOwnerGoalsAreas = async (req: Request, res: Response): Promise<void> => {
    const { areas, save_key } = req.body as z.infer<typeof ownerGoalsFocusBody>;
    if (!this.appendWorkStateEntry) { res.status(503).json({ error: 'Saving focus areas is unavailable on this worker.' }); return; }
    const snapshot = await this.ownerStateSnapshot();
    if (!snapshot.source.connected) { res.status(503).json({ error: 'Local work is unavailable. Reconnect before saving focus areas.' }); return; }
    let planned: ReturnType<typeof ownerGoalsAreaRows>;
    try {
      const scope = JSON.stringify([this.homeProject ?? getProjectContext(homedir()).primary, this.getLocalDeviceId()]);
      planned = ownerGoalsAreaRows(areas, (snapshot.focusAreas ?? []) as FocusArea[], undefined, save_key ? { key: save_key, scope } : undefined);
    }
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
  recordRouterFocus = (body: RouterFocusBody): Promise<{ placed: number; focusAreaIds: string[] }> => this.inOwnerEditOrder(async () => {
    if (!this.appendWorkStateEntry) throw new Error('Saving focus areas is unavailable on this worker.');
    const snapshot = await this.ownerStateSnapshot();
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
  });

  private saveRouterFocus = async (req: Request, res: Response): Promise<void> => {
    let saved: { placed: number; focusAreaIds: string[] };
    try { saved = await this.recordRouterFocus(req.body as z.infer<typeof routerFocusBody>); }
    catch (error) {
      if (error instanceof TypeError) { this.badRequest(res, error.message); return; }
      res.status(503).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json(saved);
  };

  /** The seed's rows, checked against the saved areas and placements before the first write (a refusal writes nothing). */
  private saveSeedFocus = async (req: Request, res: Response): Promise<void> => {
    const body = req.body as z.infer<typeof seedFocusBody>;
    if (!this.appendWorkStateEntry) { res.status(503).json({ error: 'Saving focus areas is unavailable on this worker.' }); return; }
    if (!(await this.ownerStateSnapshot()).source.connected) { res.status(503).json({ error: 'Local work is unavailable. Reconnect before seeding focus areas.' }); return; }
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
  private viewerHostname(req: Request): string {
    const host = (req.hostname || '').trim().toLowerCase();
    return /^[a-z0-9.-]{1,253}$/.test(host) ? host : 'unknown';
  }

  private recordUsage = (req: Request, res: Response): void => {
    const report = req.body as z.infer<typeof usageBody>;
    const where = { viewer_host: 'local', hostname: this.viewerHostname(req) };
    if (report.event === 'opened') captureEvent('work_view_opened', { view: report.view, ...where });
    else captureEvent('work_view_switched', { view: report.view, previous_view: report.previousView, ...where });
    res.status(204).end();
  };

  /** Which areas this install shares, by id, with their links. No credentials and no page content. */
  private listFocusShares = (_req: Request, res: Response): void => {
    const shares = this.focusShares;
    if (!shares) { res.json({ connected: false, shares: {} }); return; }
    const listed = Object.fromEntries(Object.entries(shares.list()).map(([id, entry]) => [id, {
      url: entry.url, sharedAt: entry.sharedAt, publishedAt: entry.publishedAt, publishError: this.focusSharePublisher?.errorFor(id) ?? null,
    }]));
    res.json({ connected: shares.connected(), shares: listed });
  };

  private focusShareRefusal(res: Response, error: unknown): void {
    if (error instanceof FocusShareError) { res.status(error.status).json({ error: error.message }); return; }
    throw error;
  }

  /** Shares an area (first call) or publishes its page now. The worker builds the page from its own work view. */
  private publishFocusShare = async (req: Request, res: Response): Promise<void> => {
    const { focusAreaId } = req.body as z.infer<typeof focusShareAreaBody>;
    if (!this.focusSharePublisher) { res.status(503).json({ error: 'Sharing is unavailable on this worker.' }); return; }
    try {
      const { entry, sent } = await this.focusSharePublisher.publishArea(focusAreaId);
      res.json({ url: entry.url, sharedAt: entry.sharedAt, publishedAt: entry.publishedAt, sent });
    } catch (error) { this.focusShareRefusal(res, error); }
  };

  private stopFocusShare = async (req: Request, res: Response): Promise<void> => {
    const { focusAreaId } = req.body as z.infer<typeof focusShareAreaBody>;
    if (!this.focusSharePublisher) { res.status(503).json({ error: 'Sharing is unavailable on this worker.' }); return; }
    try {
      await this.focusSharePublisher.stopArea(focusAreaId);
      res.json({ stopped: true });
    } catch (error) { this.focusShareRefusal(res, error); }
  };

  private focusShareComments = async (req: Request, res: Response): Promise<void> => {
    const focusAreaId = typeof req.query.focusAreaId === 'string' ? req.query.focusAreaId : '';
    if (!focusAreaIdField.safeParse(focusAreaId).success) { res.status(400).json({ error: 'focusAreaId is required.' }); return; }
    if (!this.focusShares) { res.status(503).json({ error: 'Sharing is unavailable on this worker.' }); return; }
    try {
      res.json(await this.focusShares.comments(focusAreaId));
    } catch (error) { this.focusShareRefusal(res, error); }
  };

  private commentOnFocusShare = async (req: Request, res: Response): Promise<void> => {
    const { focusAreaId, body } = req.body as z.infer<typeof focusShareCommentBody>;
    if (!this.focusShares) { res.status(503).json({ error: 'Sharing is unavailable on this worker.' }); return; }
    try {
      res.status(201).json({ comment: await this.focusShares.comment(focusAreaId, body) });
    } catch (error) { this.focusShareRefusal(res, error); }
  };

  private markAgentFinished = async (req: Request, res: Response): Promise<void> => {
    const { agentGroupId } = req.body as z.infer<typeof markAgentFinishedBody>;
    if (!this.appendWorkStateEntry) { res.status(503).json({ error: 'Saving agent state is unavailable on this worker.' }); return; }
    const snapshot = await this.snapshot();
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
    const updated = await this.snapshot();
    res.setHeader('Cache-Control', 'no-store');
    res.json(updated);
    this.publish(updated);
  };

  /**
   * The owner's Join / Not this on a judge suggestion, written to the request ledger through the same
   * decisions the request-progress skill's `apply` takes (request-judge.mjs decideSuggestion). The
   * database is only read: projects and first asks for the decision.
   */
  private answerSuggestion = async (req: Request, res: Response): Promise<void> => {
    const { conversationKey, action, expectedSuggestionHash } = req.body as z.infer<typeof suggestionBody>;
    if (!this.ledgerDir) { res.status(503).json({ error: 'Request suggestions are unavailable on this worker.' }); return; }
    if (!existsSync(this.databasePath)) { res.status(503).json({ error: 'Local work is unavailable. Reconnect before answering a suggestion.' }); return; }
    if (this.getSharedStatus?.().enabled === true) {
      if (!this.answerSharedSuggestion || !this.prepareSharedOwnerAction) { res.status(503).json({ error: 'Shared suggestions are unavailable on this worker.' }); return; }
      if (!Object.hasOwn(req.body, 'expectedSuggestionHash')) { res.status(409).json({ error: 'Reload this suggestion before answering it.' }); return; }
      let pendingLocalMaterialization = false;
      try {
        await this.prepareSharedOwnerAction();
        const outcome = this.answerSharedSuggestion(conversationKey, action, expectedSuggestionHash ?? null);
        if (!outcome) { res.status(409).json({ error: 'This suggestion changed. Read its latest state before answering it.', snapshot: await this.snapshot() }); return; }
        pendingLocalMaterialization = (outcome as { materialization?: string }).materialization === 'pending';
      } catch (error) {
        if (!/changed since read|conflict|SQLITE_BUSY/i.test(String(error))) throw error;
        res.status(409).json({ error: 'This suggestion changed or has a concurrent decision. Read its latest state before answering it.', snapshot: await this.snapshot() }); return;
      }
      const updated = { ...await this.snapshot(), save: { scope: 'shared', state: 'queued',
        ...(pendingLocalMaterialization ? { localMaterialization: 'pending' } : {}) } };
      res.setHeader('Cache-Control', 'no-store'); res.json(updated); this.publish(updated); return;
    }
    const database = new Database(this.databasePath, { readonly: true, create: false });
    let outcome: ReturnType<typeof decideSuggestion>;
    try { outcome = decideSuggestion({ dir: this.ledgerDir, database, conversationKey, action, now: Date.now() }); }
    finally { database.close(); }
    if (!outcome) { this.notFound(res, 'That suggestion is not waiting for an answer.'); return; }
    logger.debug('HTTP', 'Request suggestion answered', { action, status: outcome.status });
    const updated = { ...await this.snapshot(), save: { scope: 'local', state: 'saved' } };
    res.setHeader('Cache-Control', 'no-store');
    res.json(updated);
    this.publish(updated);
  };

  /** The stage formats My Work lists and the owner's automatic-stage choice. Both are files, re-read at most once a second. */
  private stageSettings(): { stageFormats: StageFormatInfo[]; autoStageFormat: string | null } {
    if (this.stageSettingsRead && Date.now() - this.stageSettingsRead.at < 1000) return this.stageSettingsRead.value;
    const dataDir = dirname(this.settingsPath);
    let value: { stageFormats: StageFormatInfo[]; autoStageFormat: string | null } = { stageFormats: [], autoStageFormat: null };
    try { value = { stageFormats: readStageFormats(dataDir).formats.map(stageFormatInfo), autoStageFormat: resolveAutoStageFormat(this.settingsPath, dataDir)?.id ?? null }; }
    catch (error) { logger.warn('HTTP', 'Stage formats could not be read', { error: error instanceof Error ? error.message : String(error) }); }
    this.stageSettingsRead = { at: Date.now(), value };
    return value;
  }

  /** Resolves when every owner run this worker started has ended (shutdown and tests). */
  async whenOwnerRunsSettle(): Promise<void> {
    while (this.ownerRunsInFlight.size) await Promise.allSettled([...this.ownerRunsInFlight]);
  }

  private trackOwnerRun(run: Promise<unknown>): void {
    const tracked = run.catch(error => logger.warn('HTTP', 'An owner run ended with an error', { error: error instanceof Error ? error.message : String(error) }))
      .finally(() => { this.ownerRunsInFlight.delete(tracked); this.publish(); });
    this.ownerRunsInFlight.add(tracked);
  }

  /** What every start route checks first: the store exists, this click has not already started a run, and setup is not running. */
  private ownerRunStart(res: Response, token: string): OwnerRunStore | null {
    if (!this.ownerRuns) { res.status(503).json({ error: 'This worker keeps no record of runs, so it starts none.' }); return null; }
    if (this.ownerRuns.hasToken(token)) { this.ownerRunStarted(res, 'duplicate'); return null; }
    // Setup spends nothing it did not ask for (the refresh's own rule, AutoRefreshWorker.runNow).
    if (this.setupIsActive()) { res.status(409).json({ error: 'This is unavailable until setup finishes.' }); return null; }
    return this.ownerRuns;
  }

  private ownerRunStarted(res: Response, state: OwnerRunStartState): void {
    res.setHeader('Cache-Control', 'no-store');
    res.status(state === 'started' ? 202 : 200).json({ state });
  }

  /**
   * Sends the owner's answer to the request's latest conversation as one turn of its own tool (answer-delivery.ts),
   * and answers once that tool has been started. A refusal (`refusal: true`) names why nothing was sent, so My Work
   * falls back to copying the answer and opening the chat.
   */
  private startAnswer = async (req: Request, res: Response): Promise<void> => {
    const { requestId, text, token } = req.body as z.infer<typeof answerBody>;
    const store = this.ownerRunStart(res, token);
    if (!store) return;
    const snapshot = await this.snapshot();
    if (!snapshot.source.connected) { res.status(503).json({ error: 'Local work is unavailable. Reconnect before answering.' }); return; }
    const request = snapshot.humanRequests.find(item => item.id === requestId);
    if (!request) { this.notFound(res, 'That request is not in your work.'); return; }
    const target = await resolveAnswerTarget(request, { sessionCwd: (platform, sessionId) => this.source.sessionCwd(platform, sessionId), detectAgents: this.detectAgents });
    if ('refusal' in target) { res.status(409).json({ error: target.refusal, refusal: true }); return; }
    // Checked again after the reads above, with no await before the record is written: two posts of one click start one run.
    if (store.hasToken(token)) { this.ownerRunStarted(res, 'duplicate'); return; }
    if (store.read().answers[requestId]?.state === 'answering') { res.status(409).json({ error: 'Your last answer to this request is still being delivered.' }); return; }
    store.beginAnswer(requestId, token, target.platform);
    this.trackOwnerRun(deliverAnswer(target, text, { spawnImpl: this.spawnImpl })
      .then(error => store.finishAnswer(requestId, token, error), error => store.finishAnswer(requestId, token, String(error?.message ?? error).slice(0, 500))));
    logger.debug('HTTP', 'Answer delivery started', { platform: target.platform });
    this.ownerRunStarted(res, 'started');
    this.publish();
  };

  private stageDependencies(store: OwnerRunStore): StageDependencies {
    return {
      dataDir: dirname(this.settingsPath), ledgerDir: this.ledgerDir!, pluginRoot: this.pluginRoot, store,
      openDatabase: () => new Database(this.databasePath, { readonly: true, create: false }),
      runAgent: this.runAgent, spawnImpl: this.spawnImpl,
      sessionCwd: (platform, sessionId) => this.source.sessionCwd(platform, sessionId),
      recordDeliverable: this.recordDeliverable,
    };
  }

  /** The request as a stage reads it; null while no refresh has grouped it, since a stage reviews a grouped request. */
  private stageRequest(request: WorkViewSnapshot['humanRequests'][number]): StageRequest | null {
    if (!request.groupId) return null;
    return {
      id: request.id, groupId: request.groupId, title: typeof request.title === 'string' ? request.title : null,
      conversationKeys: request.conversationKeys ?? [], workProduct: (request.workProduct ?? []) as StageRequest['workProduct'],
    };
  }

  /** Starts one stage of one request in one format (stage-task.ts) and answers once it is recorded as generating. */
  private startStage = async (req: Request, res: Response): Promise<void> => {
    const { requestId, formatId, token } = req.body as z.infer<typeof stageBody>;
    const store = this.ownerRunStart(res, token);
    if (!store) return;
    const format = readStageFormats(dirname(this.settingsPath)).formats.find(candidate => candidate.id === formatId);
    if (!format) { this.notFound(res, 'That stage format does not exist.'); return; }
    const snapshot = await this.snapshot();
    if (!snapshot.source.connected) { res.status(503).json({ error: 'Local work is unavailable. Reconnect before staging.' }); return; }
    const found = snapshot.humanRequests.find(item => item.id === requestId);
    if (!found) { this.notFound(res, 'That request is not in your work.'); return; }
    const request = this.stageRequest(found);
    if (!request) { res.status(409).json({ error: 'This request has not been grouped by a refresh yet. Refresh, then stage it.' }); return; }
    if (store.hasToken(token)) { this.ownerRunStarted(res, 'duplicate'); return; }
    const dependencies = this.stageDependencies(store);
    const claim = claimStage(dependencies, request, format, { token, trigger: 'owner' });
    if (!claim) { res.status(409).json({ error: 'This stage is already being made.' }); return; }
    this.trackOwnerRun(generateStage(dependencies, request, format, claim));
    logger.debug('HTTP', 'Stage started', { format: format.id });
    this.ownerRunStarted(res, 'started');
    this.publish();
  };

  /** The owner's opt-in automatic stages after a refresh (stage-task.ts autoStageAfterRefresh). Off unless the setting names a format. */
  private async autoStage(refreshState: string, refreshStartedAtEpoch: number): Promise<void> {
    const store = this.ownerRuns;
    if (!store || !this.ledgerDir) return;
    await autoStageAfterRefresh({
      ledgerDir: this.ledgerDir, format: resolveAutoStageFormat(this.settingsPath, dirname(this.settingsPath)), refreshState, refreshStartedAtEpoch,
      awaitingCheck: async () => {
        const now = Date.now();
        return new Set((await this.snapshot()).humanRequests.flatMap(item => item.groupId && isAwaitingCheck(item as unknown as ApiHumanRequest, now) ? [item.groupId] : []));
      },
      generate: async (groupId: string, format: StageFormat) => {
        const found = (await this.snapshot()).humanRequests.find(item => item.groupId === groupId);
        const request = found && this.stageRequest(found);
        if (!request) return;
        const dependencies = this.stageDependencies(store);
        // The owner may have started this stage while the request was being read: their run is the stage.
        let claim: StageClaim | null = null;
        try { claim = claimStage(dependencies, request, format, { token: null, trigger: 'auto' }); }
        catch (error) { logger.warn('WORKER', 'An automatic stage could not be started', { error: error instanceof Error ? error.message : String(error) }); }
        if (!claim) return;
        await generateStage(dependencies, request, format, claim);
        this.publish();
      },
    });
  }

  /** Turns automatic stages on (a format id) or off (null). It only saves the setting; nothing is generated by saving it. */
  private saveAutoStageFormat = async (req: Request, res: Response): Promise<void> => {
    const { formatId } = req.body as z.infer<typeof autoStageBody>;
    const dataDir = dirname(this.settingsPath);
    if (formatId !== null && !readStageFormats(dataDir).formats.some(format => format.id === formatId)) { this.notFound(res, 'That stage format does not exist.'); return; }
    const result = updateSettingsDocument(this.settingsPath, { CLAUDE_MEM_WORK_VIEW_AUTO_STAGE_FORMAT: formatId ?? '' }, SettingsDefaultsManager.getAllDefaults());
    if (result.status === 'refused') { res.status(500).json({ error: 'The settings file could not be updated. Repair or restore it, then try again.' }); return; }
    noteUserSettingsSaved();
    this.stageSettingsRead = null;
    const updated = await this.snapshot();
    res.setHeader('Cache-Control', 'no-store');
    res.json(updated);
    this.publish(updated);
  };

  /** Starts one focus plan (focus-plan-task.ts) for one area or all of them, and answers once it is recorded as planning. */
  private startFocusPlan = async (req: Request, res: Response): Promise<void> => {
    const { focusAreaId, token } = req.body as z.infer<typeof focusPlanBody>;
    const store = this.ownerRunStart(res, token);
    if (!store) return;
    const snapshot = await this.snapshot();
    if (!snapshot.source.connected) { res.status(503).json({ error: 'Local work is unavailable. Reconnect before planning.' }); return; }
    const input = focusPlanInput((snapshot.focusAreas ?? []) as FocusArea[], snapshot.humanRequests as unknown as PlanSourceRequest[], focusAreaId);
    if (focusAreaId !== null && !input.areas.length) { this.notFound(res, 'That focus area is not in your focus areas.'); return; }
    if (!input.areas.length) { res.status(409).json({ error: 'You have no focus areas to plan yet.' }); return; }
    if (store.hasToken(token)) { this.ownerRunStarted(res, 'duplicate'); return; }
    if (store.read().plan?.state === 'planning') { res.status(409).json({ error: 'A plan is already being made.' }); return; }
    this.trackOwnerRun(planFocus({ dataDir: dirname(this.settingsPath), ledgerDir: this.ledgerDir!, pluginRoot: this.pluginRoot, store, runAgent: this.runAgent },
      input, { token, focusAreaId }));
    logger.debug('HTTP', 'Focus plan started', { scope: input.scope });
    this.ownerRunStarted(res, 'started');
    this.publish();
  };


  /** Starts an on-demand refresh and answers before the run ends, which can take many minutes. */
  private startManualRefresh = async (_req: Request, res: Response): Promise<void> => {
    if (!this.autoRefresh) { res.status(503).json({ error: 'Refresh is unavailable on this worker.' }); return; }
    const started = this.autoRefresh.runNow({ reason: 'manual' });
    // runNow decides before its first await: busy now means a run started, and any other answer is already settled.
    if (this.autoRefresh.busy) {
      void started.catch(error => logger.warn('HTTP', 'Manual work-view refresh failed', { error: error instanceof Error ? error.message : String(error) }));
      res.status(202).json({ state: 'running' });
      return;
    }
    const state = await started;
    if (state === 'setup-running') { res.status(409).json({ error: 'Refresh is unavailable until setup finishes.' }); return; }
    if (state === 'closed') { res.status(503).json({ error: 'This worker is shutting down.' }); return; }
    res.status(state === 'running' ? 202 : 200).json({ state });
  };

  /** Adds the MY-RULES.md import to the user-level CLAUDE.md once. Never touches a project's CLAUDE.md or AGENTS.md. */
  private loadRulesInClaudeCode = async (_req: Request, res: Response): Promise<void> => {
    const snapshot = await this.ownerStateSnapshot();
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
    const updated = await this.snapshot();
    res.setHeader('Cache-Control', 'no-store');
    res.json(updated);
    this.publish(updated);
  };

  private review = async (req: Request, res: Response): Promise<void> => {
    const { requestId, expectedFingerprint, expectedReviewHash, checked } = req.body as z.infer<typeof reviewBody>;
    const sharedEnabled = this.getSharedStatus?.().enabled === true;
    if (sharedEnabled) {
      try { await this.prepareSharedOwnerAction?.(); }
      catch (error) {
        if (!/changed since read|conflict|SQLITE_BUSY/i.test(String(error))) throw error;
        res.status(409).json({ error: 'The shared state has a conflicting change. Reload before reviewing.', snapshot: await this.snapshot() }); return;
      }
    }
    const snapshot = await this.snapshot();
    if (!snapshot.source.connected) { res.status(503).json({ error: 'Local work is unavailable. Reconnect before reviewing.' }); return; }
    const request = snapshot.humanRequests.find(item => item.id === requestId);
    if (!request) { this.notFound(res, 'Request is outside the loaded work.'); return; }
    if (request.review?.available === false) { res.status(503).json({ error: sharedEnabled ? 'Complete shared review evidence is unavailable. Reload after syncing.' : 'Local review storage is unavailable. Your source work is unchanged.' }); return; }
    if (request.contentFingerprint !== expectedFingerprint) {
      res.status(409).json({ error: 'This work changed. Read the latest result before checking it.', snapshot });
      return;
    }
    if (checked && !isReadyForCheck(request as unknown as ApiHumanRequest, Date.now())) { res.status(409).json({ error: 'This request has not been reported complete.', snapshot }); return; }
    let save: { scope: 'local' | 'shared'; state: 'saved' | 'queued' | 'unchanged' };
    if (sharedEnabled) {
      if (!this.saveSharedReview || !request.sharedReviewDescriptor?.complete) { res.status(503).json({ error: 'Shared review persistence is unavailable.' }); return; }
      if (!Object.hasOwn(req.body, 'expectedReviewHash') || expectedReviewHash !== request.sharedReview?.hash) {
        res.status(409).json({ error: 'This review changed. Reload before saving a decision.', snapshot }); return;
      }
      try {
        const result = this.saveSharedReview({ descriptor: request.sharedReviewDescriptor, checked, expectedHash: expectedReviewHash ?? null });
        save = { scope: 'shared', state: result.changed ? 'queued' : 'unchanged' };
      } catch (error) {
        if (!/changed since read|conflict|SQLITE_BUSY/i.test(String(error))) throw error;
        res.status(409).json({ error: 'This review changed or has a concurrent decision. Reload before saving.', snapshot: await this.snapshot() }); return;
      }
    } else {
      this.reviews.setOverride(requestId, expectedFingerprint, checked, request.sharedReview?.hash ?? null);
      // Keep the exact legacy sidecar behavior for older readers without ever
      // exporting their acknowledgements to shared state.
      this.reviews.set(requestId, request.legacyContentFingerprint ?? expectedFingerprint, checked);
      save = { scope: 'local', state: 'saved' };
    }
    logger.debug('HTTP', 'Work review updated', { checked, scope: save.scope });
    const updated = { ...await this.snapshot(), save };
    res.setHeader('Cache-Control', 'no-store');
    res.json(updated);
    this.publish(updated);
  };

  private events = async (req: Request, res: Response): Promise<void> => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write('retry: 1000\n\n');
    this.clients.add(res);
    const overview = req.query.view === 'overview';
    if (overview) this.overviewClients.add(res);
    const socket = res.socket;
    const cleanup = () => {
      this.clients.delete(res);
      this.overviewClients.delete(res);
      req.off('close', cleanup);
      res.off('close', cleanup);
      socket?.off('close', cleanup);
      if (!this.clients.size) this.stopTimers();
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
    socket?.on('close', cleanup);
    res.on('error', () => { cleanup(); res.destroy(); });
    let initial: WorkViewSnapshot;
    try { initial = await (overview ? this.bootstrapSnapshot() : this.snapshot(0, 'event-initial')); }
    catch (error) {
      // An open stream with no first view would look connected forever. Ending it makes the page reconnect.
      logger.warn('HTTP', 'Could not read work view for a new event stream', { error: error instanceof Error ? error.message : String(error) });
      cleanup();
      res.end();
      return;
    }
    if (!this.clients.has(res) || res.destroyed || res.writableEnded) return;
    this.send(res, overview ? 'work-view-overview' : 'work-view', overview ? workViewOverview(initial) : initial);
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
    // Activity can change on every observer write. Coalesce these rebuilds;
    // work-state, title-cache and ledger changes still appear on the next tick.
    if (!this.poll) this.poll = setInterval(() => {
      void this.backgroundSnapshot().then(snapshot => this.publish(snapshot))
        .catch(error => logger.warn('HTTP', 'Could not read work view for event stream', { error: error instanceof Error ? error.message : String(error) }));
    }, this.pollIntervalMs);
    if (!this.heartbeat) this.heartbeat = setInterval(() => {
      void this.backgroundSnapshot().then(snapshot => {
        for (const client of this.clients) this.send(client, 'heartbeat', { at: new Date().toISOString(), source: snapshot.source, ...(this.getSyncStatus ? { sync: this.getSyncStatus() } : {}) });
      }).catch(error => logger.warn('HTTP', 'Could not read work view for heartbeat', { error: error instanceof Error ? error.message : String(error) }));
    }, 15000);
    this.poll?.unref(); this.heartbeat?.unref();
  };

  private send(res: Response, event: string, value: unknown): void {
    if (res.destroyed || res.writableEnded || res.writableLength > 4 * 1024 * 1024) {
      this.clients.delete(res); this.overviewClients.delete(res); res.destroy(); return;
    }
    try {
      const startedAt = process.hrtime.bigint();
      const frame = `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
      res.write(frame);
      this.lastResponseDiagnostic = { transport: 'sse', writeMs: boundedDurationMs(Number(process.hrtime.bigint() - startedAt) / 1e6), bytes: Buffer.byteLength(frame) };
    }
    catch { this.clients.delete(res); this.overviewClients.delete(res); res.destroy(); }
  }

  private publish(snapshot?: WorkViewSnapshot): void {
    // With no event stream open there is no one to send to: skip the rebuild. A stream that opens later
    // gets a fresh snapshot first, before any publish.
    if (this.closed || !this.clients.size) return;
    if (!snapshot) { this.publishFreshRead(); return; }
    // rulesFile changes without a new revision when the rules are loaded in Claude Code; other tabs must still see it.
    const signature = JSON.stringify([snapshot.revision, snapshot.source.connected, snapshot.source.error, snapshot.setup, snapshot.rulesFile, snapshot.stageFormats, snapshot.autoStageFormat]);
    if (signature !== this.signature) {
      this.signature = signature;
      for (const client of this.clients) if (!this.overviewClients.has(client)) this.send(client, 'work-view', snapshot);
    }
    // Mapped time labels age once a minute even while the underlying activity
    // snapshot is cached; this does not renew its source data freshness.
    const overviewSignature = `${signature}:${Math.floor(Date.now() / 60_000)}`;
    if (this.overviewClients.size && overviewSignature !== this.overviewSignature) {
      this.overviewSignature = overviewSignature;
      const overview = workViewOverview(snapshot);
      for (const client of this.overviewClients) this.send(client, 'work-view-overview', overview);
    }
  }

  /**
   * Publishes from a read that starts after this call. A setup scan asks every 200 ms and a read on a large database
   * can take longer, so while one read is out, further asks collapse into one more read after it.
   */
  private publishFreshRead(): void {
    if (this.freshPublishReading) { this.freshPublishWanted = true; return; }
    this.freshPublishReading = true;
    void this.snapshot(0, 'publish').then(snapshot => this.publish(snapshot))
      .catch(error => logger.warn('HTTP', 'Could not read work view for event stream', { error: error instanceof Error ? error.message : String(error) }))
      .finally(() => {
        this.freshPublishReading = false;
        if (!this.freshPublishWanted) return;
        this.freshPublishWanted = false;
        this.publish();
      });
  }

  private stopTimers(): void {
    if (this.poll) clearInterval(this.poll);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.poll = null; this.heartbeat = null;
  }

  getClientCount(): number { return this.clients.size; }

  publishSyncStatus(sync: ViewerSyncStatus): void {
    this.broadcast('sync_status', { sync });
  }

  close(): void {
    this.closed = true;
    this.unsubscribeSetupScan?.();
    this.unsubscribeHistoryImport?.();
    this.stopRulesSync();
    this.stopTimers();
    this.focusSharePublisher?.close();
    for (const client of this.clients) client.end();
    this.clients.clear();
    this.overviewClients.clear();
    this.source.close();
    void this.sourceReader.close();
    this.reviews.close();
    this.humanCopy?.close();
    this.autoRefresh?.close();
  }
}
