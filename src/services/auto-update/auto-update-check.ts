/**
 * The worker's auto-update check: decides whether this install should move to
 * the release the owner promoted (releases/promoted-release.json on main), and
 * whether now is a good moment.
 *
 * Each tick walks the gates in runAutoUpdateCheck in order and returns the
 * first decision that applies, logged under AUTO_UPDATE. Only `apply` acts,
 * through deps.launchSupervisor.
 *
 * Own module, with every effect injected, for the same reason as
 * idle-exit-monitor.ts: worker-service.ts drags in a very large dependency
 * graph, so the decision logic lives here and `bun test` exercises it directly.
 * It imports no database code either: the worker injects its database read
 * (WorkerQuietSignals.getNewestCapturedActivityAt).
 */

import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { readUserScopeRegisteredCacheVersions } from '../../npx-cli/utils/prune-cache.js';
import { parseJsonWithBom } from '../../shared/atomic-json.js';
import { SettingsDefaultsManager, coercePersistedSettingValue, type SettingsDefaults } from '../../shared/SettingsDefaultsManager.js';
import { loadDocument, settingsTarget } from '../../shared/settings-document.js';
import { isWorkerAutostartDisabled } from '../../shared/worker-autostart.js';
import { compareVersionsDescending, type PluginRootResolution } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import type { InterruptedAttemptInstall } from './auto-update-apply.js';
import { AUTO_UPDATE_FETCH_TIMEOUT_MS, AUTO_UPDATE_SUPERVISOR_DEADLINE_MS } from './auto-update-deadlines.js';
import type { AutoUpdateAttemptOutcome, AutoUpdateInFlightAttempt, AutoUpdateState } from './auto-update-state.js';

/**
 * The owner's release switch on main. It lives here, not in the settings
 * defaults: SettingsDefaultsManager writes every default into a new
 * settings.json, and a saved value wins over the code default, so a URL
 * default would be pinned into every install and the switch file could never
 * move. CLAUDE_MEM_AUTO_UPDATE_PROMOTED_RELEASE_URL defaults to '' and empty
 * means this URL, the way CLAUDE_MEM_OPENROUTER_BASE_URL defaults to '' and
 * means DEFAULT_OPENROUTER_API_URL (src/shared/openrouter-base-url.ts).
 */
export const DEFAULT_PROMOTED_RELEASE_URL = 'https://raw.githubusercontent.com/thedotmack/claude-mem/main/releases/promoted-release.json';

/**
 * One network check a day. Releases land on about 17 of every 30 days (28
 * releases on 17 days in the 30 days to 2026-11-06), so one check a day picks
 * up each release day's promoted version. A failed fetch counts as a check, so
 * a broken network never turns into hourly retries.
 */
export const AUTO_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * A machine that is never quiet still updates: once a deferral has seen one
 * check cycle of busy time, the update applies anyway. The time is observed,
 * not read off the wall clock (recordBusyObservation), so a laptop asleep over
 * a weekend does not count as two days of busy time.
 */
export const AUTO_UPDATE_BUSY_DEFERRAL_LIMIT_MS = AUTO_UPDATE_CHECK_INTERVAL_MS;

/**
 * How long an attempt stays in flight past the supervisor deadline while its
 * recorded supervisor pid is alive: one check cycle. A laptop that sleeps
 * during an install wakes past the wall-clock deadline with its supervisor
 * still running, and recording that supervisor as vanished would block its
 * version for good. Past a full day a live pid is treated as reused by another
 * process, so updates are never blocked longer than a day.
 */
export const AUTO_UPDATE_LIVE_SUPERVISOR_CEILING_MS = AUTO_UPDATE_CHECK_INTERVAL_MS;

// AUTO_UPDATE_FETCH_TIMEOUT_MS bounds each background fetch; its reason is
// next to its definition in auto-update-deadlines.ts, which counts one fetch
// in the supervisor deadline.
export { AUTO_UPDATE_FETCH_TIMEOUT_MS };

/**
 * "Quiet" needs this long without session activity, user prompts or captured
 * tool use. The 75th-percentile gap between prompts in a session is 17.9 min
 * (1,995 gaps in the owner's user_prompts table, last 60 days, 2026-11-06), so
 * a longer silence means the person stepped away rather than paused.
 */
export const AUTO_UPDATE_QUIET_WINDOW_MS = 18 * 60 * 1000;

/**
 * The worker's first tick waits 5 minutes, the same delay and reason as log
 * retention: boot and the first session's hooks finish before any background
 * network work.
 */
export const AUTO_UPDATE_FIRST_TICK_DELAY_MS = 5 * 60 * 1000;

/**
 * Then one tick an hour, so the quiet rule gets a chance to find a quiet hour.
 * The network is still touched about once a day: the scheduled check
 * (AUTO_UPDATE_CHECK_INTERVAL_MS), plus one confirming fetch when a deferred
 * update is about to apply. It is also the most busy time one tick can add to
 * a deferral: a longer gap since the last busy tick means the worker or the
 * machine was not running, and that is not observed busy time.
 */
export const AUTO_UPDATE_TICK_INTERVAL_MS = 60 * 60 * 1000;

/** The only promoted-file format this client reads; any other must be ignored, never misread. */
const PROMOTED_RELEASE_SCHEMA_VERSION = 1;

/**
 * An exact release, the only form of promotedVersion (tests/infrastructure/promoted-release.test.ts pins it),
 * so the only form of a target version the supervisor accepts (auto-update-launch.ts).
 */
export const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

/**
 * An installed version compareVersionsDescending can rank: a release, optionally with a prerelease tag.
 * The only form of a previous version the supervisor accepts (auto-update-launch.ts).
 */
export const INSTALLED_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** The predicate type npm records for provenance from the publish workflow (.github/workflows/npm-publish.yml). */
const SLSA_PROVENANCE_V1_PREDICATE_TYPE = 'https://slsa.dev/provenance/v1';

/** npm's answer for a version that was never published. */
const HTTP_STATUS_NOT_FOUND = 404;

/** Unit conversion, so the vanished-supervisor message states the deadline in minutes. */
const MILLISECONDS_PER_MINUTE = 60_000;

/** Unit conversion, so the vanished-supervisor message states the live-pid ceiling in hours. */
const MILLISECONDS_PER_HOUR = 60 * MILLISECONDS_PER_MINUTE;

/** claude-mem's key in Claude Code's enabledPlugins and installed_plugins.json (install.ts registerPlugin, enablePluginInClaudeSettings). */
const CLAUDE_MEM_PLUGIN_KEY = 'claude-mem@thedotmack';

/**
 * The only CLAUDE_MEM_RUNTIME the updater runs under. A non-interactive
 * `update` writes CLAUDE_MEM_RUNTIME=worker (install.ts promptRuntime), so on
 * a server-runtime install it would switch the runtime. Read the way the hooks
 * read it (services/hooks/runtime-selector.ts): trimmed, any case.
 */
const WORKER_RUNTIME = 'worker';

/**
 * Claude Code's documented switches for no background updates, each read the
 * way https://code.claude.com/docs/en/env-vars describes it (read 2026-11-07):
 *  - DISABLE_AUTOUPDATER: "Set to `1` to disable automatic background
 *    updates. Manual `claude update` still works. Use `DISABLE_UPDATES` to
 *    block both".
 *  - DISABLE_UPDATES: "Set to `1` to block all updates including manual
 *    `claude update` and `claude install`. Stricter than
 *    `DISABLE_AUTOUPDATER`."
 *    Both are read the way claude-mem reads Claude Code's other env flags
 *    (observed-billing.ts isTruthyEnv): any value but empty, 0 or false is on.
 *  - CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "Set to any non-empty value,
 *    such as `1`, to disable nonessential network traffic: auto-updates, ...
 *    Setting it to `0` or `false` still disables this traffic, unlike most
 *    on/off variables; unset the variable to allow it again." So any
 *    non-empty value is on, 0 and false included.
 * The CLAUDE_CODE_* one only reaches the worker's own env because
 * env-sanitizer.ts names it in ENV_PRESERVE; every worker spawn strips the
 * other CLAUDE_CODE_* variables. The same switches are also read from the env
 * block of Claude Code's settings files (readClaudeCodeSettingsEnvBlocks).
 * FORCE_AUTOUPDATE_PLUGINS takes the one marked overriddenByForcedPluginAutoUpdates
 * out of force (FORCE_PLUGIN_AUTO_UPDATES).
 */
