/**
 * Builds the context a new session starts with: a compact index of the
 * observations and summaries that matter for this project, fitted to the
 * delivery limit. The same rows render two ways: terse for the agent, and a
 * readable preview for the person (forHuman).
 *
 * Both renders are the memory timeline: the header says how to read it, and it
 * ends on the newest timeline entry, with no closing lines after it, so later
 * updates can append timeline rows to it. How to use claude-mem's tools is not
 * in either; it is in the MCP server's instructions (shared/memory-instructions.ts).
 */

import path from 'path';
import { homedir } from 'os';
import { existsSync, unlinkSync } from 'fs';
import { Database } from 'bun:sqlite';
import { DB_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import { getProjectContext } from '../../utils/project-name.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import { SQLITE_BUSY_TIMEOUT_MS, openReaderDatabase } from '../sqlite/connection.js';
import { projectReadKeys } from '../sqlite/project-read-keys.js';

import type {
  ContextInput,
  ContextConfig,
  Observation,
  SessionSummary,
  PriorMessages,
  TimelineItem,
  TokenEconomics,
} from './types.js';
import { colors } from './types.js';
import { loadContextConfig } from './ContextConfigLoader.js';
import { fitContextToBudget, CONTEXT_OUTPUT_LIMIT, TERMINAL_BANNER_RESERVE_CHARS } from './ContextBudget.js';
import { calculateTokenEconomics } from './TokenCalculator.js';
import {
  queryObservationsMulti,
  querySummariesMulti,
  getPriorSessionMessages,
  prepareSummariesForTimeline,
  buildTimeline,
  getFullObservationIds,
} from './ObservationCompiler.js';
import { renderHeader } from './sections/HeaderRenderer.js';
import {
  renderAgentTimeline,
  buildHumanTimelineEntries,
  renderHumanTimelineEntries,
  type HumanTimelineEntry,
} from './sections/TimelineRenderer.js';
import { shouldShowSummary, renderSummaryFields } from './sections/SummaryRenderer.js';
import { renderPreviouslySection } from './sections/PreviouslyRenderer.js';
import { renderAgentEmptyState } from './formatters/AgentFormatter.js';
import { renderHumanEmptyState } from './formatters/HumanFormatter.js';
import {
  readObserverHealth,
  isObserverUnhealthy,
  isObserverQuotaCooldownActive,
  isQuotaFailure,
  isQuotaGuardPause,
  renderObserverHealthWarning,
  renderObserverQuotaCooldownNotice,
} from '../../shared/observer-health.js';
import { cooldownAppliesToCurrentAccount } from '../../shared/quota-cooldown.js';
import { readSyncHealth, renderSyncHealthWarning } from '../../shared/sync-health.js';
import { resolveRuntimeContext, type ServerRuntimeContext } from '../hooks/runtime-selector.js';
import { fetchServerContextRows, type ServerContextRows } from './ServerContextRows.js';
import { ModeManager } from '../domain/ModeManager.js';
import { getContextReadWorker } from './ContextReadWorkerClient.js';
import type { ContextReadOptions, ContextReadResult } from './ContextReadProtocol.js';
import { formatHeaderDateTime } from '../../shared/timeline-formatting.js';
import {
  CONTEXT_HEADER_TIME_PLACEHOLDER,
  HEADER_TIME_EXPANSION_RESERVE_CHARS,
} from '../../shared/context-cache.js';

const VERSION_MARKER_PATH = path.join(
  homedir(),
  '.claude',
  'plugins',
  'marketplaces',
  'thedotmack',
  'plugin',
  '.install-version'
);

function initializeDatabase(): Database | null {
  try {
    if (!existsSync(DB_PATH)) return null;
    const db = openReaderDatabase(DB_PATH);
    try {
      db.run(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  } catch (error: unknown) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ERR_DLOPEN_FAILED') {
      try {
        unlinkSync(VERSION_MARKER_PATH);
      } catch (unlinkError) {
        if (unlinkError instanceof Error) {
          logger.debug('WORKER', 'Marker file cleanup failed (may not exist)', {}, unlinkError);
        } else {
          logger.debug('WORKER', 'Marker file cleanup failed (may not exist)', { error: String(unlinkError) });
        }
      }
      logger.error('WORKER', 'Native module rebuild needed - restart Claude Code to auto-fix');
      return null;
    }
    throw error;
  }
}

/** What the agent block carries between its header and its timeline. */
interface AgentLeadSections {
  /** The observer/sync health warning, or `''` when healthy or opted out. */
  healthWarning: string;
  /** The open work-state lists, or `''` (ContextInput.workStateSection). */
  workStateSection: string;
}

/**
 * The terminal preview with the offsets its truncation cuts at, in layout
 * order: header, prior reply, timeline, then the last summary's fields.
 */
interface RenderedContext {
  text: string;
  /** Where the prior reply starts; the header ends here. */
  previousStart: number;
  /** Where the timeline starts; the prior reply ends here. */
  timelineStart: number;
  /** Where the timeline ends; the last summary's fields follow. */
  timelineEnd: number;
  entries: HumanTimelineEntry[];
}

/** The rows both renders draw from, selected once per render pass. */
interface ContextParts {
  economics: TokenEconomics;
  timeline: TimelineItem[];
  fullObservationIds: Set<Observation['id']>;
  /** The last session's summary when its fields are shown, else null. */
  lastSummary: SessionSummary | null;
  priorMessages: PriorMessages;
}

function selectContextParts(
  observations: Observation[],
  summaries: SessionSummary[],
  config: ContextConfig,
  cwd: string,
  sessionId: string | undefined,
): ContextParts {
  const displaySummaries = summaries.slice(0, config.sessionCount);
  const summariesForTimeline = prepareSummariesForTimeline(displaySummaries, summaries);
  return {
    economics: calculateTokenEconomics(observations),
    timeline: buildTimeline(observations, summariesForTimeline),
    fullObservationIds: getFullObservationIds(observations, config.fullObservationCount),
    lastSummary: shouldShowSummary(config, summaries[0], observations[0]) ? summaries[0] : null,
    priorMessages: getPriorSessionMessages(observations, config, sessionId, cwd),
  };
}

/**
 * The block the model reads. The header (how to read the timeline) is on top,
 * then the lead sections, then the timeline. It ends on the newest timeline
 * entry with no footer, so a later update can append rows to the timeline. The
 * last summary's fields are that newest entry's details: the summary row is
 * shown only when it is newer than every observation.
 */
function buildAgentContextOutput(
  project: string,
  observations: Observation[],
  summaries: SessionSummary[],
  config: ContextConfig,
  cwd: string,
  sessionId: string | undefined,
  headerTime: string,
  leads: AgentLeadSections,
): string {
  const parts = selectContextParts(observations, summaries, config, cwd, sessionId);
  const output: string[] = [...renderHeader(project, parts.economics, config, false, headerTime)];
  for (const section of [leads.healthWarning, leads.workStateSection]) {
    if (section) output.push(section, '');
  }
  output.push(...renderPreviouslySection(parts.priorMessages, false));
  output.push(...renderAgentTimeline(parts.timeline, parts.fullObservationIds, config));
  if (parts.lastSummary) output.push(...renderSummaryFields(parts.lastSummary, false));
  return output.join('\n').trimEnd();
}

/**
 * The terminal preview, in the agent block's order: header, prior reply, then
 * the timeline, ending on its newest entry. Returns the offsets its truncation
 * needs (#4252).
 */
function buildHumanContextOutput(
  project: string,
  observations: Observation[],
  summaries: SessionSummary[],
  config: ContextConfig,
  cwd: string,
  sessionId: string | undefined,
  headerTime: string,
): RenderedContext {
  const parts = selectContextParts(observations, summaries, config, cwd, sessionId);
  const output: string[] = [...renderHeader(project, parts.economics, config, true, headerTime)];

  const previousStart = output.join('\n').length + 1;
  output.push(...renderPreviouslySection(parts.priorMessages, true));

  const entries = buildHumanTimelineEntries(parts.timeline, parts.fullObservationIds, config, cwd);
  const timelineStart = output.join('\n').length + 1;
  output.push(...renderHumanTimelineEntries(entries));
  const timelineEnd = output.join('\n').length;

  if (parts.lastSummary) output.push(...renderSummaryFields(parts.lastSummary, true));

  return { text: output.join('\n').trimEnd(), previousStart, timelineStart, timelineEnd, entries };
}

/**
 * Telemetry-facing shape of one context injection. Counts, booleans, and our
 * own enum strings only — computed from the same observation set that was
 * rendered, never from user content.
 */
export interface ContextInjectStats {
  observation_count: number;
  session_count: number;
  timeline_depth_days: number;
  has_session_summary: boolean;
  obs_type_bugfix: number;
  obs_type_discovery: number;
  obs_type_decision: number;
  obs_type_refactor: number;
  obs_type_other: number;
  tokens_injected: number;
  tokens_saved_vs_naive: number;
  search_strategy: string;
}

const STAT_TYPE_BUCKETS = new Set(['bugfix', 'discovery', 'decision', 'refactor']);

function buildInjectStats(
  observations: Observation[],
  summaries: SessionSummary[],
  full: boolean
): ContextInjectStats {
  const economics = calculateTokenEconomics(observations);
  const typeCounts: Record<string, number> = {
    bugfix: 0, discovery: 0, decision: 0, refactor: 0, other: 0,
  };
  const sessionIds = new Set<string>();
  let oldestEpoch = Number.POSITIVE_INFINITY;
  for (const obs of observations) {
    const bucket = STAT_TYPE_BUCKETS.has(obs.type) ? obs.type : 'other';
    typeCounts[bucket]++;
    if (obs.memory_session_id) sessionIds.add(obs.memory_session_id);
    if (obs.created_at_epoch && obs.created_at_epoch < oldestEpoch) {
      oldestEpoch = obs.created_at_epoch;
    }
  }
  const timelineDepthDays = Number.isFinite(oldestEpoch)
    ? Math.max(0, Math.floor((Date.now() - oldestEpoch) / 86_400_000))
    : 0;

  return {
    observation_count: observations.length,
    session_count: sessionIds.size,
    timeline_depth_days: timelineDepthDays,
    has_session_summary: summaries.length > 0,
    obs_type_bugfix: typeCounts.bugfix,
    obs_type_discovery: typeCounts.discovery,
    obs_type_decision: typeCounts.decision,
    obs_type_refactor: typeCounts.refactor,
    obs_type_other: typeCounts.other,
    tokens_injected: economics.totalReadTokens,
    tokens_saved_vs_naive: economics.savings,
    search_strategy: full ? 'full' : 'timeline',
  };
}

/**
 * Paint every non-blank line, rather than wrapping the block once: session
 * context is long enough to scroll, and a single leading escape leaves the
 * warning uncolored wherever the terminal reflows or the reader scrolls back.
 */
function paintRed(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.trim() ? `${colors.red}${line}${colors.reset}` : line))
    .join('\n');
}

