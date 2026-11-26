// IO discipline (see src/shared/hook-io.ts):
// - hookSpecificOutput.additionalContext → MODEL_CONTEXT (model consumes; via stdout JSON)
// - systemMessage                        → USER_HINT (user-visible; via stdout JSON systemMessage)
// This handler is PURE: it returns a HookResult and MUST NOT call
// process.stderr.write / process.stdout.write / console.* / process.exit.
// logger.* calls are DIAGNOSTIC and route through hook-io's stderr path.
import { cmemCapExhaustedAt } from '../../shared/cmem-cap-probe.js';
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import {
  executeWithWorkerFallback,
  isWorkerFallback,
  isWorkerUnavailableError,
  type WorkerCallResult,
  getWorkerPort,
  getViewerBaseUrl,
  consumeWorkerOutageNotice,
  recordWorkerUnreachable,
} from '../../shared/worker-utils.js';
import { getProjectContext } from '../../utils/project-name.js';
import { HOOK_EXIT_CODES, HOOK_TIMEOUTS } from '../../shared/hook-constants.js';
import { logger } from '../../utils/logger.js';
import { loadFromFileOnce } from '../../shared/hook-settings.js';
import { shouldTrackProject } from '../../shared/should-track-project.js';
import { isProjectExcluded } from '../../utils/project-filter.js';
import { readStaleMarker } from '../../shared/oauth-token.js';
import { clipUtf16 } from '../../shared/relayed-text.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import { withoutLoadedRulesPointer } from '../../shared/claude-code-rules-import.js';
import { dispatchClaudeMemMessage, formatClaudeMemMessage, nextClaudeMemMessage } from '../../shared/claude-mem-messages.js';
import { proTrialLine } from '../../shared/pro-promo.js';
import { providersMappedBySource } from '../../shared/provider-by-source.js';
import {
  cmemGatewayRole,
  hasShownProFallbackNotice,
  markProFallbackNoticeShown,
  proFallbackNotice,
  trialDaysRemaining,
} from '../../shared/cmem-gateway.js';
import { resolveRuntimeContext, type ServerRuntimeContext } from '../../services/hooks/runtime-selector.js';
import type { ContextInput } from '../../services/context/types.js';
import { serverSessionStartBudgetMs } from '../../shared/host-hook-limits.js';
import {
  contextCacheKeys,
  fillContextPlaceholders,
  readContextCache,
  readContextProjectCatalog,
  saveContextProjectCatalog,
} from '../../shared/context-cache.js';
import { clearTimelinePending } from '../../shared/codex-compaction-gate.js';
import { readSetupState, type SetupStateFile } from '../../shared/setup-state.js';
import { hasPendingInstallSetup } from '../../shared/setup-install.js';
import { projectsQueryString, type ProjectExclusionCatalog } from '../../shared/project-list.js';
import { CONTEXT_OUTPUT_LIMIT } from '../../services/context/ContextBudget.js';
import { consumeTelemetryNotice } from '../../services/telemetry/consent.js';
import { awaitSessionStartCardSlotForRequest, writeSessionStartCardSlot } from '../session-start-card-slot-writer.js';
import {
  fetchTeamBrief,
  formatTeamBrief,
  hasShownTeamBrainDiscoveryNotice,
  markTeamBrainDiscoveryNoticeShown,
  teamBrainConnection,
  teamBriefReserveChars,
  TEAMBRAIN_DISCOVERY_LINE,
  type TeamBrainBrief,
  type TeamBrainResult,
} from '../../shared/teambrain.js';

/**
 * How long SessionStart waits for the TeamBrain brief. It is asked at the
 * start, so the wait runs alongside the local context read.
 */
export const TEAM_BRIEF_TIMEOUT_MS = 2_000;

/** Only an explicitly deferred install asks a first session to return to onboarding. */
export function pendingSetupNotice(state: Pick<SetupStateFile, 'status' | 'install'>, viewerBaseUrl: string): string | null {
  if (!hasPendingInstallSetup(state)) return null;
  const url = new URL(viewerBaseUrl);
  url.searchParams.set('setup', '1');
  return `[claude-mem] Setup is waiting for your choices: ${url.href}\n`
    + 'If a person is available, open that page so they can finish onboarding. '
    + 'Otherwise leave setup pending and show them this link when they return. '
    + 'Do not choose agents, integrations, skills, or account options on their behalf.';
}

/** Below this much room a cut brief says too little to be worth sending. */
const MIN_CUT_TEAM_BRIEF_CHARS = 300;

/** The brief for this session, or the one line naming why there is none. */
export function teamBriefSection(result: TeamBrainResult<TeamBrainBrief>): string {
  return result.ok
    ? formatTeamBrief(result.value)
    : `[claude-mem] TeamBrain brief unavailable: ${result.reason}`;
}

/**
 * The lines at the top of the SessionStart terminal banner: the trial line,
 * the trial countdown and the TeamBrain discovery line. Empty when none apply.
 */
export function sessionStartBannerHeader(
  trialDaysLine: string | null,
  teamBrainDiscoveryLine: string | null,
  plan = '',
): string {
  return [proTrialLine('session-start', plan), trialDaysLine, teamBrainDiscoveryLine]
    .filter(Boolean).join('\n');
}

const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;
/**
 * A timeline row, opening with its id (digits, or a server's hex display ref):
 * the colored preview's `  #<id>  <time> …` or summary `#S<id> …`, or the
 * plain block's `<id> <time> …`, `S<id> …` or `**<id>** …` (antigravity-cli
 * shows the model's block). A `### <day>` heading has no id, so it is not one.
 */