const CLAUDE_CODE_NO_BACKGROUND_UPDATE_SWITCHES: ReadonlyArray<{
  name: string;
  isOn: (value: string | undefined) => boolean;
  overriddenByForcedPluginAutoUpdates: boolean;
}> = [
  { name: 'DISABLE_AUTOUPDATER', isOn: isEnvSwitchOn, overriddenByForcedPluginAutoUpdates: true },
  { name: 'DISABLE_UPDATES', isOn: isEnvSwitchOn, overriddenByForcedPluginAutoUpdates: false },
  { name: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', isOn: isSetToAnyNonEmptyValue, overriddenByForcedPluginAutoUpdates: false },
];

/**
 * The switches above that forced plugin auto-updates leave in force. One of
 * them on in the worker's env turns auto-update off with nothing else read.
 */
const SWITCHES_FORCED_PLUGIN_AUTO_UPDATES_LEAVE_IN_FORCE = CLAUDE_CODE_NO_BACKGROUND_UPDATE_SWITCHES
  .filter((candidate) => !candidate.overriddenByForcedPluginAutoUpdates);

/**
 * Claude Code's switch that brings plugin auto-updates back:
 * "`FORCE_AUTOUPDATE_PLUGINS` | Set to `1` to force plugin auto-updates even
 * when the main auto-updater is disabled via `DISABLE_AUTOUPDATER`"
 * (https://code.claude.com/docs/en/env-vars, read 2026-11-08). claude-mem's
 * updater updates a plugin, so while it is 1, DISABLE_AUTOUPDATER no longer
 * turns it off. DISABLE_UPDATES and CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
 * still do: the docs give the force over DISABLE_AUTOUPDATER only. It is read
 * from the same places as the switches: the worker's env (it has no
 * CLAUDE_CODE_ prefix, so sanitizeEnv passes it) and the env blocks of Claude
 * Code's settings files (arePluginAutoUpdatesForced).
 */
const FORCE_PLUGIN_AUTO_UPDATES = 'FORCE_AUTOUPDATE_PLUGINS';

/** npm's metadata document for one published version of claude-mem. */
export function npmVersionMetadataUrl(version: string): string {
  return `https://registry.npmjs.org/claude-mem/${encodeURIComponent(version)}`;
}

export type AutoUpdateApplyReason = 'quiet' | 'busy-for-a-full-check-cycle';

export type AutoUpdateDecision =
  | { decision: 'disabled'; reason: string }
  | { decision: 'no-install' }
  | { decision: 'not-a-standard-install'; root: string }
  | { decision: 'unknown-installed-version'; root: string; installedVersion: string | null }
  | { decision: 'attempt-in-flight'; targetVersion: string; previousVersion: string; startedAt: number; supervisorPid: number | null }
  | { decision: 'not-due'; lastNetworkCheckAt: number }
  | { decision: 'check-failed'; stage: 'fetch-promoted-release' | 'fetch-npm-metadata'; message: string }
  /** schemaVersion is whatever the file held there, null when it held none. */
  | { decision: 'unknown-schema'; schemaVersion: unknown }
  | { decision: 'up-to-date'; installedVersion: string; promotedVersion: string }
  | { decision: 'previously-failed'; installedVersion: string; promotedVersion: string }
  | { decision: 'not-published-by-workflow'; promotedVersion: string; missing: string[] }
  | { decision: 'deferred-busy'; promotedVersion: string | null; busySince: number; observedBusyMs: number }
  | { decision: 'worker-shutting-down'; targetVersion: string; previousVersion: string }
  | { decision: 'apply'; targetVersion: string; previousVersion: string; applyReason: AutoUpdateApplyReason }
  | { decision: 'launch-failed'; targetVersion: string; previousVersion: string; message: string };

export type AutoUpdateDecisionName = AutoUpdateDecision['decision'];

/**
 * Logged once per boot, not every tick: each repeats unchanged for as long as
 * its switch, install or file stays as it is.
 */
const DECISIONS_LOGGED_ONCE_PER_BOOT: ReadonlySet<AutoUpdateDecisionName> = new Set([
  'disabled',
  'no-install',
  'not-a-standard-install',
  'unknown-installed-version',
  'unknown-schema',
]);

/** Where a tick failed outside the network checks, which report `check-failed` instead. */
export type AutoUpdateCheckStage =
  | 'read-settings'
  | 'read-claude-code-settings'
  | 'read-claude-code-plugin-state'
  | 'resolve-plugin-root'
  | 'read-state'
  | 'read-interrupted-attempt-install'
  | 'write-state';

/**
 * What is logged at most once per boot: the decisions above, the warning for
 * an unrecognised CLAUDE_MEM_AUTO_UPDATE value, the warning for each Claude
 * Code settings path skipped (keyed by its path), and the ERROR of a tick that
 * a broken settings file stops (logFailedAutoUpdateTick).
 */
export type AutoUpdateOncePerBootLogKey =
  | AutoUpdateDecisionName
  | 'unrecognised-CLAUDE_MEM_AUTO_UPDATE'
  | `skipped-claude-code-settings:${string}`
  | `tick-failed-at-${AutoUpdateCheckStage}`;

/** A tick that could not finish. The worker's timer logs it with its stage (logFailedAutoUpdateTick). */
export class AutoUpdateCheckError extends Error {
  constructor(readonly stage: AutoUpdateCheckStage, cause: unknown) {
    super(`auto-update check failed at ${stage}: ${errorMessageOf(cause)}`, { cause });
    this.name = 'AutoUpdateCheckError';
  }
}

/** One HTTP answer. `body` is the parsed JSON for a 2xx response and null otherwise. */
export interface FetchJsonResult {
  ok: boolean;
  status: number;
  body: unknown;
}

/** The settings one tick reads. */
export type AutoUpdateSettings = Pick<SettingsDefaults,
  | 'CLAUDE_MEM_AUTO_UPDATE'
  | 'CLAUDE_MEM_AUTO_UPDATE_PROMOTED_RELEASE_URL'
  | 'CLAUDE_MEM_WORKER_AUTOSTART'
  | 'CLAUDE_MEM_WORKER_URL'
  | 'CLAUDE_MEM_RUNTIME'>;

/** The keys readAutoUpdateSettings reads, in the order AutoUpdateSettings lists them. */
const AUTO_UPDATE_SETTING_KEYS: ReadonlyArray<keyof AutoUpdateSettings> = [
  'CLAUDE_MEM_AUTO_UPDATE',
  'CLAUDE_MEM_AUTO_UPDATE_PROMOTED_RELEASE_URL',
  'CLAUDE_MEM_WORKER_AUTOSTART',
  'CLAUDE_MEM_WORKER_URL',
  'CLAUDE_MEM_RUNTIME',
];

/** The `env` block of one of Claude Code's settings files. */
export interface ClaudeCodeSettingsEnvBlock {
  /** The file it was read from, named in the disabled reason. */
  path: string;
  env: Record<string, unknown>;
}

/** What readClaudeCodeSettingsEnvBlocks found. */
export interface ClaudeCodeSettingsEnvRead {
  /** The env block of each settings file it read, in the order Claude Code merges them. */
  envBlocks: ClaudeCodeSettingsEnvBlock[];
  /**
   * Settings files, or the managed drop-in directory, that exist but that
   * Claude Code runs without, so no switch in them is in force. The check
   * warns about each once per boot. `problem` names the path and what is wrong.
   */
  skipped: Array<{ path: string; problem: string }>;
}

/**
 * What Claude Code's own files say about claude-mem, read the way the
 * installer reads them (readClaudeCodePluginState): `update` would undo a
 * user's choice made there, or stop on a file it cannot read.
 */
export interface ClaudeCodePluginState {
  /** enabledPlugins['claude-mem@thedotmack'] in Claude Code's user settings (install.ts enablePluginInClaudeSettings sets it to true). */
  userSettings:
    | { kind: 'explicitly-disabled'; path: string }
    | { kind: 'not-disabled' }
    | { kind: 'unreadable'; path: string; problem: string };
  /**
   * claude-mem@thedotmack's user-scope entry in Claude Code's
   * installed_plugins.json, the one install.ts registerPlugin writes on every
   * install, for every host. Entries of other scopes are not read.
   */
  registration:
    | { kind: 'registered'; versions: string[] }
    | { kind: 'not-registered'; path: string }
    | { kind: 'unreadable'; path: string; problem: string };
}

export interface AutoUpdateCheckDeps {
  now: () => number;
  /** Read for Claude Code's switches; claude-mem's own settings come through readSettings. */
  env: NodeJS.ProcessEnv;
  /**
   * This tick's settings. Throws when settings.json exists but cannot be read
   * or parsed (readAutoUpdateSettings); a missing or empty file reads as the
   * defaults.
   */
  readSettings: () => AutoUpdateSettings;
  /**
   * The env blocks of Claude Code's user and managed settings files, read on
   * every tick (readClaudeCodeSettingsEnvBlocks). A missing file is left out;
   * one Claude Code runs without is listed in `skipped`. Throws only for a
   * managed settings file Claude Code refuses to start with.
   */
  readClaudeCodeSettingsEnv: () => ClaudeCodeSettingsEnvRead;
  /** Whether the user turned claude-mem off in Claude Code or uninstalled it there (readClaudeCodePluginState). Never throws for a bad file: it reports it. */
  readClaudeCodePluginState: () => ClaudeCodePluginState;
  readState: () => AutoUpdateState;
  writeState: (state: AutoUpdateState) => void;
  resolvePluginRoot: () => PluginRootResolution | null;
  pluginCacheRootDirectory: () => string;
  marketplaceDirectory: () => string;
  /** Resolves for any HTTP answer; rejects on a network error, a timeout or a 2xx body that is not JSON. */
  fetchJson: (url: string, timeoutMs: number) => Promise<FetchJsonResult>;
  /** May throw when a signal cannot be read; the check then treats the worker as busy (observeWorkerQuiet). */
  isWorkerQuiet: () => boolean;
  /** Whether a process with this pid is running (the worker passes process-registry.ts isPidAlive). */
  isProcessAlive: (pid: number) => boolean;
  /**
   * Gate 3, for an attempt whose supervisor vanished while the install does
   * not resolve to its target: where the attempt left the install, read and
   * judged the way the supervisor reads and judges it, with the fix command
   * its rule names (auto-update-apply.ts readInterruptedAttemptInstall).
   * Injected, as the database read is: its readers load the database code and
   * the installer's helpers, which this module stays free of.
   */
  readInterruptedAttemptInstall: (attempt: { targetVersion: string; previousVersion: string }) => Promise<InterruptedAttemptInstall>;
  /** True once the worker has begun shutting down. Read again right before a launch. */
  isWorkerShuttingDown: () => boolean;
  launchSupervisor: (attempt: { targetVersion: string; previousVersion: string }) => Promise<void>;
  /**
   * telemetry.ts captureEvent (consent-gated, never throws), for the outcomes
   * the worker records itself: the supervisor's own events never come for them.
   */
  captureEvent: (event: string, properties: Record<string, unknown>) => void;
  /** One set for the life of the worker process, so some logs appear once per boot, not every tick. */
  oncePerBootLogsWritten: Set<AutoUpdateOncePerBootLogKey>;
}

/**
 * One check. The gates run in the order below; each returns a named decision
 * and logs it.
 */
export async function runAutoUpdateCheck(deps: AutoUpdateCheckDeps): Promise<AutoUpdateDecision> {
  const now = deps.now();

  // Settings first. A settings.json that exists but cannot be read stops the
  // tick here: read as the defaults, it would turn the updater back on for a
  // user who saved CLAUDE_MEM_AUTO_UPDATE=false.
  const settings = runStage('read-settings', () => deps.readSettings());

  // Gate 1 — off switches. Nothing else is read, written or fetched while one is on.
  if (parseAutoUpdateSwitch(settings.CLAUDE_MEM_AUTO_UPDATE) === 'unrecognised') {
    logOncePerBoot(deps, 'unrecognised-CLAUDE_MEM_AUTO_UPDATE', () => logger.warn('AUTO_UPDATE',
      'CLAUDE_MEM_AUTO_UPDATE is neither "true" nor "false"; auto-update stays off (only "true" turns it on)',
      { value: settingText(settings.CLAUDE_MEM_AUTO_UPDATE) }));
  }
  const disabledReason = autoUpdateDisabledReason(settings, deps.env);
  if (disabledReason !== null) return logDecision(deps, { decision: 'disabled', reason: disabledReason });
  // Claude Code reads the `env` block of a settings file "directly from the
  // file, so they take effect no matter how `claude` was launched"
  // (https://code.claude.com/docs/en/env-vars), while the worker's env holds
  // only what the process that started it had. A file Claude Code runs
  // without is skipped, with a warning once per boot; a managed one Claude
  // Code refuses to start with stops the tick, for the same reason as
  // settings.json above (readClaudeCodeSettingsEnvBlocks).
  const claudeCodeSettings = runStage('read-claude-code-settings', () => deps.readClaudeCodeSettingsEnv());
  for (const skipped of claudeCodeSettings.skipped) {
    logOncePerBoot(deps, `skipped-claude-code-settings:${skipped.path}`, () => logger.warn('AUTO_UPDATE',
      `Skipped the Claude Code settings at ${skipped.path}: Claude Code runs without them too, so no switch in them is in force`,
      { path: skipped.path, problem: skipped.problem }));
  }
  const claudeCodeSwitch = claudeCodeSwitchInForce(deps.env, claudeCodeSettings.envBlocks);
  if (claudeCodeSwitch !== null) return logDecision(deps, { decision: 'disabled', reason: claudeCodeSwitch });
  // The user's own choices in Claude Code, which `update` would undo: it turns
  // the plugin back on and registers it again. A file it would stop on keeps
  // the updater off too, so an update never starts that cannot finish.
  const pluginState = runStage('read-claude-code-plugin-state', () => deps.readClaudeCodePluginState());
  const pluginStateReason = claudeCodePluginStateDisabledReason(pluginState);
  if (pluginStateReason !== null) return logDecision(deps, { decision: 'disabled', reason: pluginStateReason });

  // Gate 2 — install shape. A dev checkout or an env-override root is left alone.
  const resolvedPluginRoot = runStage('resolve-plugin-root', () => deps.resolvePluginRoot());
  if (resolvedPluginRoot === null) return logDecision(deps, { decision: 'no-install' });
  if (!isStandardInstallRoot(resolvedPluginRoot.root, deps)) {
    return logDecision(deps, { decision: 'not-a-standard-install', root: resolvedPluginRoot.root });
  }
  // An unknown version is never read as "update needed".
  if (resolvedPluginRoot.version === null || !INSTALLED_VERSION_PATTERN.test(resolvedPluginRoot.version)) {
    return logDecision(deps, {
      decision: 'unknown-installed-version',
      root: resolvedPluginRoot.root,
      installedVersion: resolvedPluginRoot.version,
    });
  }
  const installedVersion = resolvedPluginRoot.version;

  const state = runStage('read-state', () => deps.readState());
  const saveState = (): void => runStage('write-state', () => deps.writeState(state));

  // Gate 3 — one attempt at a time. Within the supervisor deadline an attempt
  // is in flight whatever its pid says: the supervisor records its pid only
  // after it starts, and killing a process alone leaves its children (the
  // installer) running. Past the deadline it stays in flight while its
  // recorded supervisor is alive, up to AUTO_UPDATE_LIVE_SUPERVISOR_CEILING_MS
  // (a laptop that slept through an install). Liveness is the signal-0 probe of
  // isPidAlive (process-registry.ts), which delivers no signal, so a pid that
  // another process took over after a reboot is never disturbed.
  const attempt = state.inFlightAttempt;
  if (attempt !== null) {
    const attemptAgeMs = absoluteMillisecondsBetween(now, attempt.startedAt);
    const ended = whyTheAttemptIsNoLongerInFlight(attempt, attemptAgeMs, deps);
    if (ended === null) {
      return logDecision(deps, {
        decision: 'attempt-in-flight',
        targetVersion: attempt.targetVersion,
        previousVersion: attempt.previousVersion,
        startedAt: attempt.startedAt,
        supervisorPid: attempt.supervisorPid,
      });
    }
    const outcome = ended.kind === 'never-started'
      ? recordNeverStartedSupervisor(state, attempt, installedVersion, now, ended.why)
      : await recordVanishedSupervisor(state, attempt, installedVersion, now, ended.why, deps);
    saveState();
    // After the save: a save that fails leaves the attempt in flight, and the
    // tick that records it sends its event once.
    captureWorkerRecordedOutcome(deps, outcome);
    const endedDetails = {
      targetVersion: attempt.targetVersion,
      previousVersion: attempt.previousVersion,
      startedAt: new Date(attempt.startedAt).toISOString(),
      supervisorPid: attempt.supervisorPid,
      installedVersion,
      why: ended.why,
      outcomeMessage: outcome.message,
    };
    if (outcome.result === 'applied') {
      logger.info('AUTO_UPDATE', 'Auto-update attempt never recorded an outcome, but the install reports its target version; recorded it as applied', endedDetails);
    } else if (outcome.result === 'restore_failed') {
      logger.error('AUTO_UPDATE', `Auto-update attempt never recorded an outcome and left part of its target in place; recorded it as restore_failed (${outcome.failureStage})`, endedDetails);
    } else {
      logger.warn('AUTO_UPDATE', `Auto-update attempt never recorded an outcome; recorded it as failed (${outcome.failureStage})`, endedDetails);
    }
  }

  // Gate 4 — due. While a busy deferral is pending, every tick looks again,
  // but the network is only touched once the worker is quiet or the deferral
  // has seen a full cycle of busy time; the fetch below then confirms the
  // version is still the promoted one, so a pulled-back release is never applied.
  if (state.busyDeferralStartedAt === null) {
    if (state.lastNetworkCheckAt !== null && absoluteMillisecondsBetween(now, state.lastNetworkCheckAt) < AUTO_UPDATE_CHECK_INTERVAL_MS) {
      return logDecision(deps, { decision: 'not-due', lastNetworkCheckAt: state.lastNetworkCheckAt });
    }
  } else {
    // A deferral for a version the install already has is over: the user, or
    // Claude Code's own updater, installed it while the update waited.
    const deferredVersion = state.lastSeenPromotedVersion;
    if (deferredVersion !== null && RELEASE_VERSION_PATTERN.test(deferredVersion)
      && compareVersionsDescending(deferredVersion, installedVersion) >= 0) {
      clearBusyDeferral(state);
      saveState();
      return logDecision(deps, { decision: 'up-to-date', installedVersion, promotedVersion: deferredVersion });
    }
    if (!observeWorkerQuiet(deps)) {
      const busySince = recordBusyObservation(state, now);
      if (state.busyDeferralObservedBusyMs < AUTO_UPDATE_BUSY_DEFERRAL_LIMIT_MS) {
        saveState();
        return logDecision(deps, {
          decision: 'deferred-busy',
          promotedVersion: state.lastSeenPromotedVersion,
          busySince,
          observedBusyMs: state.busyDeferralObservedBusyMs,
        });
      }
    }
  }

  // Gate 5 — the promoted file. Any fetch, success or failure, counts as the check.
  state.lastNetworkCheckAt = now;
  const promoted = await readPromotedRelease(deps, settings);
  if (promoted.kind === 'failed') {
    state.lastCheckError = { at: now, message: promoted.message };
    clearBusyDeferral(state);
    saveState();
    return logDecision(deps, { decision: 'check-failed', stage: 'fetch-promoted-release', message: promoted.message });
  }
  if (promoted.kind === 'unknown-schema') {
    // Also the check's error, so the doctor row can show that this install no
    // longer reads the owner's switch: a later format, a wrong URL, or a
    // proxy's own JSON page.
    state.lastCheckError = { at: now, message: promoted.message };
    clearBusyDeferral(state);
    saveState();
    return logDecision(deps, { decision: 'unknown-schema', schemaVersion: promoted.schemaVersion ?? null });
  }
  state.lastCheckError = null;
  const promotedVersion = promoted.promotedVersion;
  state.lastSeenPromotedVersion = promotedVersion;

  // Gate 6 — forward only.
  if (compareVersionsDescending(promotedVersion, installedVersion) >= 0) {
    clearBusyDeferral(state);
    saveState();
    return logDecision(deps, { decision: 'up-to-date', installedVersion, promotedVersion });
  }
  if (state.versionsThatFailedToApply.includes(promotedVersion)) {
    clearBusyDeferral(state);
    saveState();
    return logDecision(deps, { decision: 'previously-failed', installedVersion, promotedVersion });
  }

  // Gate 7 — fully published: npm's metadata for the version carries the
  // workflow's gitHead and SLSA provenance. 15.8.2 reached npm without either
  // after a failed publish.
  const publication = await readNpmPublication(deps, promotedVersion);
  if (publication.kind === 'failed') {
    state.lastCheckError = { at: now, message: publication.message };
    clearBusyDeferral(state);
    saveState();
    return logDecision(deps, { decision: 'check-failed', stage: 'fetch-npm-metadata', message: publication.message });
  }
  if (publication.kind === 'not-published') {
    clearBusyDeferral(state);
    saveState();
    return logDecision(deps, { decision: 'not-published-by-workflow', promotedVersion, missing: publication.missing });
  }

  // The worker may have begun shutting down while the fetches above were
  // awaited: the timer only reads the flag when a tick starts, and a
  // supervisor launched now would race the shutdown. Nothing below awaits
  // before the launch, so this is the last moment to look. It comes before the
  // quiet read, because shutdown takes components that read away (My Work's
  // routes), and nothing is written: the next boot checks again.
  if (deps.isWorkerShuttingDown()) {
    return logDecision(deps, { decision: 'worker-shutting-down', targetVersion: promotedVersion, previousVersion: installedVersion });
  }

  // Gate 8 — quiet, or busy for a full check cycle. When gate 4 already
  // counted this tick as busy, counting it again adds nothing.
  let applyReason: AutoUpdateApplyReason = 'quiet';
  if (!observeWorkerQuiet(deps)) {
    const busySince = recordBusyObservation(state, now);
    if (state.busyDeferralObservedBusyMs < AUTO_UPDATE_BUSY_DEFERRAL_LIMIT_MS) {
      saveState();
      return logDecision(deps, { decision: 'deferred-busy', promotedVersion, busySince, observedBusyMs: state.busyDeferralObservedBusyMs });
    }
    applyReason = 'busy-for-a-full-check-cycle';
  }

  // Gate 9 — apply.
  clearBusyDeferral(state);
  saveState();
  const decision = logDecision(deps, { decision: 'apply', targetVersion: promotedVersion, previousVersion: installedVersion, applyReason });
  try {
    await deps.launchSupervisor({ targetVersion: promotedVersion, previousVersion: installedVersion });
  } catch (error: unknown) {
    // The supervisor never ran, so the version is not added to
    // versionsThatFailedToApply: the next due check tries it again. A record
    // the launcher may have written is cleared, so gate 3 waits on nothing.
    const message = `The supervisor could not be launched: ${errorMessageOf(error)}`;
    state.inFlightAttempt = null;
    state.lastAttemptOutcome = {
      result: 'failed',
      targetVersion: promotedVersion,
      previousVersion: installedVersion,
      finishedAt: deps.now(),
      failureStage: 'launch-supervisor',
      message,
    };
    // Logged and reported before the save, so a failing save cannot hide why
    // the launch failed. Nothing retries this launch until the next due check,
    // so its event is sent once either way.
    const launchFailed = logDecision(deps, { decision: 'launch-failed', targetVersion: promotedVersion, previousVersion: installedVersion, message });
    captureWorkerRecordedOutcome(deps, state.lastAttemptOutcome);
    saveState();
    return launchFailed;
  }
  return decision;
}

/**
 * Why auto-update is off by claude-mem's settings or by a switch in the
 * worker's own env that FORCE_AUTOUPDATE_PLUGINS leaves in force, or null.
 * Either needs nothing else read. DISABLE_AUTOUPDATER waits for
 * claudeCodeSwitchInForce, which reads it after Claude Code's settings files:
 * FORCE_AUTOUPDATE_PLUGINS set in one of them takes it out of force.
 */
export function autoUpdateDisabledReason(settings: AutoUpdateSettings, env: NodeJS.ProcessEnv): string | null {
  const autoUpdateSwitch = parseAutoUpdateSwitch(settings.CLAUDE_MEM_AUTO_UPDATE);
  if (autoUpdateSwitch === 'off') return 'CLAUDE_MEM_AUTO_UPDATE=false';
  if (autoUpdateSwitch === 'unrecognised') {
    return `CLAUDE_MEM_AUTO_UPDATE=${JSON.stringify(settingText(settings.CLAUDE_MEM_AUTO_UPDATE))} (only "true" turns it on)`;
  }
  const envSwitch = claudeCodeSwitchSetIn((name) => env[name], SWITCHES_FORCED_PLUGIN_AUTO_UPDATES_LEAVE_IN_FORCE);
  if (envSwitch !== null) return `${envSwitch} is set (Claude Code's switch for no background updates)`;
  if (isWorkerAutostartDisabled({ CLAUDE_MEM_WORKER_AUTOSTART: settingText(settings.CLAUDE_MEM_WORKER_AUTOSTART) })) {
    return 'CLAUDE_MEM_WORKER_AUTOSTART=false (an outside process manager would fight the installer\'s restart)';
  }
  if (settingText(settings.CLAUDE_MEM_WORKER_URL) !== '') return 'CLAUDE_MEM_WORKER_URL is set (the worker belongs to another machine)';
  const runtime = settingText(settings.CLAUDE_MEM_RUNTIME).toLowerCase();
  if (runtime !== WORKER_RUNTIME) {
    return `CLAUDE_MEM_RUNTIME=${JSON.stringify(settingText(settings.CLAUDE_MEM_RUNTIME))}, not "${WORKER_RUNTIME}" (an unattended update writes CLAUDE_MEM_RUNTIME=${WORKER_RUNTIME}, which would switch this install's runtime)`;
  }
  return null;
}

/**
 * Why Claude Code's own files keep the updater off, or null. `update` runs
 * install.ts enablePluginInClaudeSettings and registerPlugin, which read those
 * files with readJsonSafe and stop on one that does not parse.
 */
export function claudeCodePluginStateDisabledReason(pluginState: ClaudeCodePluginState): string | null {
  const { userSettings, registration } = pluginState;
  if (userSettings.kind === 'explicitly-disabled') {
    return `claude-mem is turned off in Claude Code (enabledPlugins["${CLAUDE_MEM_PLUGIN_KEY}"] is false in ${userSettings.path}); an update would turn it back on`;
  }
  if (userSettings.kind === 'unreadable') {
    return `${userSettings.problem}, so whether claude-mem is turned off in Claude Code cannot be read, and an update would stop on that file`;
  }
  if (registration.kind === 'not-registered') {
    return `claude-mem is not registered at user scope in ${registration.path} (it was uninstalled from Claude Code, or installed there only for a project); an update would register it again`;
  }
  if (registration.kind === 'unreadable') {
    return `${registration.problem}, so whether claude-mem is still installed cannot be read, and an update would stop on that file`;
  }
  return null;
}

/**
 * The production readClaudeCodePluginState: Claude Code's user settings and
 * installed_plugins.json, each read as the installer reads it.
 *  - User settings (install.ts enablePluginInClaudeSettings, readJsonSafe): a
 *    missing file is not a choice; `false` under enabledPlugins is the user
 *    turning claude-mem off. A file that does not parse as a JSON object
 *    (empty included, which JSON.parse refuses) is unreadable: the installer
 *    stops on it. This differs from the env-block read above, which follows
 *    Claude Code, because here what matters is what the installer would do.
 *  - installed_plugins.json (install.ts registerPlugin): read with
 *    prune-cache.ts readUserScopeRegisteredCacheVersions, which reads it with
 *    readJsonSafe too. registerPlugin writes one user-scope entry with an
 *    installPath for every install of every host, so that entry means
 *    installed and none means Claude Code uninstalled it. Entries of other
 *    scopes (a project's own install, at a version of its own) are not the
 *    npx install's and are not read: an update would replace them with the
 *    user-scope one. A missing file holds no entry.
 */
export function readClaudeCodePluginState(files: { userSettingsPath: string; installedPluginsPath: string }): ClaudeCodePluginState {
  return {
    userSettings: readClaudeCodeUserSettingsToggle(files.userSettingsPath),
    registration: readClaudeCodeRegistration(files.installedPluginsPath),
  };
}

function readClaudeCodeUserSettingsToggle(userSettingsPath: string): ClaudeCodePluginState['userSettings'] {
  let raw: string;
  try {
    raw = readFileSync(userSettingsPath, 'utf-8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'not-disabled' };
    return { kind: 'unreadable', path: userSettingsPath, problem: `${userSettingsPath} exists but cannot be read: ${errorMessageOf(error)}` };
  }
  let parsed: unknown;
  try {
    parsed = parseJsonWithBom(raw);
  } catch (error: unknown) {
    return { kind: 'unreadable', path: userSettingsPath, problem: `${userSettingsPath} is not valid JSON: ${errorMessageOf(error)}` };
  }
  if (!isPlainObject(parsed)) return { kind: 'unreadable', path: userSettingsPath, problem: `${userSettingsPath} does not hold a JSON object` };
  const enabledPlugins = parsed.enabledPlugins;
  return isPlainObject(enabledPlugins) && enabledPlugins[CLAUDE_MEM_PLUGIN_KEY] === false
    ? { kind: 'explicitly-disabled', path: userSettingsPath }
    : { kind: 'not-disabled' };
}

function readClaudeCodeRegistration(installedPluginsPath: string): ClaudeCodePluginState['registration'] {
  let versions: string[];
  try {
    versions = readUserScopeRegisteredCacheVersions(installedPluginsPath);
  } catch (error: unknown) {
    return { kind: 'unreadable', path: installedPluginsPath, problem: errorMessageOf(error) };
  }
  return versions.length > 0 ? { kind: 'registered', versions } : { kind: 'not-registered', path: installedPluginsPath };
}

/**
 * The first of Claude Code's switches in force, as a disabled reason, or
 * null. The worker's env is read first, then the env block of each settings
 * file in order, and a switch on in any of them counts, except
 * DISABLE_AUTOUPDATER while plugin auto-updates are forced
 * (arePluginAutoUpdatesForced, over the same places).
 */
export function claudeCodeSwitchInForce(env: NodeJS.ProcessEnv, settingsFileEnvBlocks: ClaudeCodeSettingsEnvBlock[]): string | null {
  const places: Array<{ valueOf: (name: string) => string | undefined; whereSet: string }> = [
    { valueOf: (name) => env[name], whereSet: '' },
    ...settingsFileEnvBlocks.map((block) => ({
      valueOf: (name: string) => settingsEnvValueText(block.env[name]),
      whereSet: ` in the env block of ${block.path}`,
    })),
  ];
  const switchesInForce = arePluginAutoUpdatesForced(places.map((place) => place.valueOf(FORCE_PLUGIN_AUTO_UPDATES)))
    ? SWITCHES_FORCED_PLUGIN_AUTO_UPDATES_LEAVE_IN_FORCE
    : CLAUDE_CODE_NO_BACKGROUND_UPDATE_SWITCHES;
  for (const place of places) {
    const switchOn = claudeCodeSwitchSetIn(place.valueOf, switchesInForce);
    if (switchOn !== null) return `${switchOn} is set${place.whereSet} (Claude Code's switch for no background updates)`;
  }
  return null;
}

/**
 * Whether FORCE_AUTOUPDATE_PLUGINS forces plugin auto-updates, given its value
 * in each place it is read from (undefined where it is not set). It is the one
 * switch that turns the updater back on, so it is read the strict way round
 * while every other errs toward off: "1" (trimmed; a JSON 1 in a settings file
 * reads as "1") in at least one place, and no other value in any. A managed
 * settings file that sets it to 0 therefore wins over a 1 in the user's own
 * file, as in Claude Code, where "a managed settings entry overrides the same
 * variable in user or project settings" (https://code.claude.com/docs/en/env-vars).
 */
function arePluginAutoUpdatesForced(valueInEachPlace: ReadonlyArray<string | undefined>): boolean {
  const setValues = valueInEachPlace.filter((value): value is string => value !== undefined);
  return setValues.length > 0 && setValues.every((value) => value.trim() === '1');
}

/**
 * CLAUDE_MEM_AUTO_UPDATE read the way CLAUDE_MEM_BACKUP_ENABLED is
 * (DatabaseManager: `=== 'true'`): only "true" is on and anything else is
 * off, so a value meant as off ("0", "off", "no") never leaves the updater
 * running. Trimmed, any case, and read with String(), since a hand-edited
 * settings.json can hold a JSON number. "false" is the documented off; any
 * other value is unrecognised, which the check logs once per boot.
 */
export function parseAutoUpdateSwitch(configuredValue: unknown): 'on' | 'off' | 'unrecognised' {
  const normalized = settingText(configuredValue).toLowerCase();
  if (normalized === 'true') return 'on';
  if (normalized === 'false') return 'off';
  return 'unrecognised';
}

/**
 * The promoted-release URL to fetch: unset or blank means the built-in
 * DEFAULT_PROMOTED_RELEASE_URL, the same rule resolveOpenRouterChatCompletionsUrl
 * (src/shared/openrouter-base-url.ts) applies to CLAUDE_MEM_OPENROUTER_BASE_URL.
 */
export function resolvePromotedReleaseUrl(configuredUrl: unknown): string {
  const trimmed = settingText(configuredUrl);
  return trimmed === '' ? DEFAULT_PROMOTED_RELEASE_URL : trimmed;
}

/**
 * The production readSettings. It reads the check's keys from the parsed
 * settings.json itself, each the way SettingsDefaultsManager.loadFromFile
 * reads it: from the document's settings target (settingsTarget: the root, or
 * the `env` block of a wrapped document), a JSON boolean as its string
 * (coercePersistedSettingValue), the shipped default for a missing key, and an
 * environment variable over both (applyEnvOverrides). Those defaults are
 * getAllDefaults(): loadFromFile's per-path defaults differ only in the port
 * and URL keys.
 *
 * loadFromFile itself is not used: it reads every key, and when it cannot
 * finish one (CLAUDE_MEM_DATA_DIR saved as a number throws at its .trim()) its
 * catch-all returns every default, CLAUDE_MEM_AUTO_UPDATE 'true' included, so
 * an unrelated bad value would turn the updater on for a user who saved
 * 'false'. A settings.json that exists but cannot be read, does not parse or
 * is not a JSON object throws for the same reason (settings-document.ts
 * loadDocument, on whose error the settings writers refuse); a missing file
 * reads as the defaults, and so does an empty one, which holds no saved value
 * to lose (settingsFileIsEmpty). Nothing is written.
 */
export function readAutoUpdateSettings(settingsPath: string, env: NodeJS.ProcessEnv = process.env): AutoUpdateSettings {
  const settingsDocument = loadDocument(settingsPath);
  if (settingsDocument.exists && settingsDocument.document === undefined && !settingsFileIsEmpty(settingsPath)) {
    throw new Error(`${settingsPath} exists but cannot be read as settings: ${errorMessageOf(settingsDocument.error)}`, {
      cause: settingsDocument.error,
    });
  }
  const saved = settingsDocument.document === undefined ? {} : settingsTarget(settingsDocument.document);
  const defaults = SettingsDefaultsManager.getAllDefaults();
  const settings = {} as AutoUpdateSettings;
  for (const key of AUTO_UPDATE_SETTING_KEYS) {
    const fromEnv = env[key];
    // The check reads every value through settingText, so a number or null a
    // hand edit left here is read as text, never thrown on.
    settings[key] = (fromEnv !== undefined
      ? fromEnv
      : saved[key] !== undefined ? coercePersistedSettingValue(saved[key]) : defaults[key]) as string;
  }
  return settings;
}

/**
 * Whether a settings.json that loadDocument could not parse is empty: nothing
 * but whitespace or a byte order mark, which reads as an empty document, the
 * way readClaudeCodeSettingsFileEnv reads an empty Claude Code settings file.
 * The file is read again only on that error path. A file that cannot be read
 * now throws the caller's "exists but cannot be read as settings" error, with
 * this read's cause.
 */
function settingsFileIsEmpty(settingsPath: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(settingsPath, 'utf-8');
  } catch (error: unknown) {
    throw new Error(`${settingsPath} exists but cannot be read as settings: ${errorMessageOf(error)}`, { cause: error });
  }
  return raw.trim() === '';
}

/**
 * Where Claude Code's file-based managed settings live: "the system directory:
 * `/Library/Application Support/ClaudeCode/` on macOS, `/etc/claude-code/` on
 * Linux and WSL, and `C:\Program Files\ClaudeCode\` on Windows"
 * (https://code.claude.com/docs/en/managed-settings, read 2026-11-07). The
 * repo has no helper for it. Other platforms take the Linux path.
 */
export function claudeCodeManagedSettingsDirectory(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode';
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode';
  return '/etc/claude-code';
}

/**
 * The production readClaudeCodeSettingsEnv: the `env` block of Claude Code's
 * user settings file, then of its file-based managed settings, which "merges
 * `managed-settings.json` first, then every `*.json` file in the
 * [managed-settings.d/] directory in alphabetical order ... Claude Code ignores
 * hidden files and files that don't end in `.json`"
 * (https://code.claude.com/docs/en/managed-settings). A switch in any of them
 * turns auto-update off, so the files are read one by one, not merged.
 *
 * A missing file or drop-in directory is left out, and an empty file holds no
 * switch (Claude Code reads an empty managed settings file as `{}`). One that
 * exists but cannot be used is handled the way Claude Code handles it
 * (claudeCodeRunsWithout):
 *  - the user's file: "Claude Code skips a broken user, project, or local file
 *    or its broken values and continues with the rest"
 *    (https://code.claude.com/docs/en/settings), so a broken one is skipped,
 *    and so is one that cannot be read at all;
 *  - managed settings, where Claude Code is stricter
 *    (https://code.claude.com/docs/en/managed-settings): a file "present but
 *    can't be parsed as a JSON object" makes it refuse to start; for one that
 *    "exists but can't be read", "If the operating system denied the read ...
 *    every session starts without that source's policies", and "For any other
 *    read failure ... every session exits at startup"; and a value that fails
 *    validation is dropped. So a read the operating system denied (the drop-in
 *    directory's included) and an env that is not an object are skipped, and
 *    anything else throws: a switch in it could not be seen.
 * Each skipped path is listed in `skipped`, for the check to warn about.
 */
export function readClaudeCodeSettingsEnvBlocks(files: { userSettingsPath: string; managedSettingsDirectory: string }): ClaudeCodeSettingsEnvRead {
  const read: ClaudeCodeSettingsEnvRead = { envBlocks: [], skipped: [] };
  const addFile = (filePath: string, scope: ClaudeCodeSettingsScope): void => {
    try {
      const block = readClaudeCodeSettingsFileEnv(filePath);
      if (block !== null) read.envBlocks.push(block);
    } catch (error: unknown) {
      if (!(error instanceof UnusableClaudeCodeSettingsFile) || !claudeCodeRunsWithout(scope, error.problemKind)) throw error;
      read.skipped.push({ path: filePath, problem: error.message });
    }
  };
  addFile(files.userSettingsPath, 'user');
  addFile(path.join(files.managedSettingsDirectory, 'managed-settings.json'), 'managed');
  const dropInDirectory = path.join(files.managedSettingsDirectory, 'managed-settings.d');
  let dropInNames: string[];
  try {
    dropInNames = readdirSync(dropInDirectory);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return read;
    const problem = `${dropInDirectory} exists but cannot be listed: ${errorMessageOf(error)}`;
    if (!isReadDeniedByTheOperatingSystem(code)) throw new Error(problem, { cause: error });
    read.skipped.push({ path: dropInDirectory, problem });
    return read;
  }
  for (const name of dropInNames.filter((entry) => entry.endsWith('.json') && !entry.startsWith('.')).sort()) {
    addFile(path.join(dropInDirectory, name), 'managed');
  }
  return read;
}

/** Which of Claude Code's settings a file is: the user's own, or managed (the file-based policy). */
type ClaudeCodeSettingsScope = 'user' | 'managed';

/** What is wrong with a Claude Code settings file that exists, in the cases Claude Code's docs tell apart. */
type ClaudeCodeSettingsFileProblemKind = 'read-denied' | 'read-failed' | 'not-a-json-object' | 'env-not-an-object';

/** A Claude Code settings file that exists but cannot be used. Its message names the file and the problem. */
class UnusableClaudeCodeSettingsFile extends Error {
  constructor(readonly problemKind: ClaudeCodeSettingsFileProblemKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'UnusableClaudeCodeSettingsFile';
  }
}

/**
 * Whether Claude Code runs without a settings file of this scope that has this
 * problem, so no switch in it is in force (readClaudeCodeSettingsEnvBlocks
 * quotes the docs for each case).
 */
function claudeCodeRunsWithout(scope: ClaudeCodeSettingsScope, problemKind: ClaudeCodeSettingsFileProblemKind): boolean {
  return scope === 'user' || problemKind === 'read-denied' || problemKind === 'env-not-an-object';
}

/** EACCES and EPERM: the operating system denied the read, "for example on a root-only file". */
function isReadDeniedByTheOperatingSystem(code: string | undefined): boolean {
  return code === 'EACCES' || code === 'EPERM';
}

/**
 * One settings file's env block, or null when the file does not exist.
 * Throws UnusableClaudeCodeSettingsFile for one that exists but cannot be used.
 */
function readClaudeCodeSettingsFileEnv(filePath: string): ClaudeCodeSettingsEnvBlock | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw new UnusableClaudeCodeSettingsFile(isReadDeniedByTheOperatingSystem(code) ? 'read-denied' : 'read-failed',
      `${filePath} exists but cannot be read: ${errorMessageOf(error)}`, { cause: error });
  }
  if (raw.trim() === '') return { path: filePath, env: {} };
  let parsed: unknown;
  try {
    parsed = parseJsonWithBom(raw);
  } catch (error: unknown) {
    throw new UnusableClaudeCodeSettingsFile('not-a-json-object', `${filePath} is not valid JSON: ${errorMessageOf(error)}`, { cause: error });
  }
  if (!isPlainObject(parsed)) throw new UnusableClaudeCodeSettingsFile('not-a-json-object', `${filePath} does not hold a JSON object`);
  const env = parsed.env;
  // A null env sets nothing, as a null policy key does in managed settings.
  if (env === undefined || env === null) return { path: filePath, env: {} };
  if (!isPlainObject(env)) {
    throw new UnusableClaudeCodeSettingsFile('env-not-an-object', `${filePath}: its env is ${Array.isArray(env) ? 'an array' : typeof env}, not an object`);
  }
  return { path: filePath, env };
}