/**
 * Append the observer-health outage warning when the observer is failing,
 * or the quota-cooldown pause notice when the breaker is withholding the
 * generator without a failure streak. Applied to EVERY context path
 * (including empty-state, missing-DB, and the no-memories-yet welcome hint
 * in SearchRoutes) so a multi-hour intentional pause is not silent.
 *
 * This helper puts it BELOW a block that has no timeline (the welcome hint),
 * where the last thing rendered is the thing still on screen. A timeline
 * block never has anything after its newest entry, so later rows can be
 * appended to it: the agent block carries the warning under its header
 * (buildAgentContextOutput) and the terminal preview above it
 * (prependObserverHealthWarning).
 */
export function withObserverHealthWarning(text: string, forHuman: boolean = false): string {
  return appendObserverHealthWarning(observerHealthWarning(forHuman), text);
}

/**
 * The warning on its own, or `''` when the observer is healthy.
 *
 * Split out so the fitted path can read the health ONCE and then measure the
 * warning as part of the block it is fitting. `fitContextToBudget` calls its
 * render repeatedly, and `readObserverHealth` touches state: re-reading it per
 * reduction would let the measured length change under the loop.
 */
export function observerHealthWarning(forHuman: boolean = false): string {
  const health = readObserverHealth();
  // The structured quota notice knows whether the main provider or its backup
  // is saving, so it supersedes the failure that armed that hold, including
  // when the notice is silent. Unrelated failures still get their own banner.
  // A Claude hold only applies to the account it was armed under.
  //
  // The notice was mirrored under whichever account was selected then, so a
  // Claude hold is dropped here unless it pauses the account selected now. A
  // hold mirrored before holds carried their own account uses the ledger's.
  const mirrored = health?.quotaCooldown;
  const cooldown = mirrored?.notice
    ? { ...mirrored, notice: { ...mirrored.notice, holds: mirrored.notice.holds.filter(hold =>
      cooldownAppliesToCurrentAccount({ provider: hold.provider, profile: hold.profile ?? mirrored.profile })) } }
    : mirrored;
  let notice: string | null = null;
  if (health && isObserverQuotaCooldownActive(health) && cooldown
    && (cooldown.notice ? cooldown.notice.holds.length > 0 : cooldownAppliesToCurrentAccount(cooldown))
    && (!isObserverUnhealthy(health) || (cooldown.notice && (isQuotaFailure(health) || isQuotaGuardPause(health))))) {
    notice = renderObserverQuotaCooldownNotice({ ...health, quotaCooldown: cooldown });
  } else if (isObserverUnhealthy(health)) {
    notice = renderObserverHealthWarning(health);
  }
  // Cloud sync health rides the same slot: a paused (401/403) or long-failing
  // sync is the other outage users otherwise discover only by missing memories.
  const syncNotice = renderSyncHealthWarning(readSyncHealth());
  if (syncNotice) {
    notice = notice ? `${notice}\n\n${syncNotice}` : syncNotice;
  }
  if (!notice) {
    return '';
  }
  // Colors only on the human render: the agent copy is fetched separately
  // (colors=false) and ANSI escapes there are noise in the model's context.
  return forHuman && notice.includes('⚠') ? paintRed(notice) : notice;
}