const TERMINAL_TIMELINE_ROW = /^(?:\s*#|\*\*)?S?[0-9a-f][0-9a-f-]*(?:\*\*)? /;

/** How many timeline rows a terminal preview shows. */
export function countTerminalTimelineRows(preview: string): number {
  return preview.split('\n').filter(line => TERMINAL_TIMELINE_ROW.test(line.replace(ANSI_ESCAPE, ''))).length;
}

/**
 * The line that closes the terminal banner, under a blank line after the
 * newest timeline row: the live viewer link and how many rows are shown.
 */
export function sessionStartBannerFooter(viewerUrl: string, timelineRowCount: number): string {
  const count = timelineRowCount > 0 ? ` · ${timelineRowCount} line${timelineRowCount === 1 ? '' : 's'}` : '';
  return `View Observations Live @ ${viewerUrl}${count}`;
}

/**
 * The user-visible SessionStart `systemMessage`: any worker-outage or first-use
 * telemetry notice and the header lines, the terminal preview, then a
 * blank line and the closing viewer line with the count of rows shown. Claude
 * Code replaces a field over CONTEXT_OUTPUT_LIMIT with a saved-to-disk stub
 * (#5079), and neither the notice nor a server-runtime viewer URL is bounded by
 * TERMINAL_BANNER_RESERVE_CHARS, so the message is measured whole: when it is
 * over, whole lines are dropped from the preview's oldest end until it fits, so
 * the preview still ends on its newest entry. The notice, the header lines and
 * the closing line are never cut. With no preview (banner off) the notice is
 * the whole message.
 */
export function composeSessionStartSystemMessage(
  preview: string | null,
  bannerHeader: string,
  viewerUrl: string,
  userNotice: string | null,
  limit: number = CONTEXT_OUTPUT_LIMIT,
): string | undefined {
  if (preview === null) return userNotice ?? undefined;
  const top = [userNotice, bannerHeader].filter(Boolean).map(part => `${part}\n\n`).join('');
  let fittedPreview = preview.replace(/^\n+/, '').trimEnd();
  // Measured with every row counted; cutting rows only shortens the count.
  const longestBottom = `\n\n${sessionStartBannerFooter(viewerUrl, countTerminalTimelineRows(fittedPreview))}`;
  const previewRoom = limit - top.length - longestBottom.length;
  if (fittedPreview.length > previewRoom) {
    // The kept text starts after the first line break at or after the char just
    // before the room, so a room that begins exactly on a line keeps that line.
    const lineBreakBeforeKept = previewRoom > 0 ? fittedPreview.indexOf('\n', fittedPreview.length - previewRoom - 1) : -1;
    const keptPreview = lineBreakBeforeKept >= 0 ? fittedPreview.slice(lineBreakBeforeKept + 1) : '';
    logger.debug('HOOK', 'SessionStart terminal preview cut at a line boundary, oldest lines first, to keep systemMessage within the field cap', {
      previewChars: fittedPreview.length,
      keptPreviewChars: keptPreview.length,
      topChars: top.length,
      limit,
    });
    fittedPreview = keptPreview;
  }
  const footer = sessionStartBannerFooter(viewerUrl, countTerminalTimelineRows(fittedPreview));
  const systemMessage = `${top}${fittedPreview ? `${fittedPreview}\n\n` : ''}${footer}`;
  if (systemMessage.length > limit) {
    logger.warn('HOOK', 'SessionStart systemMessage is over the field cap even with no preview', {
      systemMessageChars: systemMessage.length,
      limit,
    });
  }
  return systemMessage;
}

/**
 * What the session-start card draws (src/shared/session-start-card-slot.ts):
 * the banner's header lines and the terminal preview. The closing line is not
 * in it, and neither is a line shown only once: the hook message carries those.
 */
export function sessionStartCardText(preview: string, bannerHeader: string): string {
  return [bannerHeader, preview.replace(/^\n+/, '').trimEnd()].filter(Boolean).join('\n\n');
}

/**
 * The SessionStart `systemMessage` when the session-start card draws the
 * banner: any notice and the TeamBrain discovery line, then the closing line
 * with the count of rows the card shows. Those first lines are shown only
 * once, and the card can still fail to draw, so they are not left to it.
 * With neither it is one line. That is what the card is for: the stream
 * Claude Code sends to the Claude app repeats the hook's name on every line
 * of a hook message, and the terminal shows it once.
 */
export function composeSessionStartCardSystemMessage(
  preview: string,
  viewerUrl: string,
  userNotice: string | null,
  teamBrainDiscoveryLine: string | null,
): string {
  const footer = sessionStartBannerFooter(viewerUrl, countTerminalTimelineRows(preview));
  return [userNotice, teamBrainDiscoveryLine, footer].filter(Boolean).join('\n\n');
}

/**
 * Keep the whole block inside the host's delivery limit (ContextBudget.ts):
 * one character over and the host replaces all of it with a stub. The body is
 * fitted with room left for the brief (teamBriefReserveChars), so this only
 * cuts when it was not, e.g. a block rendered before the install joined. Then
 * the brief is cut to the room `otherChars` leaves, or, with too little room
 * to be useful, replaced by one line saying it was left out. A block with no
 * room even for that line is logged, since nothing more can be added to it.
 * `otherChars` is everything else in the block, wherever the brief sits in it.
 */
export function fitTeamBriefSection(section: string, otherChars: number, limit: number = CONTEXT_OUTPUT_LIMIT): string {
  if (!section) return '';
  const room = limit - otherChars - 2; // the blank line that joins it to the rest
  if (section.length <= room) return section;
  if (room >= MIN_CUT_TEAM_BRIEF_CHARS) {
    const cut = section.slice(0, room - 1).replace(/[\uD800-\uDBFF]$/, '').trimEnd();
    return `${cut}…`;
  }
  const notices = [
    `[claude-mem] TeamBrain brief left out: this session's context is already at the ${limit.toLocaleString('en-US')}-character limit.`,
    '[claude-mem] TeamBrain brief left out: context full.',
  ];
  const notice = notices.find(candidate => candidate.length <= room);
  if (notice) return notice;
  logger.warn('HOOK', 'TeamBrain brief left out: the SessionStart block has no room left even for a notice', { room, limit });
  return '';
}

/**
 * Room left for the SessionStart body once the notices are counted: the field
 * limit minus the notices and the blank line joining them to the body. The
 * one definition both the cached read and the compose step use, so a body
 * that fits here is never dropped there (#5672: a cached body rendered for
 * the full budget must not be served when the current notices leave less
 * room than it needs).
 */
export function sessionStartBodyRoom(notices: string, limit: number = CONTEXT_OUTPUT_LIMIT): number {
  return Math.max(0, limit - notices.length - (notices ? 2 : 0));
}

/**
 * The model-bound SessionStart field: the notices, the TeamBrain brief, then
 * the memory body last. The body is the timeline and ends on its newest entry,
 * so nothing is added after it: a later update can append timeline rows.
 *
 * Cached bodies can predate the current reserve, and the OAuth and gateway
 * notices are added only in this process. Measure the final model field here
 * as well. Never truncate opaque rendered entries: an old worker or
 * irreducible body falls back to an explicit omission notice. TeamBrain
 * retains its existing fit/omission policy.
 */
export function composeSessionStartContext(
  body: string,
  notices: string,
  teamSection: string,
  limit: number = CONTEXT_OUTPUT_LIMIT,
): string {
  const join = (...parts: string[]) => parts.filter(Boolean).join('\n\n');
  const room = sessionStartBodyRoom(notices, limit);
  if (body.length > room) {
    // Older workers may ignore reserveChars; irreducible renderer output may
    // also exceed its limit. Never cut a rendered entry, code fence, or newest
    // record. Keep the actionable notices and explicitly report the omission.
    const omitted = '[claude-mem] Recent context omitted because it exceeds the session output limit. Use memory search to retrieve it.';
    body = omitted.length <= room ? omitted : '';
    logger.warn('HOOK', 'SessionStart body omitted because it exceeds the available field budget', { room });
  }
  const fittedTeam = fitTeamBriefSection(teamSection, join(notices, body).length, limit);
  return join(notices, fittedTeam, body);
}

// Plan-24 step 4 (#2991): in server runtime every write goes to the shared
// server, so SessionStart reads from it too, straight from this hook process.
// The rows go through the same renderer and 10,000-character budget as the
// worker's /api/context/inject (#4112). No local worker is started or asked,
// and a server that cannot answer yields an empty block (logged as
// [server-fallback]), never stale local rows. One read serves both the model
// block and the colored terminal copy, and it is bounded by what the host's
// SessionStart limit leaves (Codex kills the hook at 20 s, the client's own
// default is 30 s).
async function renderSessionStartFromServer(
  runtime: ServerRuntimeContext,
  contextInput: ContextInput,
  withColoredTerminalRender: boolean,
  modeId: string,
  host: string | undefined,
): Promise<{ model: string; terminal: string }> {
  const [{ generateServerSessionStartContext }, { ModeManager }] = await Promise.all([
    import('../../services/context/ContextBuilder.js'),
    import('../../services/domain/ModeManager.js'),
  ]);
  // The worker loads the active mode at boot. This hook process has no worker,
  // so it loads the same mode itself: the renderer reads its observation types,
  // emojis and legend.
  ModeManager.getInstance().loadMode(modeId);
  const { model, terminal } = await generateServerSessionStartContext(runtime, contextInput, {
    withTerminalRender: withColoredTerminalRender,
    timeoutMs: serverSessionStartBudgetMs(host),
  });
  return { model, terminal: terminal ?? model };
}

/** SQLite NOCASE folds only ASCII letters when comparing project keys. */
const foldProject = (key: string) => key.replace(/[A-Z]/g, letter => letter.toLowerCase());

function excludedSessionStartProjects(
  projects: string[],
  { checkoutPathsByProject, projectMerges }: ProjectExclusionCatalog,
  patterns: string,
): Set<string> {
  const names = new Set(projects);
  const targets = new Map<string, string[]>();
  for (const { source, target } of projectMerges) {
    // A merge can name a project with no entry of its own in sdk_sessions.
    names.add(source);
    names.add(target);
    const key = foldProject(source);
    const destinations = targets.get(key);
    if (destinations) destinations.push(foldProject(target));
    else targets.set(key, [foldProject(target)]);
  }

  const excluded = new Set<string>();
  for (const name of names) {
    const paths = Object.hasOwn(checkoutPathsByProject, name) ? checkoutPathsByProject[name] : [];
    if (isProjectExcluded(name, patterns) || paths.some(cwd => isProjectExcluded(cwd, patterns))) {
      excluded.add(foldProject(name));
    }
  }
  // A read also selects rows stamped into a target and follows whole merges
  // transitively. Set iteration visits newly added targets once, even in cycles.
  for (const source of excluded) {
    for (const target of targets.get(source) ?? []) excluded.add(target);
  }
  return excluded;
}

/**
 * Why SessionStart skipped the timeline with exclusions configured: the worker
 * could not be reached, answered without a catalog (5xx, autostart off), or
 * answered with one that lacks checkout paths (an older worker). Written only
 * by resolveSessionStartProjects; the handler words it for the model and user.
 */
export type SessionStartTimelineSkip = 'worker-unreachable' | 'catalog-unavailable' | 'catalog-incomplete';

export interface SessionStartProjectScope {
  projects: string[];
  timelineSkip: SessionStartTimelineSkip | null;
  /**
   * Without exclusions, when the catalog failed: the scope under the last
   * stored catalog, whose cached variant is tried before this checkout's (#6403).
   */
  cacheFallbackProjects: string[] | null;
}

/** An all-project scope from a catalog list: the other projects sorted, this checkout's keys last. */
function allProjectScope(catalogProjects: string[], checkoutProjects: string[], allowed: (project: string) => boolean = () => true): string[] {
  const otherProjects = catalogProjects.filter(project => !checkoutProjects.includes(project) && allowed(project)).sort();
  return [...otherProjects, ...checkoutProjects.filter(allowed)];
}

/**
 * The all-project scope under the last stored catalog, or null when there is
 * none to use. Never with exclusions: the stored list carries no checkout paths
 * or merges, so it cannot prove an excluded project out (#6402); those reads
 * always ask the worker.
 */
export function storedCatalogScope(
  settings: { CLAUDE_MEM_CONTEXT_PROJECTS?: string; CLAUDE_MEM_EXCLUDED_PROJECTS?: string },
  checkoutProjects: string[],
): string[] | null {
  if (settings.CLAUDE_MEM_CONTEXT_PROJECTS !== 'all' || settings.CLAUDE_MEM_EXCLUDED_PROJECTS?.trim()) return null;
  const stored = readContextProjectCatalog();
  return stored ? allProjectScope(stored, checkoutProjects) : null;
}

export const SESSION_START_TIMELINE_SKIP_NOTICES: Record<SessionStartTimelineSkip, string> = {
  'worker-unreachable': '[claude-mem] Recent context skipped: excluded projects could not be checked (worker not ready).',
  'catalog-unavailable': '[claude-mem] Recent context skipped: excluded projects could not be checked (the worker did not return its project list).',
  'catalog-incomplete': '[claude-mem] Recent context skipped: excluded projects could not be checked (the worker is out of date; run `npx claude-mem restart`).',
};

/**
 * The projects SessionStart reads. By default only this checkout's keys.
 * With CLAUDE_MEM_CONTEXT_PROJECTS=all, every project in the local catalog
 * (minus excluded ones), sorted so the context cache keys stay stable, with
 * this checkout's keys last because the last key titles the rendered block.
 * Without exclusions a catalog failure falls back to this checkout. With
 * exclusions even this checkout might read a merged source, so skip the
 * timeline if the worker cannot supply the catalog, and say why in
 * `timelineSkip`. Server mode always requests only the current checkout's keys.
 */
export async function resolveSessionStartProjects(
  settings: { CLAUDE_MEM_CONTEXT_PROJECTS?: string; CLAUDE_MEM_EXCLUDED_PROJECTS?: string },
  checkoutProjects: string[],
  runtime: 'worker' | 'server',
): Promise<SessionStartProjectScope> {
  const scope = (projects: string[]): SessionStartProjectScope => ({ projects, timelineSkip: null, cacheFallbackProjects: null });
  if (settings.CLAUDE_MEM_CONTEXT_PROJECTS !== 'all') return scope(checkoutProjects);
  if (runtime === 'server') {
    logger.debug('HOOK', 'CLAUDE_MEM_CONTEXT_PROJECTS=all is not supported in server runtime');
    return scope(checkoutProjects);
  }
  const excludedPatterns = settings.CLAUDE_MEM_EXCLUDED_PROJECTS?.trim();
  const fallback = (timelineSkip: SessionStartTimelineSkip, detail: Record<string, unknown>): SessionStartProjectScope => {
    if (!excludedPatterns) {
      logger.debug('HOOK', 'Project catalog unavailable; SessionStart reads this checkout live', detail);
      return { ...scope(checkoutProjects), cacheFallbackProjects: storedCatalogScope(settings, checkoutProjects) };
    }
    logger.warn('HOOK', 'SessionStart timeline skipped: excluded projects could not be checked', { timelineSkip, ...detail });
    return { projects: [], timelineSkip, cacheFallbackProjects: null };
  };
  try {
    const url = excludedPatterns ? '/api/projects?includeCheckoutPaths=true' : '/api/projects';
    const catalog = await executeWithWorkerFallback<Partial<ProjectExclusionCatalog> & { projects?: unknown }>(url, 'GET', undefined, {
      workerStartupTimeoutMs: HOOK_TIMEOUTS.POST_SPAWN_WAIT,
      timeoutMs: 2_000,
    });
    if (isWorkerFallback(catalog)) {
      const reason = 'reason' in catalog ? catalog.reason : undefined;
      return fallback(reason === 'worker_unreachable' ? 'worker-unreachable' : 'catalog-unavailable', { reason });
    }
    if (!Array.isArray(catalog?.projects)) return fallback('catalog-incomplete', { field: 'projects' });
    const projects = catalog.projects.filter((project): project is string => typeof project === 'string' && project.length > 0);
    // Kept so the next SessionStart can serve its cached variant without the
    // worker, or find it while the worker is down (readContextProjectCatalog).
    saveContextProjectCatalog(projects);

    let excluded: Set<string> | undefined;
    if (excludedPatterns) {
      const { checkoutPathsByProject, projectMerges } = catalog;
      // An older worker ignores includeCheckoutPaths and answers without them.
      if (!checkoutPathsByProject || !Array.isArray(projectMerges)) {
        return fallback('catalog-incomplete', { field: 'checkoutPathsByProject' });
      }
      excluded = excludedSessionStartProjects(
        [...projects, ...checkoutProjects], { checkoutPathsByProject, projectMerges }, excludedPatterns,
      );
    }
    const allowed = (project: string) => !excluded?.has(foldProject(project));
    const droppedCheckoutProjects = checkoutProjects.filter(project => !allowed(project));
    // Keys only, never paths: a checkout key drops when it or a source merged into it is excluded.
    if (droppedCheckoutProjects.length > 0) {
      logger.debug('HOOK', 'SessionStart left out excluded checkout keys', { droppedCheckoutProjects });
    }
    return scope(allProjectScope(projects, checkoutProjects, allowed));
  } catch (error) {
    return fallback(isWorkerUnavailableError(error) ? 'worker-unreachable' : 'catalog-unavailable', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export const contextHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    // Devin runs this on PostCompaction too, and drops a reply whose
    // hookEventName is not the event that fired.
    const hookEventName = input.hookEventName === 'PostCompaction' ? 'PostCompaction' : 'SessionStart';
    const emptyResult: HookResult = {
      hookSpecificOutput: { hookEventName, additionalContext: '' },
      exitCode: HOOK_EXIT_CODES.SUCCESS,
    };

    // This run is the thread's re-injection, so a Codex compaction it was
    // waiting on is answered and its next tool call does not repeat the
    // timeline (see src/shared/codex-compaction-gate.ts).
    if (input.platform === 'codex') {
      clearTimelinePending(input.sessionId, input.agentId);
    }

    // --continue, --resume and /resume restore the existing conversation.
    // A fresh timeline would change its prompt prefix and invalidate the cache.
    // Also guard direct calls from older hook registrations that include resume.
    if (input.platform === 'claude-code' && input.sessionSource === 'resume') {
      return emptyResult;
    }

    const cwd = input.cwd ?? process.cwd();

    // Honor CLAUDE_MEM_EXCLUDED_PROJECTS on the inject/read path too. The
    // write path (ingestObservation) already skips excluded projects, but the
    // SessionStart summary was injected regardless — so an excluded dir (e.g.
    // "~") still got a context dump on every new session. Suppress it here.
    if (!shouldTrackProject(cwd)) {
      return emptyResult;
    }

    const context = getProjectContext(cwd);
    const port = getWorkerPort();

    // How to use claude-mem's tools is in the MCP server's instructions
    // (shared/memory-instructions.ts), not in this block: it is the timeline.
    const settings = loadFromFileOnce();

    // A deferred agent install is explicit. A missing setup file on an older
    // installation does not interrupt normal sessions or force onboarding.
    const runtime = resolveRuntimeContext();
    let onboardingNotice: string | null = null;
    if (runtime.runtime === 'worker') {
      try {
        onboardingNotice = pendingSetupNotice(readSetupState(), getViewerBaseUrl(port));
      } catch (error) {
        logger.debug('HOOK', 'Could not read pending onboarding', { error: error instanceof Error ? error.message : String(error) });
      }
    }

    // Disclosures belong to the user, including with the timeline banner off.
    // Consume only when returning a result, so a failed async read cannot mark
    // an undelivered disclosure as shown. Other hosts use their installer flow.
    const userNotice = (workerNotice: string | null = null): string | null => [
      onboardingNotice,
      workerNotice,
      input.platform === 'claude-code' ? consumeTelemetryNotice() : null,
    ].filter(Boolean).join('\n\n') || null;
    // Reserve room before reading the timeline. Commit delivery only when the
    // hook is returning context. Onboarding takes precedence over release notes.
    const pendingMessage = onboardingNotice ? undefined : nextClaudeMemMessage(input, settings);
    const messageText = pendingMessage ? formatClaudeMemMessage(pendingMessage) : '';
    const claimMessage = (): string => pendingMessage && dispatchClaudeMemMessage(pendingMessage.id) ? messageText : '';
    const noticeOnlyResult = (notice: string | null): HookResult => ({
      ...emptyResult,
      hookSpecificOutput: { hookEventName, additionalContext: [onboardingNotice, claimMessage()].filter(Boolean).join('\n\n') },
      ...(notice ? { systemMessage: notice } : {}),
    });

    const notices: string[] = [];
    if (onboardingNotice) notices.push(onboardingNotice);

    // Issue #2215: surface stale OAuth token marker as a session-start hint.
    // Marker is written by EnvManager.buildIsolatedEnvWithFreshOAuth() when
    // a previous worker spawn detected an expired keychain entry.
    // Other observer providers do not use Claude credentials. Keep the hint
    // for a configured Claude route, including the gateway's active fallback.
    // Any source can be mapped to its own provider, so a mapped route counts
    // like the global one: a mapped gateway is memory's provider for its
    // sessions, and its expiry notice below must still reach the user.
    const mappedProviders = providersMappedBySource(settings.CLAUDE_MEM_PROVIDER_BY_SOURCE);
    const gatewayRole = cmemGatewayRole(
      mappedProviders.includes('openrouter') ? { ...settings, CLAUDE_MEM_PROVIDER: 'openrouter' } : settings,
    );
    // Empty is the default fallback, the Anthropic plan (provider-dispatch's readQuotaFallbackProvider).
    const fallbackSetting = String(settings.CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER ?? '').trim();
    const usesClaudeCredentials = (settings.CLAUDE_MEM_PROVIDER || 'claude') === 'claude'
      || mappedProviders.includes('claude')
      || fallbackSetting === 'claude' || fallbackSetting === ''
      || (gatewayRole === 'primary' && Boolean(settings.CLAUDE_MEM_PRO_FALLBACK_AT));
    const staleReason = usesClaudeCredentials ? readStaleMarker() : null;
    if (staleReason) {
      // The observer authenticates with the Claude Code CLI credentials
      // (keychain service "Claude Code-credentials", see oauth-token.ts), not
      // Claude Desktop. Point the remedy at the CLI so the user runs the right
      // login (#4150).
      // The marker is a file, so bound its reason before reserving the hint.
      const hint = `[claude-mem] Claude Code OAuth token is stale: ${clipUtf16(staleReason, 1_000)}\nRun /login in Claude Code (or \`claude auth login\` in a terminal) to refresh it.`;
      notices.push(hint);
    }

    // Trial-expiry fallback notice (plan 2026-08-26 Phase 6): the worker wrote
    // CLAUDE_MEM_PRO_FALLBACK_AT when the cmem gateway terminally rejected the
    // delivered key, and dispatch now runs memory on the Anthropic plan. Tell
    // the user exactly once (DATA_DIR marker file, oauth-stale pattern); the
    // marker resets whenever the fallback is cleared.
    //
    // The gateway's own words, stored with the marker, say what happened and
    // what to do. They enter model context, so proFallbackNotice relays them
    // as plain bounded lines and keeps only an https cmem.ai link.
    //
    // The gateway as the opt-in quota fallback gets the same notice with its
    // own consequence: dispatch skips it while it turns the account away, and
    // without this the user would never learn why the fallback stopped.
    const fallbackActive = settings.CLAUDE_MEM_PRO_FALLBACK_AT !== '' && gatewayRole !== null;
    const showFallbackNotice = fallbackActive && !hasShownProFallbackNotice();
    if (showFallbackNotice) {
      const fallbackNotice = proFallbackNotice({
        message: settings.CLAUDE_MEM_PRO_FALLBACK_MESSAGE,
        action: settings.CLAUDE_MEM_PRO_FALLBACK_ACTION,
        url: settings.CLAUDE_MEM_PRO_FALLBACK_URL,
      }, gatewayRole, cmemCapExhaustedAt() !== null);
      notices.unshift(fallbackNotice);

    }

    const noticeText = [...notices, messageText].filter(Boolean).join('\n\n');
    const noticeReserveChars = noticeText ? noticeText.length + 2 : 0;

    // TeamBrain brief: a per-session notice, never part of the cacheable
    // context body. Asked now so its budget overlaps the local context read;
    // the request never rejects, and it is not asked at all without a team.
    const teamBrain = teamBrainConnection(settings);
    const teamBriefRequest = teamBrain ? fetchTeamBrief(teamBrain, context.primary, TEAM_BRIEF_TIMEOUT_MS) : null;

    // Codex already receives the timeline through additionalContext. Repeating
    // it as systemMessage can push SessionStart stdout past Codex's hook-output
    // limit, causing Codex to discard the entire payload (including context).
    const showTerminalOutput =
      settings.CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT === 'true'
      && input.platform !== 'codex';

    // Server runtime reads the shared server (plan-24 step 4). When the server
    // settings are incomplete, resolveRuntimeContext() falls back to the worker,
    // exactly as the write hooks do, so reads and writes stay on one corpus.
    const serverRuntime = runtime.runtime === 'server' ? runtime : null;

    const normalizedPlatformSource = input.platform
      ? normalizePlatformSource(input.platform)
      : undefined;
    // Let users share startup memory across harnesses without changing the
    // source-scoped behavior of search and other context requests.
    const platformSourceParam = input.platform && settings.CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES !== 'true'
      ? `&platformSource=${encodeURIComponent(normalizedPlatformSource!)}`
      : '';
    // "Include last message" picks the prior session's reply by excluding this
    // one, so the worker gets the session id and SessionStart is answered live.
    const showLastMessage = settings.CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE === 'true';

    // Precomputed SessionStart context (liveness plan, Phase 6): the worker
    // keeps each variant it has served rendered on disk, keyed exactly like
    // the inject URLs below. A hit needs no worker at all; a miss takes the
    // live path. A cached block never carries the prior reply, so with
    // "Include last message" on it is read only when the worker cannot answer.
    const cacheNowEpochMs = Date.now();
    const cacheSource = platformSourceParam ? normalizedPlatformSource : undefined;
    const readCachedVariant = (projects: string[], colors: boolean): string | null => {
      if (serverRuntime || projects.length === 0) return null;
      const cached = readContextCache(contextCacheKeys(projects, cacheSource, colors, cwd), cacheNowEpochMs);
      if (!cached) return null;
      const filled = fillContextPlaceholders(cached.body, cacheNowEpochMs, cached.placeholderNonce);
      // A cached body was rendered for the full budget, without this session's
      // notice reserve (#5672). Serve it only when it fits the room the
      // current notices leave, the same room composeSessionStartContext
      // enforces below; otherwise fall through to the next candidate or the
      // live fetch, which re-renders it with the current reserve. Never cut a
      // rendered entry to fit.
      if (!colors && filled.length > sessionStartBodyRoom(noticeText)) return null;
      logger.debug('HOOK', 'SessionStart context served from the context cache', {
        colors,
        renderedAgoMs: cacheNowEpochMs - cached.renderedAtEpochMs,
      });
      return filled;
    };

    // Cache first (#6403): with every project and no exclusions, the variant
    // under the last stored catalog is served without asking the worker. The
    // catalog is asked only on a miss.
    const storedScope = serverRuntime || showLastMessage ? null : storedCatalogScope(settings, context.allProjects);
    const storedHit = storedScope ? readCachedVariant(storedScope, false) : null;
    const { projects: scopeProjects, timelineSkip, cacheFallbackProjects } = storedScope && storedHit !== null
      ? { projects: storedScope, timelineSkip: null, cacheFallbackProjects: null }
      : await resolveSessionStartProjects(settings, context.allProjects, runtime.runtime);
    // An empty projects parameter would make the renderer rediscover the checkout.
    const hasTimelineScope = scopeProjects.length > 0;
    // A skipped timeline is said out loud, to the model and the user, never dropped silently.
    const timelineSkipNotice = timelineSkip ? SESSION_START_TIMELINE_SKIP_NOTICES[timelineSkip] : null;
    const projectsQuery = projectsQueryString(scopeProjects);
    // With the catalog down, the variant under the stored catalog comes first.
    // Each candidate passes the room check on its own, so a broad block too big
    // for this session's notices never hides a checkout block that fits.
    const cacheCandidates = cacheFallbackProjects ? [cacheFallbackProjects, scopeProjects] : [scopeProjects];
    const readCachedRender = (colors: boolean): string | null => {
      if (!hasTimelineScope) return null;
      for (const projects of cacheCandidates) {
        const filled = readCachedVariant(projects, colors);
        if (filled !== null) return filled;
      }
      return null;
    };
    const sessionParam = showLastMessage && input.sessionId ? `&sessionId=${encodeURIComponent(input.sessionId)}` : '';
    const noticeBudgetParam = noticeReserveChars ? `&reserveChars=${noticeReserveChars}` : '';
    const apiPath = `/api/context/inject?${projectsQuery}${platformSourceParam}&cwd=${encodeURIComponent(cwd)}${sessionParam}${noticeBudgetParam}`;
    const colorApiPath = input.platform === 'claude-code' ? `${apiPath}&colors=true` : apiPath;

    const serverRender = serverRuntime
      ? await renderSessionStartFromServer(
          serverRuntime,
          {
            session_id: input.sessionId,
            cwd,
            projects: scopeProjects,
            ...(platformSourceParam ? { platformSource: normalizedPlatformSource } : {}),
            reserveChars: teamBriefReserveChars(settings) + noticeReserveChars,
          },
          showTerminalOutput && input.platform === 'claude-code',
          settings.CLAUDE_MEM_MODE,
          input.platform,
        )
      : null;

    const cachedModelContext = showLastMessage ? null : storedHit ?? readCachedRender(false);

    // ponytail: Codex's MCP normally starts the worker; this one bounded
    // fallback covers cold sessions without the old startup process chain.
    const workerOptions = input.platform === 'codex'
      ? { workerStartupTimeoutMs: HOOK_TIMEOUTS.POST_SPAWN_WAIT, timeoutMs: 2_000 }
      : undefined;
    let workerOutageNotice: string | null = null;
    if (timelineSkip && timelineSkip !== 'catalog-incomplete') {
      // The catalog call stood in for the inject call, so count the outage as
      // that call would have (unbounded everywhere but Codex) and deliver the
      // once-per-session outage notice the same way.
      if (timelineSkip === 'worker-unreachable' && input.platform !== 'codex') await recordWorkerUnreachable();
      workerOutageNotice = await consumeWorkerOutageNotice(input.sessionId);
    }
    let contextResult: WorkerCallResult<string>;
    try {
      contextResult = serverRender?.model ?? cachedModelContext ?? (hasTimelineScope
        ? await executeWithWorkerFallback<string>(apiPath, 'GET', undefined, workerOptions)
        : timelineSkipNotice ?? '');
    } catch (error) {
      if (input.platform !== 'claude-code' || !isWorkerUnavailableError(error)) throw error;
      await recordWorkerUnreachable();
      return noticeOnlyResult(userNotice(await consumeWorkerOutageNotice(input.sessionId)));
    }
    if (showLastMessage && isWorkerFallback(contextResult)) {
      const cachedFallback = readCachedRender(false);
      if (cachedFallback !== null) {
        contextResult = cachedFallback;
        workerOutageNotice = await consumeWorkerOutageNotice(input.sessionId);
      }
    }
    if (isWorkerFallback(contextResult)) {
      // SessionStart context is synchronous, so a systemMessage here is shown
      // to the user: the once-per-session worker-outage notice, if any.
      return noticeOnlyResult(userNotice(await consumeWorkerOutageNotice(input.sessionId)));
    }

    let additionalContext: string;
    if (typeof contextResult === 'string') {
      additionalContext = contextResult.trim();
      // Claude Code that loads RULES-AND-TOOLS.md through CLAUDE.md needs no pointer to it.
      if (input.platform === 'claude-code') additionalContext = withoutLoadedRulesPointer(additionalContext);
    } else if (contextResult === undefined) {
      additionalContext = '';
    } else {
      logger.warn('HOOK', 'Context response was not a string', { type: typeof contextResult });
      return { ...emptyResult, systemMessage: userNotice() ?? undefined };
    }

    let coloredTimeline = '';
    if (showTerminalOutput && hasTimelineScope) {
      const colors = input.platform === 'claude-code';
      try {
        const colorResult = serverRender
          ? serverRender.terminal
          : (showLastMessage ? null : readCachedRender(colors))
            ?? await executeWithWorkerFallback<string>(colorApiPath, 'GET', undefined, workerOptions);
        if (!isWorkerFallback(colorResult) && typeof colorResult === 'string') {
          coloredTimeline = colorResult.trim();
        } else if (showLastMessage && isWorkerFallback(colorResult)) {
          coloredTimeline = readCachedRender(colors)?.trim() ?? '';
        }
      } catch (error) {
        if (input.platform !== 'claude-code' || !isWorkerUnavailableError(error)) throw error;
        await recordWorkerUnreachable();
        workerOutageNotice = await consumeWorkerOutageNotice(input.sessionId);
      }
    }

    const platform = input.platform;
    const teamSection = teamBriefRequest ? teamBriefSection(await teamBriefRequest) : '';
    // Only the process that atomically claims the marker may deliver the
    // fallback notice. Waiting until all reads finish keeps failed attempts
    // retryable. A lost claim merely leaves a little unused render budget.
    if (showFallbackNotice && !markProFallbackNoticeShown()) notices.shift();
    const dispatchedMessage = claimMessage();
    if (dispatchedMessage) notices.push(dispatchedMessage);
    additionalContext = composeSessionStartContext(additionalContext, notices.join('\n\n'), teamSection);

    // Antigravity CLI (like the former Gemini CLI) is hooks-based, not an
    // MCP-context-fetch platform like Codex — colorApiPath never populates
    // coloredTimeline for it (colors are claude-code-only above), so fall
    // back to the plain additionalContext for terminal display.
    const displayContent = coloredTimeline || (platform === 'antigravity-cli' ? additionalContext : '');

    // Days-remaining nicety: while the free trial is active (plan 'trial', an
    // end date stored, no fallback), append the countdown. Computed locally —
    // no network — and display-only: nothing is enabled or disabled by it.
    const daysLeft = !fallbackActive && settings.CLAUDE_MEM_PRO_PLAN === 'trial'
      ? trialDaysRemaining(settings.CLAUDE_MEM_PRO_TRIAL_ENDS_AT)
      : null;
    const trialDaysLine = daysLeft !== null && daysLeft >= 0
      ? `claude-mem free trial: ${daysLeft} day${daysLeft === 1 ? '' : 's'} left`
      : null;

    // In server runtime the viewer is served by the server (#2552), not by a
    // local worker, so the link points there.
    const viewerUrl = serverRuntime ? serverRuntime.serverBaseUrl : getViewerBaseUrl(port);
    const showsBanner = showTerminalOutput && Boolean(displayContent);
    // TeamBrain discovery: one line on the banner the user already reads, once
    // per install, and never once this install is in a team.
    const teamBrainDiscoveryLine = showsBanner && !teamBrain && !hasShownTeamBrainDiscoveryNotice()
      ? TEAMBRAIN_DISCOVERY_LINE
      : null;
    if (teamBrainDiscoveryLine) markTeamBrainDiscoveryNoticeShown();
    const notice = userNotice([timelineSkipNotice, workerOutageNotice].filter(Boolean).join('\n\n') || null);
    // Claude Code's session-start card named a file: once the banner is in it
    // the card draws it, and the hook message is the closing line alone.
    // The card is placed when Claude Code keeps the row that holds the hooks'
    // context (src/mods/session-start-card/register.ts), and Claude Code makes
    // that row only for context that is not empty: without any, the file stays
    // unwritten and the whole banner goes in the hook message.
    // The card can still fail to draw, so what is shown only once (the
    // notices, the TeamBrain discovery line) stays in the hook message.
    // Where the card's SessionStart hook is passed over (a Team or Enterprise
    // account, #6314) the event names no file. The hook then names the slot
    // itself, and only while the card's request file says it is looking for
    // one: without a request the whole banner goes in the hook message. The
    // card writes that request while this hook runs, so the hook waits a
    // bounded time for it where a card has asked before.
    const sessionStartCardFile = showsBanner && additionalContext !== ''
      ? input.sessionStartCardFile ?? await awaitSessionStartCardSlotForRequest(input.sessionId, input.sessionSource)
      : undefined;
    const cardDrawsBanner = sessionStartCardFile !== undefined
      && writeSessionStartCardSlot(
        sessionStartCardFile,
        input.sessionId,
        sessionStartCardText(displayContent, sessionStartBannerHeader(trialDaysLine, null, settings.CLAUDE_MEM_PRO_PLAN)),
      );
    const systemMessage = cardDrawsBanner
      ? composeSessionStartCardSystemMessage(displayContent, viewerUrl, notice, teamBrainDiscoveryLine)
      : composeSessionStartSystemMessage(
        showsBanner ? displayContent : null,
        sessionStartBannerHeader(trialDaysLine, teamBrainDiscoveryLine, settings.CLAUDE_MEM_PRO_PLAN),
        viewerUrl,
        notice,
      );

    return {
      hookSpecificOutput: {
        hookEventName,
        additionalContext
      },
      systemMessage
    };
  }
};