/**
 * The worker activity "quiet" is read from. A signal that cannot be read
 * throws, and the check then counts the worker as busy (observeWorkerQuiet).
 */
export interface WorkerQuietSignals {
  /** SessionManager.hasSessionActivitySince: in-memory sessions only. */
  hasSessionActivitySince: (cutoffMs: number) => boolean;
  /**
   * Epoch ms of this device's newest user prompt or captured tool use in the
   * worker's database (SessionStore.getNewestCapturedActivityEpoch), null when
   * it holds none. Throws while the database is not open: startup has not
   * reached it, or failed before it.
   */
  getNewestCapturedActivityAt: () => number | null;
  getQueueDepth: () => number;
  getInFlightRequestCount: () => number;
  /** Viewer and My Work tabs on their event streams; each one is also an open request. */
  getViewerClientCount: () => number;
  /**
   * The names of the worker's own long-running background jobs that are
   * running now (WorkerService.runningBackgroundJobNames). Throws while a
   * component that runs one is missing: startup has not reached it, or failed
   * before it.
   */
  getRunningBackgroundJobs: () => string[];
}

/**
 * Quiet: no session activity in the quiet window, no user prompt or captured
 * tool use in it either, no queued work, no open request other than the
 * viewer's and My Work's event streams, and none of the worker's own
 * background jobs running.
 *
 * Session activity alone covers about 3 minutes, not the quiet window: a
 * session stays in SessionManager's map only while its observer runs, and is
 * removed once the observer has idled for 3 minutes (GeneratorExitHandler →
 * removeSessionImmediate), and a restarted worker starts with none. So quiet
 * also needs this device's newest prompt or tool use, read from the database,
 * to be at least the quiet window old. One dated in the future (the clock was
 * moved back) is not that old, so it reads as busy until the clock passes it;
 * the busy fallback bounds how long that can defer an update.
 *
 * The server's last-request time is left out. The quiet window is measured
 * from the gaps between a person's prompts, and the last-request time is also
 * refreshed by machine traffic while nobody types (an open viewer polls every
 * 15 to 60 s, its logs panel every 2 s), so an 18-minute window on it would
 * rarely end.
 *
 * The event streams are left out too: each open tab holds one request open
 * for as long as it stays open, so counting them would keep the worker busy
 * forever. Their count is the one the idle-exit monitor gets
 * (worker-service.ts viewerEventStreamClientCount), and the difference never
 * goes below zero: a stream can leave one count before the other. An update
 * then drops those streams, and the tabs reconnect (EventSource).
 *
 * Any other open request (a corpus build, a slow search) counts as busy, so
 * an update that waited for quiet starts with none open; one that arrives
 * while the update installs can still be cut off by its restart. The busy
 * fallback does not wait for quiet: once a deferral has seen a full check
 * cycle of busy time, the update applies even with requests open or jobs
 * running, and its restart can interrupt them.
 */