/**
 * The health warning for one build, or `''` when the caller opted out.
 *
 * The outage banner ends with an instruction meant for the primary assistant
 * ("tell the user about this outage at the very start of your first reply").
 * The observer's own session-start briefing is read by a model that has no user
 * to tell, so the banner is obeyed there instead of reported: the observer
 * answers in prose, the parser logs "non-XML prose response" and confirms the
 * claimed batch anyway, and the batch is dropped. Nothing parses, so
 * `lastSuccessAt` never advances, so the banner stays up - the failure sustains
 * itself long after the original cause cleared (#4221).
 *
 * Opting out is explicit rather than inferred from `source`, so a build's
 * audience is stated at the call site instead of being guessed.
 */
export function healthWarningForContext(
  input: ContextInput | undefined,
  forHuman: boolean = false
): string {
  if (input?.includeHealthWarning === false) return '';
  return observerHealthWarning(forHuman);
}

function appendObserverHealthWarning(warning: string, text: string): string {
  if (!warning) return text;
  return text ? `${text}\n\n${warning}` : warning;
}

/** The warning above a terminal timeline, which must end on its newest entry. */
function prependObserverHealthWarning(warning: string, text: string): string {
  if (!warning) return text;
  return text ? `${warning}\n\n${text.replace(/^\n+/, '')}` : warning;
}