export function isWorkerQuietBySignals(signals: WorkerQuietSignals, nowMs: number): boolean {
  if (signals.hasSessionActivitySince(nowMs - AUTO_UPDATE_QUIET_WINDOW_MS)) return false;
  const newestCapturedActivityAt = signals.getNewestCapturedActivityAt();
  if (newestCapturedActivityAt !== null && nowMs - newestCapturedActivityAt < AUTO_UPDATE_QUIET_WINDOW_MS) return false;
  if (signals.getQueueDepth() !== 0) return false;
  const openRequestsOtherThanEventStreams = Math.max(0, signals.getInFlightRequestCount() - signals.getViewerClientCount());
  if (openRequestsOtherThanEventStreams !== 0) return false;
  return signals.getRunningBackgroundJobs().length === 0;
}

/** The production fetchJson: global fetch with a deadline. Bun's fetch also reads file:// URLs. */
export async function fetchJsonWithTimeout(url: string, timeoutMs: number): Promise<FetchJsonResult> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
  const text = await response.text();
  if (!response.ok) return { ok: false, status: response.status, body: null };
  return { ok: true, status: response.status, body: JSON.parse(text) as unknown };
}

type PromotedReleaseRead =
  | { kind: 'promoted'; promotedVersion: string }
  | { kind: 'unknown-schema'; schemaVersion: unknown; message: string }
  | { kind: 'failed'; message: string };

async function readPromotedRelease(deps: AutoUpdateCheckDeps, settings: AutoUpdateSettings): Promise<PromotedReleaseRead> {
  const url = resolvePromotedReleaseUrl(settings.CLAUDE_MEM_AUTO_UPDATE_PROMOTED_RELEASE_URL);
  let response: FetchJsonResult;
  try {
    response = await deps.fetchJson(url, AUTO_UPDATE_FETCH_TIMEOUT_MS);
  } catch (error: unknown) {
    return { kind: 'failed', message: `${url}: ${errorMessageOf(error)}` };
  }
  if (!response.ok) return { kind: 'failed', message: `${url}: HTTP ${response.status}` };

  // Any JSON answer whose schemaVersion is not exactly 1 is a format this
  // client does not read: a later one, a wrong URL, or a proxy's own JSON page.
  // It applies nothing.
  const body = response.body;
  const schemaVersion = isPlainObject(body) ? body.schemaVersion : undefined;
  if (schemaVersion !== PROMOTED_RELEASE_SCHEMA_VERSION) {
    const found = !isPlainObject(body)
      ? `the answer is not a JSON object (${describeJsonKind(body)})`
      : schemaVersion === undefined ? 'it has no schemaVersion' : `its schemaVersion is ${JSON.stringify(schemaVersion)}`;
    return {
      kind: 'unknown-schema',
      schemaVersion,
      message: `${url}: ${found}, not the schemaVersion ${PROMOTED_RELEASE_SCHEMA_VERSION} this version reads, so it applies nothing`,
    };
  }

  const promotedVersion = (body as Record<string, unknown>).promotedVersion;
  if (typeof promotedVersion !== 'string' || !RELEASE_VERSION_PATTERN.test(promotedVersion)) {
    return { kind: 'failed', message: `${url}: promotedVersion ${JSON.stringify(promotedVersion)} is not an exact X.Y.Z version` };
  }
  return { kind: 'promoted', promotedVersion };
}