/**
 * Truncate presentation only; selection always belongs to the model budget.
 *
 * The preview ends on its newest timeline entry, so that end is what is kept:
 * complete newest-first entries first, then the last summary's fields, then as
 * much of the prior reply (above the timeline) as still fits. The notice sits
 * where the cut is, just above the oldest entry still shown.
 */
function truncateTerminalPreview(rendered: RenderedContext | string, limit: number): string {
  const truncationNotice = (omitted: boolean) =>
    `${colors.reset}\n\n[Terminal preview truncated. The model received the full selected context; ${omitted
      ? 'additional observations are not shown here.'
      : 'some presentation text is not shown here.'}]\n`;
  if (typeof rendered === 'string') {
    if (rendered.length <= limit) return rendered;
    // No row boundaries to cut at: keep the newest end, which ends the preview.
    const notice = truncationNotice(false);
    return notice + rendered.slice(rendered.length - Math.max(0, limit - notice.length));
  }
  const { text, previousStart, timelineStart, timelineEnd, entries } = rendered;
  if (text.length <= limit) return text;

  const head = text.slice(0, previousStart);
  const previous = text.slice(previousStart, timelineStart);
  const summary = text.slice(timelineEnd);

  let omitted = 0;
  let timeline = renderHumanTimelineEntries(entries).join('\n');
  const noticeWithAllEntries = truncationNotice(false);
  const notice = head.length + noticeWithAllEntries.length + timeline.length <= limit
    ? noticeWithAllEntries : truncationNotice(true);
  while (omitted < entries.length && head.length + notice.length + timeline.length > limit) {
    omitted++;
    timeline = renderHumanTimelineEntries(entries.slice(omitted)).join('\n');
  }
  const room = limit - head.length - notice.length - timeline.length;
  const keptSummary = summary.length <= room ? summary : '';
  const previousRoom = room - keptSummary.length;
  let keptPrevious = '';
  if (previous.length <= previousRoom) {
    keptPrevious = previous;
  } else if (previousRoom > 24) {
    keptPrevious = previous.slice(0, previousRoom - 1 - colors.reset.length)
      + '…' + colors.reset;
  }
  return (head + keptPrevious + notice + timeline + keptSummary).trimEnd();
}