export type NpmPublicationRead =
  | { kind: 'published' }
  | { kind: 'not-published'; missing: string[] }
  | { kind: 'failed'; message: string };

/**
 * Gate 7's reading of npm's metadata for one version: published by the
 * workflow (gitHead and SLSA provenance), not, or unknown because the read
 * failed. The supervisor applies the same test to the previous version before
 * it reinstalls it (auto-update-apply.ts).
 */
export async function readNpmPublication(deps: Pick<AutoUpdateCheckDeps, 'fetchJson'>, version: string): Promise<NpmPublicationRead> {
  const url = npmVersionMetadataUrl(version);
  let response: FetchJsonResult;
  try {
    response = await deps.fetchJson(url, AUTO_UPDATE_FETCH_TIMEOUT_MS);
  } catch (error: unknown) {
    return { kind: 'failed', message: `${url}: ${errorMessageOf(error)}` };
  }
  if (response.status === HTTP_STATUS_NOT_FOUND) return { kind: 'not-published', missing: ['version on npm'] };
  if (!response.ok) return { kind: 'failed', message: `${url}: HTTP ${response.status}` };
  // npm answers a published version with a JSON object. Anything else is a
  // registry fault, not evidence about how the version was published.
  if (!isPlainObject(response.body)) return { kind: 'failed', message: `${url}: not a JSON object` };

  const manifest = response.body;
  const dist = isPlainObject(manifest.dist) ? manifest.dist : {};
  const attestations = isPlainObject(dist.attestations) ? dist.attestations : {};
  const provenance = isPlainObject(attestations.provenance) ? attestations.provenance : {};
  const missing: string[] = [];
  if (manifest.version !== version) missing.push('matching version');
  if (typeof manifest.gitHead !== 'string' || manifest.gitHead.trim() === '') missing.push('gitHead');
  if (provenance.predicateType !== SLSA_PROVENANCE_V1_PREDICATE_TYPE) missing.push('SLSA provenance');
  return missing.length === 0 ? { kind: 'published' } : { kind: 'not-published', missing };
}

/** How an attempt that recorded no outcome ended, as gate 3 reads it. */
type EndedAttempt =
  /** No supervisor ever recorded its pid: nothing ran. */
  | { kind: 'never-started'; why: string }
  /** Its supervisor recorded its pid and is gone, or has been alive past the live-pid ceiling. */
  | { kind: 'vanished'; why: string };

/**
 * How an attempt past its supervisor deadline ended, or null while it is still
 * in flight (see gate 3). The pid is probed only past the deadline.
 */
function whyTheAttemptIsNoLongerInFlight(
  attempt: AutoUpdateInFlightAttempt,
  attemptAgeMs: number,
  deps: Pick<AutoUpdateCheckDeps, 'isProcessAlive'>,
): EndedAttempt | null {
  if (attemptAgeMs <= AUTO_UPDATE_SUPERVISOR_DEADLINE_MS) return null;
  const deadlineMinutes = Math.round(AUTO_UPDATE_SUPERVISOR_DEADLINE_MS / MILLISECONDS_PER_MINUTE);
  if (attempt.supervisorPid === null) {
    return { kind: 'never-started', why: `recorded neither a supervisor pid nor an outcome within the ${deadlineMinutes}-minute supervisor deadline` };
  }
  if (!deps.isProcessAlive(attempt.supervisorPid)) {
    return { kind: 'vanished', why: `recorded no outcome within the ${deadlineMinutes}-minute supervisor deadline, and its supervisor is no longer running` };
  }
  if (attemptAgeMs <= AUTO_UPDATE_LIVE_SUPERVISOR_CEILING_MS) return null;
  const ceilingHours = Math.round(AUTO_UPDATE_LIVE_SUPERVISOR_CEILING_MS / MILLISECONDS_PER_HOUR);
  return { kind: 'vanished', why: `recorded no outcome in ${ceilingHours} hours; a pid still alive that long is treated as another process that reused it` };
}

function describeEndedAttempt(attempt: AutoUpdateInFlightAttempt, installedVersion: string, why: string): string {
  return `The attempt that started at ${new Date(attempt.startedAt).toISOString()} `
    + `(supervisor pid ${attempt.supervisorPid ?? 'not recorded'}) ${why}. The install reports ${installedVersion}.`;
}

/**
 * Close an attempt whose supervisor never claimed it. The supervisor records
 * its pid before it runs anything (auto-update-apply.ts claimInFlightAttempt),
 * so without one nothing was installed: the attempt failed, and the version is
 * not blocked, so the next due check tries it again.
 */
function recordNeverStartedSupervisor(
  state: AutoUpdateState,
  attempt: AutoUpdateInFlightAttempt,
  installedVersion: string,
  now: number,
  why: string,
): AutoUpdateAttemptOutcome {
  state.inFlightAttempt = null;
  state.lastAttemptOutcome = {
    result: 'failed',
    targetVersion: attempt.targetVersion,
    previousVersion: attempt.previousVersion,
    finishedAt: now,
    failureStage: 'supervisor-never-started',
    message: `${describeEndedAttempt(attempt, installedVersion, why)} Its supervisor never started, so nothing was installed; the version is tried again at the next due check.`,
  };
  return state.lastAttemptOutcome;
}

/**
 * Close an attempt whose supervisor vanished without recording an outcome.
 * When the install already reports the target version, the update applied and
 * only its outcome was lost, so it is recorded as applied and the version is
 * not blocked. Otherwise it failed, and the version is never retried; where
 * the attempt left the install is read the supervisor's way
 * (deps.readInterruptedAttemptInstall). A reboot can kill the supervisor and
 * its installer after the target is registered, and then no supervisor
 * repairs it and nothing tells the user: an install left with part of the
 * target in place is recorded as restore_failed, naming the fix command the
 * supervisor's rule names, so the notice and the doctor row show it. Every
 * outcome keeps the stage, so the doctor row and telemetry show how it ended.
 */
async function recordVanishedSupervisor(
  state: AutoUpdateState,
  attempt: AutoUpdateInFlightAttempt,
  installedVersion: string,
  now: number,
  why: string,
  deps: Pick<AutoUpdateCheckDeps, 'readInterruptedAttemptInstall'>,
): Promise<AutoUpdateAttemptOutcome> {
  const whatHappened = describeEndedAttempt(attempt, installedVersion, why);
  const versions = { targetVersion: attempt.targetVersion, previousVersion: attempt.previousVersion };
  if (installedVersion === attempt.targetVersion) {
    state.inFlightAttempt = null;
    state.lastAttemptOutcome = {
      result: 'applied',
      ...versions,
      finishedAt: now,
      failureStage: 'supervisor-vanished',
      message: `${whatHappened} That is the target version, so the update applied.`,
    };
    return state.lastAttemptOutcome;
  }
  const leftAt = await runAsyncStage('read-interrupted-attempt-install', () => deps.readInterruptedAttemptInstall(versions));
  state.inFlightAttempt = null;
  if (leftAt.kind === 'half-switched') {
    state.lastAttemptOutcome = {
      result: 'restore_failed',
      ...versions,
      finishedAt: now,
      failureStage: 'supervisor-vanished',
      message: `${whatHappened} ${leftAt.where} Part of ${attempt.targetVersion} is in place, and nothing restored ${attempt.previousVersion} or proved ${attempt.targetVersion}. Run: ${leftAt.fixCommand}`,
    };
  } else {
    const movedOn = leftAt.kind === 'moved-past-target'
      ? ` ${leftAt.newerVersion} is newer than ${attempt.targetVersion}: another update moved the install on.`
      : '';
    state.lastAttemptOutcome = {
      result: 'failed',
      ...versions,
      finishedAt: now,
      failureStage: 'supervisor-vanished',
      message: `${whatHappened} ${leftAt.where}${movedOn}`,
    };
  }
  if (!state.versionsThatFailedToApply.includes(attempt.targetVersion)) {
    state.versionsThatFailedToApply.push(attempt.targetVersion);
  }
  return state.lastAttemptOutcome;
}