/**
 * Fit the block to `limit` and report on exactly what survived.
 *
 * Split out of `generateContextWithStats` so both halves can be tested without
 * a database: the caller's only remaining job is to fetch rows. Two things have
 * to happen together here, and neither is safe on its own.
 *
 * The health warning is rendered INSIDE the measured block: `renderBlock` is
 * handed it and places it (under the header, so the block still ends on its
 * timeline). Adding it to the fitted result spends characters the fitter never
 * counted, so an unhealthy observer could push a block just fitted to 9,998
 * back over the limit — and over the limit the whole block is replaced by the
 * preview stub #3802 exists to avoid, which is exactly when an outage warning
 * most needs to arrive.
 *
 * The stats describe what was DELIVERED, not what was queried.
 * `ContextInjectStats` already promises this ("computed from the same
 * observation set that was rendered"); before this, a run trimmed from seven
 * observations to three still reported seven, so telemetry read as healthy
 * precisely when context was being dropped. `sessionCount` is the same slice
 * `buildContextOutput` takes for `displaySummaries`.
 *
 * `renderBlock` is always the model rendering. An optional terminal preview
 * uses that fitted selection and config exactly, then truncates presentation
 * without running another selection pass (#4252).
 */
export function fitContextForDelivery(
  observations: Observation[],
  summaries: SessionSummary[],
  config: ContextConfig,
  healthWarning: string,
  renderBlock: (items: Observation[], cfg: ContextConfig, healthWarning: string) => string,
  limit: number,
  full: boolean,
  renderPreview?: (items: Observation[], cfg: ContextConfig) => RenderedContext | string
): { text: string; stats: ContextInjectStats } {
  const budget = fitContextToBudget(
    observations,
    config,
    (items, cfg) => renderBlock(items, cfg, healthWarning),
    limit
  );

  if (budget.reductions > 0) {
    logger.debug('HOOK', 'Trimmed context to fit the hook output limit', {
      reductions: budget.reductions,
      observations: budget.observationCount,
      sessions: budget.config.sessionCount,
      chars: budget.text.length,
      overBudget: budget.overBudget,
    });
  }

  const selected = observations.slice(0, budget.observationCount);
  let text = budget.text;
  if (renderPreview) {
    const warning = paintRed(healthWarning);
    const warningLength = warning ? warning.length + 2 : 0;
    text = prependObserverHealthWarning(warning, truncateTerminalPreview(
      renderPreview(selected, budget.config),
      limit - warningLength - TERMINAL_BANNER_RESERVE_CHARS
    ));
  }

  return {
    text,
    stats: buildInjectStats(
      selected,
      summaries.slice(0, budget.config.sessionCount),
      full
    ),
  };
}