/**
 * The supervisor's own events (auto-update-apply.ts sendOutcomeTelemetry) for
 * an outcome the worker recorded: auto_update_applied or auto_update_failed,
 * with the stage. restore_result is 'unknown' when a supervisor ran and
 * vanished, and 'not-attempted' when none ran (a launch that failed, a
 * supervisor that never started).
 */
function captureWorkerRecordedOutcome(deps: Pick<AutoUpdateCheckDeps, 'captureEvent'>, outcome: AutoUpdateAttemptOutcome): void {
  const versions = { from_version: outcome.previousVersion, to_version: outcome.targetVersion };
  if (outcome.result === 'applied') {
    deps.captureEvent('auto_update_applied', { ...versions, failure_stage: outcome.failureStage });
    return;
  }
  deps.captureEvent('auto_update_failed', {
    ...versions,
    failure_stage: outcome.failureStage,
    restore_result: outcome.failureStage === 'supervisor-vanished' ? 'unknown' : 'not-attempted',
  });
}

/**
 * Count one tick that found the worker busy, and return when the deferral
 * started. The first busy tick starts the deferral. Each later one adds the
 * time since the previous busy tick, at most AUTO_UPDATE_TICK_INTERVAL_MS:
 * a longer gap means the worker or the machine was not running (a laptop
 * asleep over a weekend), which is not observed busy time. The gap is taken
 * in either direction, so a clock moved back adds at most one tick interval
 * and never takes time away. A second count in the same tick adds nothing.
 */
function recordBusyObservation(state: AutoUpdateState, now: number): number {
  if (state.busyDeferralStartedAt === null) {
    state.busyDeferralStartedAt = now;
    state.busyDeferralObservedBusyMs = 0;
  } else if (state.busyDeferralLastBusyObservationAt !== null) {
    state.busyDeferralObservedBusyMs += Math.min(
      absoluteMillisecondsBetween(now, state.busyDeferralLastBusyObservationAt),
      AUTO_UPDATE_TICK_INTERVAL_MS,
    );
  }
  state.busyDeferralLastBusyObservationAt = now;
  return state.busyDeferralStartedAt;
}

function clearBusyDeferral(state: AutoUpdateState): void {
  state.busyDeferralStartedAt = null;
  state.busyDeferralObservedBusyMs = 0;
  state.busyDeferralLastBusyObservationAt = null;
}

/**
 * An observation that fails reads as busy, and the failure is logged with
 * its cause, so a busy tick is never mistaken for a quiet one. A failure that
 * persists (a database that never opens because startup failed, a component
 * startup never mounted) keeps reading as busy, so it defers the update the
 * same way real activity does: once the deferral has seen a full check cycle
 * of busy time, the busy fallback applies the update anyway.
 */
function observeWorkerQuiet(deps: AutoUpdateCheckDeps): boolean {
  try {
    return deps.isWorkerQuiet();
  } catch (error: unknown) {
    logger.warn('AUTO_UPDATE', 'Could not read whether the worker is busy; treating it as busy', {
      cause: errorMessageOf(error),
    }, error instanceof Error ? error : new Error(String(error)));
    return false;
  }
}

function logOncePerBoot(deps: AutoUpdateCheckDeps, key: AutoUpdateOncePerBootLogKey, writeLog: () => void): void {
  if (deps.oncePerBootLogsWritten.has(key)) return;
  deps.oncePerBootLogsWritten.add(key);
  writeLog();
}

/**
 * The stages a broken settings file stops: claude-mem's settings.json, or a
 * managed settings file Claude Code itself refuses to start with. Such a file
 * stays broken until someone fixes it, so every tick fails there the same way.
 */
const STAGES_A_BROKEN_SETTINGS_FILE_STOPS: ReadonlySet<AutoUpdateCheckStage> = new Set(['read-settings', 'read-claude-code-settings']);

/**
 * The worker timer's log line for a tick that could not finish, with its
 * stage. It is an ERROR, which the logger's error sink also sends as an
 * exception event (logger.ts routeErrorToSink), except at a stage a broken
 * settings file stops: there the ERROR is logged once per boot and each later
 * failure at that stage at DEBUG, so a broken file does not send an exception
 * event every hour. The check still stops at that stage on every tick.
 */
export function logFailedAutoUpdateTick(error: unknown, oncePerBootLogsWritten: Set<AutoUpdateOncePerBootLogKey>): void {
  const stage = error instanceof AutoUpdateCheckError ? error.stage : 'unexpected';
  const cause = error instanceof Error ? error : new Error(String(error));
  const message = 'Auto-update check failed; the next tick tries again';
  if (stage !== 'unexpected' && STAGES_A_BROKEN_SETTINGS_FILE_STOPS.has(stage)) {
    const errorLoggedKey: AutoUpdateOncePerBootLogKey = `tick-failed-at-${stage}`;
    if (oncePerBootLogsWritten.has(errorLoggedKey)) {
      logger.debug('AUTO_UPDATE', message, { stage, loggedAtErrorEarlierThisBoot: true }, cause);
      return;
    }
    oncePerBootLogsWritten.add(errorLoggedKey);
  }
  logger.error('AUTO_UPDATE', message, { stage }, cause);
}

function logDecision<D extends AutoUpdateDecision>(deps: AutoUpdateCheckDeps, decision: D): D {
  const { decision: name, ...details } = decision;
  const writeLog = (): void => {
    const message = `Auto-update decision: ${name}`;
    if (name === 'not-due') {
      // 23 of every 24 ticks end here; the state file has the time of the last check.
      logger.debug('AUTO_UPDATE', message, details);
    } else if (name === 'launch-failed') {
      logger.error('AUTO_UPDATE', message, details);
    } else if (name === 'check-failed' || name === 'unknown-installed-version' || name === 'unknown-schema') {
      logger.warn('AUTO_UPDATE', message, details);
    } else {
      logger.info('AUTO_UPDATE', message, details);
    }
  };
  if (DECISIONS_LOGGED_ONCE_PER_BOOT.has(name)) logOncePerBoot(deps, name, writeLog);
  else writeLog();
  return decision;
}

/**
 * Elapsed time between two epoch-ms instants, in either direction: a stamp
 * dated in the future by more than a window (the clock was moved back) counts
 * as outside it, so no stale stamp can hold a gate shut forever.
 */
function absoluteMillisecondsBetween(firstEpochMs: number, secondEpochMs: number): number {
  return Math.abs(firstEpochMs - secondEpochMs);
}

/**
 * A setting's value as trimmed text. SettingsDefaultsManager turns a JSON
 * boolean into text but passes a number or null through as it is, so a raw
 * `.trim()` could throw; null and a missing key read as empty.
 */
function settingText(value: unknown): string {
  return String(value ?? '').trim();
}

/** The first of these Claude Code switches that is on, reading each value through `valueOf`, or null. */
function claudeCodeSwitchSetIn(
  valueOf: (name: string) => string | undefined,
  switches: typeof CLAUDE_CODE_NO_BACKGROUND_UPDATE_SWITCHES,
): string | null {
  for (const { name, isOn } of switches) {
    if (isOn(valueOf(name))) return name;
  }
  return null;
}

/**
 * A settings-file env value as the text an environment variable would hold:
 * a JSON number or boolean as its string, null as unset. Anything else is
 * read as non-empty text, so an unreadable value never leaves a switch off.
 */
function settingsEnvValueText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === 'string' ? value : String(value);
}

/**
 * Same reading claude-mem gives Claude Code's other env flags
 * (observed-billing.ts isTruthyEnv): any value but empty, 0 or false is on.
 */
function isEnvSwitchOn(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== '' && normalized !== '0' && normalized !== 'false';
}

/** The CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC reading: set to anything at all is on; only unset or empty is off. */
function isSetToAnyNonEmptyValue(value: string | undefined): boolean {
  return value !== undefined && value !== '';
}

function isStandardInstallRoot(root: string, deps: Pick<AutoUpdateCheckDeps, 'pluginCacheRootDirectory' | 'marketplaceDirectory'>): boolean {
  return [deps.pluginCacheRootDirectory(), deps.marketplaceDirectory()].some((base) => isPathInside(root, base));
}

function isPathInside(candidate: string, base: string): boolean {
  const relative = path.relative(path.resolve(base), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What kind of JSON value a promoted-file answer holds, for its error message. */
function describeJsonKind(value: unknown): string {
  if (value === null) return 'null';
  return Array.isArray(value) ? 'an array' : `a ${typeof value}`;
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runStage<T>(stage: AutoUpdateCheckStage, run: () => T): T {
  try {
    return run();
  } catch (error: unknown) {
    throw new AutoUpdateCheckError(stage, error);
  }
}

/** runStage for a step that awaits. */
async function runAsyncStage<T>(stage: AutoUpdateCheckStage, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error: unknown) {
    throw new AutoUpdateCheckError(stage, error);
  }
}