interface ContextScope {
  config: ContextConfig;
  cwd: string;
  /** Every project key for this cwd (worktree parent, legacy aliases). */
  projects: string[];
  /** The key the rendered block is titled with. */
  project: string;
  platformSource: string | undefined;
}

function resolveContextScope(input: ContextInput | undefined, configSnapshot?: ContextConfig): ContextScope {
  const config = configSnapshot ? { ...configSnapshot } : loadContextConfig();
  if (input?.includePriorMessage === false) config.showLastMessage = false;
  const cwd = input?.cwd ?? process.cwd();
  // Callers that name the projects (the worker route, the server-runtime hook)
  // need no lookup, and resolving a real cwd runs git on every render.
  const projects = input?.projects?.length ? input.projects : getProjectContext(cwd).allProjects;
  const project = projects[projects.length - 1];

  if (input?.full) {
    config.totalObservationCount = 999999;
    config.sessionCount = 999999;
  }

  const platformSource = input?.platformSource
    ? normalizePlatformSource(input.platformSource)
    : undefined;
  return { config, cwd, projects, project, platformSource };
}

/**
 * Render rows that were already fetched. DB-free: the SQLite path and the server
 * runtime both end here, so both get the same renderer, budget fitter, health
 * warning and stats. Empty rows render the empty state.
 */
export function renderContextFromRows(
  rows: { observations: Observation[]; summaries: SessionSummary[] },
  input: ContextInput | undefined,
  forHuman: boolean,
  scope: Pick<ContextScope, 'config' | 'cwd' | 'project'>,
): { text: string; stats: ContextInjectStats | null } {
  const { observations, summaries } = rows;
  const { config, cwd, project } = scope;
  // One header time for every render pass of this build. A cacheable build
  // carries a placeholder instead, and the fitter keeps room for it to grow.
  const headerTime = input?.timePlaceholders ? CONTEXT_HEADER_TIME_PLACEHOLDER : formatHeaderDateTime();
  const headerTimeReserveChars = input?.timePlaceholders ? HEADER_TIME_EXPANSION_RESERVE_CHARS : 0;
  const workStateSection = input?.workStateSection ?? '';

  if (observations.length === 0 && summaries.length === 0) {
    return {
      text: forHuman
        ? prependObserverHealthWarning(healthWarningForContext(input, true), renderHumanEmptyState(project, headerTime))
        : renderAgentEmptyState(project, headerTime, [healthWarningForContext(input), workStateSection]),
      stats: null,
    };
  }

  // `--full` is an explicit human request for everything; only the block that
  // has to survive a hook's 10,000-character delivery limit is fitted (#3802).
  return fitContextForDelivery(
    observations,
    summaries,
    config,
    // The model's form: selection is fitted on the model render, and the
    // terminal preview paints this same warning red after truncating (#4252).
    healthWarningForContext(input),
    (items, cfg, healthWarning) =>
      buildAgentContextOutput(project, items, summaries, cfg, cwd, input?.session_id, headerTime, { healthWarning, workStateSection }),
    input?.full
      ? Number.POSITIVE_INFINITY
      : CONTEXT_OUTPUT_LIMIT - (input?.reserveChars ?? 0) - headerTimeReserveChars,
    Boolean(input?.full),
    forHuman ? (items, cfg) =>
      buildHumanContextOutput(project, items, summaries, cfg, cwd, input?.session_id, headerTime) : undefined
  );
}

interface ServerContextRead {
  scope: ContextScope;
  /** Null when the server could not answer. */
  rows: ServerContextRows | null;
}

/** One /v1/context read, scoped to this cwd's project keys through the route's folder filter. */
async function readServerContext(
  runtime: ServerRuntimeContext,
  input: ContextInput | undefined,
  timeoutMs?: number,
): Promise<ServerContextRead> {
  const scope = resolveContextScope(input);
  // Server ids are UUIDs that no tool can fetch by id (get_observations reads
  // the local SQLite store), so the block prints 8-char display refs and points
  // at observation_search instead (plan-24 step 3).
  scope.config.fetchByIdSupported = false;
  const rows = await fetchServerContextRows(runtime, {
    config: scope.config,
    project: scope.project,
    folderProjects: scope.projects,
    platformSource: scope.platformSource,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return { scope, rows };
}

function renderServerContext(
  read: ServerContextRead,
  input: ContextInput | undefined,
  forHuman: boolean,
): { text: string; stats: ContextInjectStats | null } {
  if (!read.rows) {
    return { text: healthWarningForContext(input, forHuman), stats: null };
  }
  return renderContextFromRows(read.rows, input, forHuman, read.scope);
}

/**
 * Session-start context for the server runtime, read from the shared store.
 *
 * Never opens the local SQLite file: in server runtime the writes go to the
 * server, so the local corpus is stale. A successful empty answer renders the
 * empty state. When the server cannot answer, the result is empty (plus any
 * health warning) and a `[server-fallback]` line is logged; stale local rows are
 * never substituted. Rows are scoped to this cwd's project keys through the
 * route's folder filter.
 */
export async function generateServerContextWithStats(
  runtime: ServerRuntimeContext,
  input?: ContextInput,
  forHuman: boolean = false
): Promise<{ text: string; stats: ContextInjectStats | null }> {
  return renderServerContext(await readServerContext(runtime, input), input, forHuman);
}

/**
 * The SessionStart hook's server-runtime block, called straight from the hook
 * process with no worker. ONE /v1/context read per session start: the model
 * block and, when asked, the colored terminal copy both render from its rows
 * (#3227 read the store once per rendering). `timeoutMs` is what the host's
 * SessionStart limit leaves for the read (serverSessionStartBudgetMs).
 */
export async function generateServerSessionStartContext(
  runtime: ServerRuntimeContext,
  input: ContextInput,
  options: { withTerminalRender: boolean; timeoutMs: number },
): Promise<{ model: string; terminal: string | null }> {
  const read = await readServerContext(runtime, input, options.timeoutMs);
  return {
    model: renderServerContext(read, input, false).text,
    terminal: options.withTerminalRender ? renderServerContext(read, input, true).text : null,
  };
}

export async function generateContextWithStats(
  input?: ContextInput,
  forHuman: boolean = false,
  options: ContextReadOptions = {},
): Promise<ContextReadResult> {
  const runtime = resolveRuntimeContext();
  if (runtime.runtime === 'server') {
    return generateServerContextWithStats(runtime, input, forHuman);
  }

  if (options.execution === 'worker') {
    return (options.reader ?? getContextReadWorker()).render({
      context: input,
      forHuman,
      mode: ModeManager.getInstance().getActiveMode(),
      config: options.config ?? loadContextConfig(),
    });
  }

  const scope = resolveContextScope(input, options.config);
  const rawDb = initializeDatabase();
  if (!rawDb) {
    const workStateSection = forHuman ? '' : input?.workStateSection ?? '';
    return { text: [healthWarningForContext(input, forHuman), workStateSection].filter(Boolean).join('\n\n'), stats: null };
  }

  try {
    const db = { db: rawDb };
    // Every key these projects are stored under, including one hop of a merge
    // chain, so a `project merge` brings the merged project's adopted rows along.
    const queryProjects = projectReadKeys(rawDb, scope.projects.length > 1 ? scope.projects : [scope.project]);
    const observations = queryObservationsMulti(db, queryProjects, scope.config, scope.platformSource);
    const summaries = querySummariesMulti(db, queryProjects, scope.config, scope.platformSource);
    return { ...renderContextFromRows({ observations, summaries }, input, forHuman, scope), readKeys: queryProjects };
  } finally {
    rawDb.close();
  }
}

export async function generateContext(
  input?: ContextInput,
  forHuman: boolean = false,
  options: ContextReadOptions = {},
): Promise<string> {
  return (await generateContextWithStats(input, forHuman, options)).text;
}
