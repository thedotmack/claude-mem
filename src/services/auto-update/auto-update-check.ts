/**
 * The worker's auto-update check: decides whether this install should move to
 * the release the owner promoted (releases/promoted-release.json on main), and
 * whether now is a good moment.
 *
 * Each tick walks the gates in runAutoUpdateCheck in order and returns the
 * first decision that applies, logged under AUTO_UPDATE; gates 1 and 2 run in
 * readAutoUpdateSwitches, which doctor's Auto-update row also calls, so the
 * two give the same reason for auto-update being off. Only `apply` acts,
 * through deps.launchSupervisor. One step runs between gates 3 and 4 whatever
 * the decision: once claude-mem's updater has shown it can work on this
 * machine, it turns off Claude Code's background update of the thedotmack
 * marketplace (settleClaudeCodeBackgroundUpdate). On the tick whose gate 7
 * first shows it, that step runs again before gate 8, so an update launched
 * then never runs beside Claude Code's updater.
 *
 * Own module, with every effect injected, for the same reason as
 * idle-exit-monitor.ts: worker-service.ts drags in a very large dependency
 * graph, so the decision logic lives here and `bun test` exercises it directly.
 * It imports no database code either: the worker injects its database read
 * (WorkerQuietSignals.getNewestCapturedActivityAt).
 */

import { accessSync, constants as fsConstants, readdirSync, readFileSync } from 'fs';
import path from 'path';
import { readUserScopeRegisteredCacheVersions } from '../../npx-cli/utils/prune-cache.js';
import { parseJsonWithBom, writeJsonFileAtomic } from '../../shared/atomic-json.js';
import { SettingsDefaultsManager, coercePersistedSettingValue, type SettingsDefaults } from '../../shared/SettingsDefaultsManager.js';
import { loadDocument, settingsTarget } from '../../shared/settings-document.js';
import { isWorkerAutostartDisabled } from '../../shared/worker-autostart.js';
import { compareVersionsDescending, type PluginRootResolution } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import type { InterruptedAttemptInstall } from './auto-update-apply.js';
import { AUTO_UPDATE_FETCH_TIMEOUT_MS, AUTO_UPDATE_SUPERVISOR_DEADLINE_MS } from './auto-update-deadlines.js';
import {
  AUTO_UPDATE_CHECK_INTERVAL_MS,
  AUTO_UPDATE_LIVE_SUPERVISOR_CEILING_MS,
  interruptedAttemptFix,
  type AutoUpdateAttemptOutcome,
  type AutoUpdateInFlightAttempt,
  type AutoUpdateState,
} from './auto-update-state-file.js';

/**
 * The owner's release switch on main. It lives here, not in the settings
 * defaults: SettingsDefaultsManager writes every default into a new
 * settings.json, and a saved value wins over the code default, so a URL
 * default would be pinned into every install and the switch file could never
 * move. CLAUDE_MEM_AUTO_UPDATE_PROMOTED_RELEASE_URL defaults to '' and empty
 * means this URL, the way CLAUDE_MEM_OPENROUTER_BASE_URL defaults to '' and
 * means DEFAULT_OPENROUTER_API_URL (src/shared/openrouter-base-url.ts). Only
 * settings.json can set it, never the environment (readAutoUpdateSettings).
 */
export const DEFAULT_PROMOTED_RELEASE_URL = 'https://raw.githubusercontent.com/thedotmack/claude-mem/main/releases/promoted-release.json';

// AUTO_UPDATE_CHECK_INTERVAL_MS (one network check a day) and
// AUTO_UPDATE_LIVE_SUPERVISOR_CEILING_MS (how long a live supervisor pid keeps
// an attempt in flight past its deadline) have their reasons next to their
// definitions in auto-update-state-file.ts, where the SessionStart launcher
// can read the ceiling without this module.
export { AUTO_UPDATE_CHECK_INTERVAL_MS, AUTO_UPDATE_LIVE_SUPERVISOR_CEILING_MS };

/**
 * A machine that is never quiet still updates: once a deferral has seen one
 * check cycle of busy time, the update applies anyway. The time is observed,
 * not read off the wall clock (recordBusyObservation), so a laptop asleep over
 * a weekend does not count as two days of busy time.
 */
export const AUTO_UPDATE_BUSY_DEFERRAL_LIMIT_MS = AUTO_UPDATE_CHECK_INTERVAL_MS;

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
 * claude-mem's marketplace key in Claude Code's known_marketplaces.json and
 * under extraKnownMarketplaces in its settings files: the name in
 * .claude-plugin/marketplace.json, the key install.ts registerMarketplace
 * writes and uninstall.ts removeFromKnownMarketplaces removes.
 */
const CLAUDE_MEM_MARKETPLACE_KEY = 'thedotmack';

/**
 * The source install.ts registerMarketplace writes into claude-mem's entry in
 * known_marketplaces.json, the form `claude plugin marketplace add
 * thedotmack/claude-mem` records too. Exported so tests pin it against what
 * registerMarketplace writes.
 */
export const CLAUDE_MEM_MARKETPLACE_SOURCE: Readonly<{ source: string; repo: string }> = Object.freeze({
  source: 'github',
  repo: 'thedotmack/claude-mem',
});

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
 * FORCE_AUTOUPDATE_PLUGINS takes all three out of force (FORCE_PLUGIN_AUTO_UPDATES).
 */
const CLAUDE_CODE_NO_BACKGROUND_UPDATE_SWITCHES: ReadonlyArray<{
  name: string;
  isOn: (value: string | undefined) => boolean;
}> = [
  { name: 'DISABLE_AUTOUPDATER', isOn: isEnvSwitchOn },
  { name: 'DISABLE_UPDATES', isOn: isEnvSwitchOn },
  { name: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', isOn: isSetToAnyNonEmptyValue },
];

/**
 * Claude Code's switch that brings plugin auto-updates back. Its two pages
 * differ:
 *  - https://code.claude.com/docs/en/env-vars (read 2026-11-08):
 *    "`FORCE_AUTOUPDATE_PLUGINS` | Set to `1` to force plugin auto-updates
 *    even when the main auto-updater is disabled via `DISABLE_AUTOUPDATER`";
 *  - https://code.claude.com/docs/en/plugins/loading, "Which marketplaces and
 *    plugins auto-update" (read 2026-11-08): "If you set `DISABLE_UPDATES=1`,
 *    `DISABLE_AUTOUPDATER=1`, or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`,
 *    the whole pass is off and the **Enable auto-update** toggle is hidden,
 *    unless you also set `FORCE_AUTOUPDATE_PLUGINS=1`."
 * The plugins page is the one about the pass that updates plugins, and
 * claude-mem's updater updates a plugin, so it is followed: while
 * FORCE_AUTOUPDATE_PLUGINS is 1, none of the three switches turns the updater
 * off. It is read from the same places as the switches: the worker's env (it
 * has no CLAUDE_CODE_ prefix, so sanitizeEnv passes it) and the env blocks of
 * Claude Code's settings files (arePluginAutoUpdatesForced).
 */
const FORCE_PLUGIN_AUTO_UPDATES = 'FORCE_AUTOUPDATE_PLUGINS';

/**
 * The registry gate 7 reads npm's metadata from, and the only one the
 * supervisor's installer runs may install from (auto-update-launch.ts
 * autoUpdateInstallerEnv): the artifact installed must come from the registry
 * whose metadata the check verified. Written the way npm writes its own
 * default registry, with the final slash.
 */
export const NPM_PUBLIC_REGISTRY_URL = 'https://registry.npmjs.org/';

/** npm's metadata document for one published version of claude-mem. */
export function npmVersionMetadataUrl(version: string): string {
  return `${NPM_PUBLIC_REGISTRY_URL}claude-mem/${encodeURIComponent(version)}`;
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
  /** The launch started no process, so its attempt was cleared and the version is tried again at the next due check. */
  | { decision: 'launch-failed'; targetVersion: string; previousVersion: string; message: string }
  /** The launch started a process but could not confirm the supervisor started. Only logged: the tick writes nothing, and its attempt stays in flight for gate 3 (gate 9). */
  | { decision: 'launch-unconfirmed'; targetVersion: string; previousVersion: string; message: string };

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
 * Where turning off Claude Code's background update stopped
 * (settleClaudeCodeBackgroundUpdate). It is logged with its stage and the
 * tick goes on: claude-mem's own update never waits on Claude Code's file.
 */
export type ClaudeCodeBackgroundUpdateStage = 'write-claude-code-known-marketplaces';

/**
 * Why Claude Code's background update of the thedotmack marketplace is left
 * on before anything is written (settleClaudeCodeBackgroundUpdate): no check
 * has yet shown that claude-mem's updater reaches the promoted file and npm
 * from this machine, or npx is not on the worker's PATH.
 */
export type ClaudeCodeBackgroundUpdateLeftOnWhy = 'updater-not-yet-proven' | 'npx-not-found';

/**
 * What is logged at most once per boot: the decisions above, the warning for
 * an unrecognised CLAUDE_MEM_AUTO_UPDATE value, the warning for each Claude
 * Code settings path skipped (keyed by its path), the ERROR of a tick that
 * a broken settings file stops (logFailedAutoUpdateTick), the warning for
 * each stage where turning off Claude Code's background update stopped
 * (logClaudeCodeBackgroundUpdateStepFailure), why it is left on, and the
 * warning for an off decision the state file could not take
 * (recordOffDecision).
 */
export type AutoUpdateOncePerBootLogKey =
  | AutoUpdateDecisionName
  | 'unrecognised-CLAUDE_MEM_AUTO_UPDATE'
  | 'record-off-decision-failed'
  | `skipped-claude-code-settings:${string}`
  | `tick-failed-at-${AutoUpdateCheckStage}`
  | `claude-code-background-update-failed-at-${ClaudeCodeBackgroundUpdateStage}`
  | `claude-code-background-update-left-on:${ClaudeCodeBackgroundUpdateLeftOnWhy}`;

/** A tick that could not finish. The worker's timer logs it with its stage (logFailedAutoUpdateTick). */
export class AutoUpdateCheckError extends Error {
  constructor(readonly stage: AutoUpdateCheckStage, cause: unknown) {
    super(`auto-update check failed at ${stage}: ${errorMessageOf(cause)}`, { cause });
    this.name = 'AutoUpdateCheckError';
  }
}

/**
 * A launch of an auto-update process that failed (auto-update-launch.ts
 * startDetachedAutoUpdateProcess, launchAutoUpdateSupervisor), saying whether
 * a process of it was started. `processStarted` is false only when none was:
 * the spawn failed before a process existed, so nothing can claim the attempt
 * in flight, and gate 9 clears it. True when one was, or may have been: a
 * hop that outlived its budget (killed, or still running after a kill that
 * failed), one that exited with anything but 0, or a start that failed in a
 * way that does not show nothing ran. Its supervisor may then be running and
 * claiming the attempt, so gate 9 writes nothing and leaves it for gate 3.
 */
export class AutoUpdateLaunchError extends Error {
  constructor(message: string, readonly processStarted: boolean, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AutoUpdateLaunchError';
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

/**
 * claude-mem's marketplace as one of Claude Code's settings files declares it
 * under extraKnownMarketplaces, which `claude plugin marketplace add` writes
 * and the /plugin Enable auto-update toggle updates. Read, never written: the
 * entry belongs to the user or their admin.
 */
export interface ClaudeMemMarketplaceDeclaration {
  /** The settings file that declares it, named in the disabled reason. */
  path: string;
  /** Its autoUpdate when that is a JSON boolean, the type Claude Code reads; undefined when it is not set. */
  autoUpdate: boolean | undefined;
}

/** What readClaudeCodeSettingsEnvBlocks found. */
export interface ClaudeCodeSettingsEnvRead {
  /** The env block of each settings file it read, in the order Claude Code merges them. */
  envBlocks: ClaudeCodeSettingsEnvBlock[];
  /**
   * Settings files, or the managed drop-in directory, that exist but that
   * Claude Code runs without, and env blocks it drops, so no switch in them is
   * in force. The check warns about each once per boot. `problem` names the
   * path and what is wrong.
   */
  skipped: Array<{ path: string; problem: string }>;
  /**
   * extraKnownMarketplaces.thedotmack in each settings file read that declares
   * it, in the same order, so the last one is the declaration in force
   * (claudeMemMarketplaceDeclarationInForce).
   */
  claudeMemMarketplaceDeclarations: ClaudeMemMarketplaceDeclaration[];
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
  /**
   * Claude Code's known_marketplaces.json, which install.ts registerMarketplace
   * reads with readJsonSafe and rewrites on every install and update. Read,
   * the whole document is kept as parsed (null when there is no file), so the
   * turn-off writes back exactly what was read (settleClaudeCodeBackgroundUpdate).
   */
  knownMarketplaces:
    | { kind: 'read'; path: string; document: Record<string, unknown> | null }
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
   * The env blocks of Claude Code's user and managed settings files, and the
   * thedotmack entry each declares under extraKnownMarketplaces, read on every
   * tick (readClaudeCodeSettingsEnvBlocks). A missing file is left out; one
   * Claude Code runs without is listed in `skipped`. Throws only for a managed
   * settings file Claude Code refuses to start with.
   */
  readClaudeCodeSettingsEnv: () => ClaudeCodeSettingsEnvRead;
  /**
   * Whether the user turned claude-mem off in Claude Code or uninstalled it
   * there, and its known_marketplaces.json (readClaudeCodePluginState; the
   * worker passes the paths under CLAUDE_CONFIG_DIR). Never throws for a bad
   * file: it reports it.
   */
  readClaudeCodePluginState: () => ClaudeCodePluginState;
  /**
   * Writes the known_marketplaces.json document back atomically, unless the
   * file is not writable (writeClaudeCodeKnownMarketplacesUnlessReadOnly).
   * Throws when it does not write.
   */
  writeClaudeCodeKnownMarketplaces: (knownMarketplaces: Record<string, unknown>) => void;
  /**
   * Where the supervisor's installer run would find npx on the worker's PATH,
   * or null when it would find none (auto-update-launch.ts
   * findNpxForTheInstaller).
   */
  findNpxOnWorkerPath: () => string | null;
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
   * judged the way the supervisor reads and judges it
   * (auto-update-apply.ts readInterruptedAttemptInstall). Injected, as the
   * database read is: its readers load the installer's helpers, which this
   * module stays free of.
   */
  readInterruptedAttemptInstall: (attempt: { targetVersion: string; previousVersion: string }) => Promise<InterruptedAttemptInstall>;
  /** True once the worker has begun shutting down. Read again right before a launch. */
  isWorkerShuttingDown: () => boolean;
  /**
   * Records the attempt in flight, then starts the supervisor
   * (auto-update-launch.ts launchAutoUpdateSupervisor). Every failure from the
   * start of its first process on is an AutoUpdateLaunchError, which says
   * whether a process was started; any other throw came before that, when no
   * process existed.
   */
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
 * and logs it. The decision is also recorded in the state file
 * (AutoUpdateState.lastDecision), for doctor, on every tick with no attempt in
 * flight: while one is in flight its supervisor writes the file, and a save
 * here could undo its claim. Three decisions are not recorded:
 * attempt-in-flight and launch-unconfirmed for that reason (gate 9 ends with
 * the attempt it launched in flight), and worker-shutting-down, which saves
 * nothing so the next boot checks again.
 */
export async function runAutoUpdateCheck(deps: AutoUpdateCheckDeps): Promise<AutoUpdateDecision> {
  const now = deps.now();

  // Gates 1 and 2, the same reading doctor's row makes. What they read is
  // logged here as they read it: an unrecognised CLAUDE_MEM_AUTO_UPDATE, and
  // each Claude Code settings file skipped, once per boot.
  const switches = readAutoUpdateSwitches(deps, {
    settingsRead: (settings) => {
      if (parseAutoUpdateSwitch(settings.CLAUDE_MEM_AUTO_UPDATE) !== 'unrecognised') return;
      logOncePerBoot(deps, 'unrecognised-CLAUDE_MEM_AUTO_UPDATE', () => logger.warn('AUTO_UPDATE',
        'CLAUDE_MEM_AUTO_UPDATE is neither "true" nor "false"; auto-update stays off (only "true" turns it on)',
        { value: settingText(settings.CLAUDE_MEM_AUTO_UPDATE) }));
    },
    claudeCodeSettingsRead: (claudeCodeSettings) => {
      for (const skipped of claudeCodeSettings.skipped) {
        logOncePerBoot(deps, `skipped-claude-code-settings:${skipped.path}`, () => logger.warn('AUTO_UPDATE',
          `Skipped the Claude Code settings at ${skipped.path}: Claude Code runs without them too, so no switch in them is in force`,
          { path: skipped.path, problem: skipped.problem }));
      }
    },
  });
  if (switches.kind === 'off') {
    recordOffDecision(deps, switches.decision, now);
    return logDecision(deps, switches.decision);
  }
  const { settings, pluginState, claudeMemMarketplaceDeclaration, installedVersion } = switches;

  const state = runStage('read-state', () => deps.readState());
  const saveState = (): void => runStage('write-state', () => deps.writeState(state));
  // A decision past gate 3: recorded for doctor, saved with the rest of this
  // tick's state, then logged.
  const decide = <D extends AutoUpdateDecision>(decision: D): D => {
    recordDecision(state, decision, now);
    saveState();
    return logDecision(deps, decision);
  };

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

  // Claude Code's background update of the thedotmack marketplace goes off
  // here, once claude-mem's updater has shown it can work on this machine.
  // Past every gate that turns auto-update off, so a user who turned
  // claude-mem's updater off keeps Claude Code's setting as it is. Past gate
  // 3, because while an attempt is in flight its supervisor writes the state
  // file, and a save here could undo its claim. Before the due gate, so it
  // runs on every tick, and a value Claude Code writes back is turned off
  // again on the next one. Before any network read, so the document gate 1
  // read is written back with nothing awaited since but gate 3's local read
  // of an interrupted attempt's install.
  const backgroundUpdate = settleClaudeCodeBackgroundUpdate(deps, state, now, {
    path: pluginState.knownMarketplaces.path,
    document: pluginState.knownMarketplaces.kind === 'read' ? pluginState.knownMarketplaces.document : null,
  }, claudeMemMarketplaceDeclaration);
  if (backgroundUpdate.stateChanged) saveState();

  // Gate 4 — due. While a busy deferral is pending, every tick looks again,
  // but the network is only touched once the worker is quiet or the deferral
  // has seen a full cycle of busy time; the fetch below then confirms the
  // version is still the promoted one, so a pulled-back release is never applied.
  if (state.busyDeferralStartedAt === null) {
    if (state.lastNetworkCheckAt !== null && absoluteMillisecondsBetween(now, state.lastNetworkCheckAt) < AUTO_UPDATE_CHECK_INTERVAL_MS) {
      return decide({ decision: 'not-due', lastNetworkCheckAt: state.lastNetworkCheckAt });
    }
  } else {
    // A deferral for a version the install already has is over: the user, or
    // Claude Code's own updater, installed it while the update waited.
    const deferredVersion = state.lastSeenPromotedVersion;
    if (deferredVersion !== null && RELEASE_VERSION_PATTERN.test(deferredVersion)
      && compareVersionsDescending(deferredVersion, installedVersion) >= 0) {
      clearBusyDeferral(state);
      return decide({ decision: 'up-to-date', installedVersion, promotedVersion: deferredVersion });
    }
    if (!observeWorkerQuiet(deps)) {
      const busySince = recordBusyObservation(state, now);
      if (state.busyDeferralObservedBusyMs < AUTO_UPDATE_BUSY_DEFERRAL_LIMIT_MS) {
        return decide({
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
    return decide({ decision: 'check-failed', stage: 'fetch-promoted-release', message: promoted.message });
  }
  if (promoted.kind === 'unknown-schema') {
    // Also the check's error, so the doctor row can show that this install no
    // longer reads the owner's switch: a later format, a wrong URL, or a
    // proxy's own JSON page.
    state.lastCheckError = { at: now, message: promoted.message };
    clearBusyDeferral(state);
    return decide({ decision: 'unknown-schema', schemaVersion: promoted.schemaVersion ?? null });
  }
  state.lastCheckError = null;
  const promotedVersion = promoted.promotedVersion;
  state.lastSeenPromotedVersion = promotedVersion;

  // Gate 6 — forward only. An install that is up to date never reaches gate
  // 7, so while the turn-off waits for proof, npm's metadata for the promoted
  // version is read here instead, once per check.
  if (compareVersionsDescending(promotedVersion, installedVersion) >= 0) {
    clearBusyDeferral(state);
    if (backgroundUpdate.waitingForUpdaterProof) await readNpmMetadataForTheTurnOff(deps, state, promotedVersion, now);
    return decide({ decision: 'up-to-date', installedVersion, promotedVersion });
  }
  if (state.versionsThatFailedToApply.includes(promotedVersion)) {
    clearBusyDeferral(state);
    return decide({ decision: 'previously-failed', installedVersion, promotedVersion });
  }

  // Gate 7 — fully published: npm's metadata for the version carries the
  // workflow's gitHead and SLSA provenance. 15.8.2 reached npm without either
  // after a failed publish.
  const publication = await readNpmPublication(deps, promotedVersion);
  if (publication.kind === 'failed') {
    state.lastCheckError = { at: now, message: publication.message };
    clearBusyDeferral(state);
    return decide({ decision: 'check-failed', stage: 'fetch-npm-metadata', message: publication.message });
  }
  if (publication.kind === 'not-published') {
    clearBusyDeferral(state);
    return decide({ decision: 'not-published-by-workflow', promotedVersion, missing: publication.missing });
  }
  // This check read both the promoted file and npm's metadata for the
  // promoted version: the proof the turn-off waits for. Saved with the rest
  // of this tick's state below; a worker shutting down saves nothing, and the
  // next boot's check reads both again.
  state.promotedFileAndNpmMetadataReadAt = now;

  // The worker may have begun shutting down while the fetches above were
  // awaited: the timer only reads the flag when a tick starts, and a
  // supervisor launched now would race the shutdown. Nothing below awaits
  // before the launch, so this is the last moment to look. It comes before the
  // quiet read, because shutdown takes components that read away (My Work's
  // routes), and nothing is written: the next boot checks again.
  if (deps.isWorkerShuttingDown()) {
    return logDecision(deps, { decision: 'worker-shutting-down', targetVersion: promotedVersion, previousVersion: installedVersion });
  }

  // The turn-off before gate 4 waited for the proof this tick just recorded.
  // Left for the next tick, it would come only after the update: the attempt
  // launched below keeps every later tick at gate 3 until it ends, so the
  // first update on an install whose entry still has autoUpdate true (every
  // new install's, and every one registered before Phase 4) would run beside
  // Claude Code's own updater. So it runs again here, before gate 8, by the same rules (npx on
  // the worker's PATH, a file that is writable, no extraKnownMarketplaces
  // declaration that sets Claude Code's own setting). known_marketplaces.json
  // is read again for it: gates 5 and 7 awaited the network since gate 1 read
  // it, and the document written back must be one read with nothing awaited
  // since. Gate 1's rules for Claude Code's plugin state
  // (claudeCodePluginStateDisabledReason) apply to this read too: a user who,
  // while the network was read, turned claude-mem off in Claude Code,
  // uninstalled it there, or replaced claude-mem's marketplace entry with one
  // added another way (a fork, a #ref, a git URL, a local folder) gets the
  // decision gate 1 gives that state. Nothing is written then, and no update
  // launches, since the update would undo that change. Saved with this tick's
  // decision below.
  if (backgroundUpdate.waitingForUpdaterProof) {
    const pluginStateNow = runStage('read-claude-code-plugin-state', () => deps.readClaudeCodePluginState());
    const pluginStateReasonNow = claudeCodePluginStateDisabledReason(pluginStateNow, deps.marketplaceDirectory());
    if (pluginStateReasonNow !== null) return decide({ decision: 'disabled', reason: pluginStateReasonNow });
    const { knownMarketplaces } = pluginStateNow;
    settleClaudeCodeBackgroundUpdate(deps, state, now, {
      path: knownMarketplaces.path,
      document: knownMarketplaces.kind === 'read' ? knownMarketplaces.document : null,
    }, claudeMemMarketplaceDeclaration);
  }

  // Gate 8 — quiet, or busy for a full check cycle. When gate 4 already
  // counted this tick as busy, counting it again adds nothing.
  let applyReason: AutoUpdateApplyReason = 'quiet';
  if (!observeWorkerQuiet(deps)) {
    const busySince = recordBusyObservation(state, now);
    if (state.busyDeferralObservedBusyMs < AUTO_UPDATE_BUSY_DEFERRAL_LIMIT_MS) {
      return decide({ decision: 'deferred-busy', promotedVersion, busySince, observedBusyMs: state.busyDeferralObservedBusyMs });
    }
    applyReason = 'busy-for-a-full-check-cycle';
  }

  // Gate 9 — apply. Recorded and saved before the launch, which reads the
  // state again to write the attempt in flight.
  clearBusyDeferral(state);
  const decision = decide({ decision: 'apply', targetVersion: promotedVersion, previousVersion: installedVersion, applyReason });
  try {
    await deps.launchSupervisor({ targetVersion: promotedVersion, previousVersion: installedVersion });
  } catch (error: unknown) {
    // A process of the launch was started, or may have been, but it could not
    // confirm that the supervisor started: the hop outlived its budget and was
    // killed, or is still running after a kill that failed, or it ended with
    // anything but 0. Its supervisor may be running, and may be claiming the
    // attempt the launcher recorded at this very moment, with its own read and
    // write of the same state file. So nothing is written here, not even onto
    // the file read again: no lock orders the two, so a save could drop the
    // claim's supervisorPid and supervisorPhase, and gate 3 would then take a
    // live supervisor for one that never started. The failure is logged at
    // ERROR, and the attempt stays as the launcher and its supervisor leave
    // it. A later tick's gate 3 resolves it as it resolves any attempt: in
    // flight, then never started (not blocked) when no supervisor recorded
    // its pid by the deadline, or vanished; or the supervisor records its own
    // outcome. No outcome is recorded and no event sent here: the attempt has
    // not ended, and whatever records how it ended sends one. Until then
    // doctor shows the apply decision saved before the launch, and the
    // attempt in flight.
    if (error instanceof AutoUpdateLaunchError && error.processStarted) {
      return logDecision(deps, { decision: 'launch-unconfirmed', targetVersion: promotedVersion, previousVersion: installedVersion, message: errorMessageOf(error) });
    }
    // No process was started, so the supervisor never ran, and the version is
    // not added to versionsThatFailedToApply: the next due check tries it
    // again. The record the launcher may have written is cleared, so gate 3
    // waits on nothing.
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
    const launchFailedDecision: AutoUpdateDecision = { decision: 'launch-failed', targetVersion: promotedVersion, previousVersion: installedVersion, message };
    recordDecision(state, launchFailedDecision, now);
    const launchFailed = logDecision(deps, launchFailedDecision);
    captureWorkerRecordedOutcome(deps, state.lastAttemptOutcome);
    saveState();
    return launchFailed;
  }
  return decision;
}

/** What gates 1 and 2 read. The check's deps carry these, and doctor's row passes the same production readers. */
export type AutoUpdateSwitchReaders = Pick<AutoUpdateCheckDeps,
  | 'env'
  | 'readSettings'
  | 'readClaudeCodeSettingsEnv'
  | 'readClaudeCodePluginState'
  | 'resolvePluginRoot'
  | 'pluginCacheRootDirectory'
  | 'marketplaceDirectory'>;

/** A decision gates 1 and 2 end a tick with: auto-update is off, or there is no install it may update. */
export type AutoUpdateOffDecision = Extract<AutoUpdateDecision, { decision: 'disabled' | 'no-install' | 'not-a-standard-install' | 'unknown-installed-version' }>;

/** Gates 1 and 2 as readAutoUpdateSwitches read them: the first decision that keeps auto-update off, or what the later gates need. */
export type AutoUpdateSwitchesRead =
  | { kind: 'off'; decision: AutoUpdateOffDecision }
  | {
      kind: 'on';
      settings: AutoUpdateSettings;
      /** The extraKnownMarketplaces declaration of the thedotmack marketplace in force, read and never written. */
      claudeMemMarketplaceDeclaration: ClaudeMemMarketplaceDeclaration | null;
      pluginState: ClaudeCodePluginState;
      installedVersion: string;
    };

/** Told what gates 1 and 2 read, the moment each is read, so the check logs it in its place; doctor passes none. */
export interface AutoUpdateSwitchObserver {
  settingsRead?: (settings: AutoUpdateSettings) => void;
  claudeCodeSettingsRead?: (claudeCodeSettings: ClaudeCodeSettingsEnvRead) => void;
}

/**
 * Gates 1 and 2: whether auto-update is off, and why, read in the order the
 * check reads it. The worker's tick (runAutoUpdateCheck) and doctor's row
 * (doctor.ts autoUpdateCheck) both call this, so for the same settings, files
 * and environment they give the same reason. Reads only local files, writes
 * nothing and logs nothing; a read that fails throws AutoUpdateCheckError
 * with its stage.
 */
export function readAutoUpdateSwitches(readers: AutoUpdateSwitchReaders, observer: AutoUpdateSwitchObserver = {}): AutoUpdateSwitchesRead {
  const off = (decision: AutoUpdateOffDecision): AutoUpdateSwitchesRead => ({ kind: 'off', decision });

  // Gate 1 — off switches, the settings first. Nothing else is read, written
  // or fetched while one is on, but the decision itself (recordOffDecision).
  const settingsSwitches = readAutoUpdateSettingsSwitches(readers, observer);
  if (settingsSwitches.kind === 'off') return off({ decision: 'disabled', reason: settingsSwitches.reason });
  const { settings, claudeMemMarketplaceDeclaration } = settingsSwitches;
  // The user's own choices in Claude Code, which `update` would undo: it turns
  // the plugin back on, registers it again, and rewrites claude-mem's
  // marketplace entry. A file it would stop on keeps the updater off too, so
  // an update never starts that cannot finish.
  const pluginState = runStage('read-claude-code-plugin-state', () => readers.readClaudeCodePluginState());
  const pluginStateReason = claudeCodePluginStateDisabledReason(pluginState, readers.marketplaceDirectory());
  if (pluginStateReason !== null) return off({ decision: 'disabled', reason: pluginStateReason });

  // Gate 2 — install shape. A dev checkout or an env-override root is left alone.
  const resolvedPluginRoot = runStage('resolve-plugin-root', () => readers.resolvePluginRoot());
  if (resolvedPluginRoot === null) return off({ decision: 'no-install' });
  if (!isStandardInstallRoot(resolvedPluginRoot.root, readers)) {
    return off({ decision: 'not-a-standard-install', root: resolvedPluginRoot.root });
  }
  // An unknown version is never read as "update needed".
  if (resolvedPluginRoot.version === null || !INSTALLED_VERSION_PATTERN.test(resolvedPluginRoot.version)) {
    return off({
      decision: 'unknown-installed-version',
      root: resolvedPluginRoot.root,
      installedVersion: resolvedPluginRoot.version,
    });
  }
  return { kind: 'on', settings, claudeMemMarketplaceDeclaration, pluginState, installedVersion: resolvedPluginRoot.version };
}

/** What gate 1's switches in settings and the environment read, before Claude Code's plugin records. */
export type AutoUpdateSettingsSwitchesRead =
  | { kind: 'off'; reason: string }
  | {
      kind: 'on';
      settings: AutoUpdateSettings;
      /** The extraKnownMarketplaces declaration of the thedotmack marketplace in force, read and never written. */
      claudeMemMarketplaceDeclaration: ClaudeMemMarketplaceDeclaration | null;
    };

/**
 * Gate 1's switches in settings and the environment, in the order the check
 * reads them: claude-mem's own settings (autoUpdateDisabledReason), Claude
 * Code's "no background updates" switches (claudeCodeSwitchInForce), and an
 * extraKnownMarketplaces declaration that turns Claude Code's own update of
 * claude-mem's marketplace on. readAutoUpdateSwitches runs it first, before
 * Claude Code's plugin records. Reads only local files, writes nothing and
 * logs nothing; a read that fails throws AutoUpdateCheckError with its stage.
 */
export function readAutoUpdateSettingsSwitches(
  readers: Pick<AutoUpdateSwitchReaders, 'env' | 'readSettings' | 'readClaudeCodeSettingsEnv'>,
  observer: AutoUpdateSwitchObserver = {},
): AutoUpdateSettingsSwitchesRead {
  // Settings first. A settings.json that exists but cannot be read stops the
  // tick here: read as the defaults, it would turn the updater back on for a
  // user who saved CLAUDE_MEM_AUTO_UPDATE=false.
  const settings = runStage('read-settings', () => readers.readSettings());
  observer.settingsRead?.(settings);
  const disabledReason = autoUpdateDisabledReason(settings);
  if (disabledReason !== null) return { kind: 'off', reason: disabledReason };
  // Claude Code reads the `env` block of a settings file "directly from the
  // file, so they take effect no matter how `claude` was launched"
  // (https://code.claude.com/docs/en/env-vars), while the worker's env holds
  // only what the process that started it had. Each of Claude Code's switches
  // waits for these files, even one set in the worker's env: a
  // FORCE_AUTOUPDATE_PLUGINS=1 in one of them takes it out of force. A file
  // Claude Code runs without is skipped, with a warning once per boot; a
  // managed one Claude Code refuses to start with stops the tick, for the same
  // reason as settings.json above (readClaudeCodeSettingsEnvBlocks).
  const claudeCodeSettings = runStage('read-claude-code-settings', () => readers.readClaudeCodeSettingsEnv());
  observer.claudeCodeSettingsRead?.(claudeCodeSettings);
  const claudeCodeSwitch = claudeCodeSwitchInForce(readers.env, claudeCodeSettings.envBlocks);
  if (claudeCodeSwitch !== null) return { kind: 'off', reason: claudeCodeSwitch };
  // Claude Code's own background update of the thedotmack marketplace, turned
  // on by the user or their admin where it outranks known_marketplaces.json:
  // both updaters would race, so claude-mem's stays off.
  const claudeMemMarketplaceDeclaration = claudeMemMarketplaceDeclarationInForce(claudeCodeSettings.claudeMemMarketplaceDeclarations);
  if (claudeMemMarketplaceDeclaration?.autoUpdate === true) {
    return {
      kind: 'off',
      reason: `extraKnownMarketplaces.${CLAUDE_MEM_MARKETPLACE_KEY}.autoUpdate is true in ${claudeMemMarketplaceDeclaration.path}: Claude Code's own background update of claude-mem's marketplace is on there, and Claude Code reads that before known_marketplaces.json, so running claude-mem's updater too would race it`,
    };
  }
  return { kind: 'on', settings, claudeMemMarketplaceDeclaration };
}

/**
 * Why auto-update is off by claude-mem's own settings, or null. That needs
 * nothing else read. Claude Code's switches, even one set in the worker's own
 * env, wait for claudeCodeSwitchInForce, which reads them after Claude Code's
 * settings files: FORCE_AUTOUPDATE_PLUGINS set in one of them takes them out
 * of force.
 */
export function autoUpdateDisabledReason(settings: AutoUpdateSettings): string | null {
  const autoUpdateSwitch = parseAutoUpdateSwitch(settings.CLAUDE_MEM_AUTO_UPDATE);
  if (autoUpdateSwitch === 'off') return 'CLAUDE_MEM_AUTO_UPDATE=false';
  if (autoUpdateSwitch === 'unrecognised') {
    return `CLAUDE_MEM_AUTO_UPDATE=${JSON.stringify(settingText(settings.CLAUDE_MEM_AUTO_UPDATE))} (only "true" turns it on)`;
  }
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
 * install.ts registerMarketplace, registerPlugin and
 * enablePluginInClaudeSettings, which read those files with readJsonSafe and
 * stop on one that does not parse. registerMarketplace runs after the
 * installer has already rewritten the marketplace copy and the plugin cache,
 * so an update that stops there leaves the install half-written; and in a
 * known_marketplaces.json that holds JSON but no object, it cannot register
 * the marketplace either (null or text stops it, an array is written back
 * without the entry). `marketplaceInstallLocation` is the installLocation
 * registerMarketplace writes (paths.ts marketplaceDirectory).
 */
export function claudeCodePluginStateDisabledReason(pluginState: ClaudeCodePluginState, marketplaceInstallLocation: string): string | null {
  const { userSettings, registration, knownMarketplaces } = pluginState;
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
  if (knownMarketplaces.kind === 'unreadable') {
    return `${knownMarketplaces.problem}, so an update could not register the marketplace there: it would stop on that file, or write it back without claude-mem's entry, after it had already rewritten the marketplace copy and the plugin cache`;
  }
  const entryDifference = knownMarketplaces.document === null
    ? null
    : claudeMemMarketplaceEntryDifference(knownMarketplaces.document, marketplaceInstallLocation);
  if (entryDifference !== null) {
    return `the ${CLAUDE_MEM_MARKETPLACE_KEY} entry in ${knownMarketplaces.path} ${entryDifference}, not the one the installer writes (source ${JSON.stringify(CLAUDE_MEM_MARKETPLACE_SOURCE)} at ${marketplaceInstallLocation}), so it was added another way, and an unattended update would replace it`;
  }
  return null;
}

/**
 * How claude-mem's entry in known_marketplaces.json differs from the one
 * install.ts registerMarketplace writes, or null when it does not differ or
 * there is none (registerMarketplace adds one). registerMarketplace replaces
 * the whole entry with CLAUDE_MEM_MARKETPLACE_SOURCE at marketplaceDirectory(),
 * so it would rewrite the entry of a user who added the marketplace another
 * way: `owner/repo#ref` (a `github` source with a `ref`), a git URL (a `git`
 * source) or a local path (a `directory` source, whose "`installLocation` in
 * `known_marketplaces.json` is the path you gave")
 * (https://code.claude.com/docs/en/plugins/cli-reference "plugin marketplace
 * add", https://code.claude.com/docs/en/plugins/loading, read 2026-11-08).
 *
 * The rewrite would not stick either. `claude plugin marketplace add` "writes
 * the marketplace to `extraKnownMarketplaces` in your user settings as well as
 * to disk", and after a session starts "Claude Code checks the declared
 * marketplaces in the background: ... A declared marketplace whose source
 * changed in settings: Claude Code re-fetches it from the new source and shows
 * `Plugins changed. Run /reload-plugins to activate.`" (plugins/loading, read
 * 2026-11-08). The declaration would still name the user's source while the
 * entry named claude-mem's, so Claude Code would fetch the user's source over
 * it again, and every update would redo the rewrite. Such an entry keeps the
 * updater off; the user's own `npx claude-mem update` still rewrites it, as
 * it always has.
 *
 * The source must be exactly CLAUDE_MEM_MARKETPLACE_SOURCE, with no other
 * field: registerMarketplace would drop any. installLocation is compared as a
 * resolved path, so a trailing separator is not a difference.
 */
function claudeMemMarketplaceEntryDifference(knownMarketplaces: Record<string, unknown>, marketplaceInstallLocation: string): string | null {
  const entry = knownMarketplaces[CLAUDE_MEM_MARKETPLACE_KEY];
  if (entry === undefined) return null;
  if (!isPlainObject(entry)) return `is ${describeJsonKind(entry)}`;
  const { source, installLocation } = entry;
  const sourceIsTheInstallers = isPlainObject(source)
    && Object.keys(source).length === Object.keys(CLAUDE_MEM_MARKETPLACE_SOURCE).length
    && source.source === CLAUDE_MEM_MARKETPLACE_SOURCE.source
    && source.repo === CLAUDE_MEM_MARKETPLACE_SOURCE.repo;
  if (!sourceIsTheInstallers) return `has source ${JSON.stringify(source)}`;
  if (typeof installLocation !== 'string' || path.resolve(installLocation) !== path.resolve(marketplaceInstallLocation)) {
    return `has installLocation ${JSON.stringify(installLocation)}`;
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
 *    npx install's and are not read: an update keeps them exactly as they
 *    are (registerPlugin replaces only the user-scope entry). A missing file
 *    holds no entry.
 *  - known_marketplaces.json (install.ts registerMarketplace, readJsonSafe):
 *    a missing file holds no entry; one that does not parse as a JSON object
 *    (empty and an array included) is unreadable: registerMarketplace stops on
 *    it, or, for an array, writes it back without claude-mem's entry. The
 *    whole document is kept as read.
 */
export function readClaudeCodePluginState(files: { userSettingsPath: string; installedPluginsPath: string; knownMarketplacesPath: string }): ClaudeCodePluginState {
  return {
    userSettings: readClaudeCodeUserSettingsToggle(files.userSettingsPath),
    registration: readClaudeCodeRegistration(files.installedPluginsPath),
    knownMarketplaces: readClaudeCodeKnownMarketplaces(files.knownMarketplacesPath),
  };
}

function readClaudeCodeUserSettingsToggle(userSettingsPath: string): ClaudeCodePluginState['userSettings'] {
  const read = readJsonObjectFile(userSettingsPath, { emptyFileIsAnEmptyObject: false });
  if (read.kind === 'missing') return { kind: 'not-disabled' };
  if (read.kind === 'unusable') return { kind: 'unreadable', path: userSettingsPath, problem: read.problem };
  const enabledPlugins = read.document.enabledPlugins;
  return isPlainObject(enabledPlugins) && enabledPlugins[CLAUDE_MEM_PLUGIN_KEY] === false
    ? { kind: 'explicitly-disabled', path: userSettingsPath }
    : { kind: 'not-disabled' };
}

function readClaudeCodeKnownMarketplaces(knownMarketplacesPath: string): ClaudeCodePluginState['knownMarketplaces'] {
  const read = readJsonObjectFile(knownMarketplacesPath, { emptyFileIsAnEmptyObject: false });
  if (read.kind === 'unusable') return { kind: 'unreadable', path: knownMarketplacesPath, problem: read.problem };
  return { kind: 'read', path: knownMarketplacesPath, document: read.kind === 'object' ? read.document : null };
}

/** One JSON file that must hold an object, read by readJsonObjectFile. */
type JsonObjectFileRead =
  | { kind: 'missing' }
  | { kind: 'object'; document: Record<string, unknown> }
  /** `problem` names the file and what is wrong; `cause` is the read or parse error, when there was one. */
  | { kind: 'unusable'; problemKind: ClaudeCodeSettingsFileProblemKind; problem: string; cause?: unknown };

/**
 * The one reader of a JSON file that must hold an object, for Claude Code's
 * settings files and its plugin records. A missing file is `missing`; one that
 * exists but cannot be read, is not valid JSON or is not a JSON object (an
 * array included) is `unusable`, its problem worded the same way for every
 * file. A UTF-8 byte order mark is stripped, as readJsonSafe strips it
 * (#3013). An empty file (nothing but whitespace or a byte order mark) reads
 * as `{}` when `emptyFileIsAnEmptyObject`, the way Claude Code reads an empty
 * settings file, and is not valid JSON otherwise, the way install.ts reads
 * every file it rewrites (readJsonSafe refuses it).
 */
function readJsonObjectFile(filePath: string, options: { emptyFileIsAnEmptyObject: boolean }): JsonObjectFileRead {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'missing' };
    return {
      kind: 'unusable',
      problemKind: isReadDeniedByTheOperatingSystem(code) ? 'read-denied' : 'read-failed',
      problem: `${filePath} exists but cannot be read: ${errorMessageOf(error)}`,
      cause: error,
    };
  }
  if (options.emptyFileIsAnEmptyObject && raw.trim() === '') return { kind: 'object', document: {} };
  let parsed: unknown;
  try {
    parsed = parseJsonWithBom(raw);
  } catch (error: unknown) {
    return { kind: 'unusable', problemKind: 'not-a-json-object', problem: `${filePath} is not valid JSON: ${errorMessageOf(error)}`, cause: error };
  }
  if (!isPlainObject(parsed)) return { kind: 'unusable', problemKind: 'not-a-json-object', problem: `${filePath} does not hold a JSON object` };
  return { kind: 'object', document: parsed };
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
 * Turn off Claude Code's background update of the thedotmack marketplace,
 * once claude-mem's own updater has shown it can work on this machine. This
 * is the only place that turns it off: install.ts registerMarketplace
 * registers a new entry with autoUpdate true, as every installer before Phase
 * 4 did, and keeps an existing entry's as it is, since nothing the installer
 * can read shows that claude-mem's updater works here. Claude Code's
 * background update then installs main's version at a session start as soon
 * as a version bump lands there, before the owner promotes it, so claude-mem's
 * updater always reads "up to date", never runs the installer, and the flag
 * would never flip on those installs.
 *
 * Nothing to do, and any reason recorded earlier is cleared, when Claude
 * Code's own setting already has it off (the extraKnownMarketplaces
 * declaration in force says autoUpdate false; one that says true kept the
 * updater off at gate 1), or when there is no file, no thedotmack entry, or an
 * autoUpdate that is anything but true.
 *
 * Otherwise Claude Code's update is the install's only working updater until
 * claude-mem's has shown it can work here: on a network that blocks
 * registry.npmjs.org (gate 7 reads it directly), or for a worker whose PATH
 * has no npx, turning it off would leave the install with none. So it stays
 * on, logged once per boot, with the reason in the state file for the doctor
 * row (claudeCodeBackgroundUpdateLeftOnReason), until
 *  - a check has read both the promoted file and npm's metadata for the
 *    promoted version, shown published by the workflow
 *    (promotedFileAndNpmMetadataReadAt: set at gate 7, or by the one read
 *    gate 6 makes for it while this waits, waitingForUpdaterProof); and
 *  - npx is on the worker's PATH, looked up the way the supervisor's installer
 *    run finds it (deps.findNpxOnWorkerPath).
 *
 * Then only `thedotmack.autoUpdate` changes, from true to false, in a document
 * read with nothing awaited since but local reads: gate 1's, written back
 * before gate 4 with only gate 3's local read of an interrupted attempt's
 * install in between, or, on the tick whose gate 7 records the proof while
 * this waited for it, one read again right before gate 8, after the network
 * reads, which must pass gate 1's plugin-state rules again before this runs
 * (runAutoUpdateCheck). Every other entry and
 * field is written back as read and in the order read: JSON.parse keeps it and
 * writeJsonFileAtomic's JSON.stringify writes it, except that JavaScript puts
 * integer-like keys first. A file that is not writable, or a write that fails,
 * is logged with its stage, recorded as the reason, and left as it was; the
 * next tick tries again.
 */
function settleClaudeCodeBackgroundUpdate(
  deps: AutoUpdateCheckDeps,
  state: AutoUpdateState,
  now: number,
  knownMarketplaces: { path: string; document: Record<string, unknown> | null },
  declarationInForce: ClaudeMemMarketplaceDeclaration | null,
): { stateChanged: boolean; waitingForUpdaterProof: boolean } {
  const reasonBefore = state.claudeCodeBackgroundUpdateLeftOnReason;
  const settled = (leftOnReason: string | null, waitingForUpdaterProof: boolean) => {
    state.claudeCodeBackgroundUpdateLeftOnReason = leftOnReason;
    return { stateChanged: leftOnReason !== reasonBefore, waitingForUpdaterProof };
  };
  const document = knownMarketplaces.document;
  const claudeMemEntry = declarationInForce?.autoUpdate === false || document === null
    ? null
    : claudeMemEntryWithBackgroundUpdateOn(document);
  if (document === null || claudeMemEntry === null) return settled(null, false);

  if (state.promotedFileAndNpmMetadataReadAt === null) {
    const reason = `claude-mem's updater has not yet read both the promoted file and npm's metadata for the promoted version on this machine, so Claude Code's background update of the ${CLAUDE_MEM_MARKETPLACE_KEY} marketplace stays on until it has`;
    logOncePerBoot(deps, 'claude-code-background-update-left-on:updater-not-yet-proven', () => logger.info('AUTO_UPDATE',
      `Left Claude Code's background update on: ${reason}`, { knownMarketplaces: knownMarketplaces.path }));
    return settled(reason, true);
  }
  if (deps.findNpxOnWorkerPath() === null) {
    const reason = `npx is not on the worker's PATH, so claude-mem's updater could not run its installer, and Claude Code's background update of the ${CLAUDE_MEM_MARKETPLACE_KEY} marketplace stays on`;
    logOncePerBoot(deps, 'claude-code-background-update-left-on:npx-not-found', () => logger.warn('AUTO_UPDATE',
      `Left Claude Code's background update on: ${reason}`, { knownMarketplaces: knownMarketplaces.path, workerPath: deps.env.PATH }));
    return settled(reason, false);
  }

  claudeMemEntry.autoUpdate = false;
  try {
    deps.writeClaudeCodeKnownMarketplaces(document);
  } catch (error: unknown) {
    logClaudeCodeBackgroundUpdateStepFailure(deps, 'write-claude-code-known-marketplaces', error);
    return settled(`Claude Code's background update of the ${CLAUDE_MEM_MARKETPLACE_KEY} marketplace stays on: ${errorMessageOf(error)}`, false);
  }
  logger.info('AUTO_UPDATE',
    `Turned off Claude Code's background update of the ${CLAUDE_MEM_MARKETPLACE_KEY} marketplace (autoUpdate true → false in its known_marketplaces.json): claude-mem installs the release the owner promotes, and Claude Code's update would install main at a random time into the same cache folders`,
    { marketplace: CLAUDE_MEM_MARKETPLACE_KEY, knownMarketplaces: knownMarketplaces.path });
  state.claudeCodeBackgroundUpdateTurnedOffAt = now;
  state.claudeCodeBackgroundUpdateLeftOnReason = null;
  return { stateChanged: true, waitingForUpdaterProof: false };
}

/** claude-mem's marketplace entry when it has Claude Code's background update on (autoUpdate === true), or null. */
function claudeMemEntryWithBackgroundUpdateOn(knownMarketplaces: Record<string, unknown>): Record<string, unknown> | null {
  const claudeMemEntry = knownMarketplaces[CLAUDE_MEM_MARKETPLACE_KEY];
  return isPlainObject(claudeMemEntry) && claudeMemEntry.autoUpdate === true ? claudeMemEntry : null;
}

/**
 * The one read gate 6 makes while the turn-off waits for proof
 * (settleClaudeCodeBackgroundUpdate): npm's metadata for the promoted version,
 * which an install that is already up to date never reaches gate 7 to read.
 * Shown published by the workflow, it is the proof
 * (promotedFileAndNpmMetadataReadAt). Anything else is logged and leaves the
 * turn-off waiting; a read that failed is also this check's error, so the
 * doctor row shows why (lastCheckError). The decision stays up-to-date, and
 * the next due check reads it again.
 */
async function readNpmMetadataForTheTurnOff(deps: AutoUpdateCheckDeps, state: AutoUpdateState, promotedVersion: string, now: number): Promise<void> {
  const publication = await readNpmPublication(deps, promotedVersion);
  if (publication.kind === 'published') {
    state.promotedFileAndNpmMetadataReadAt = now;
    return;
  }
  if (publication.kind === 'failed') state.lastCheckError = { at: now, message: publication.message };
  logger.warn('AUTO_UPDATE',
    `npm's metadata for the promoted version did not prove claude-mem's updater here, so Claude Code's background update of the ${CLAUDE_MEM_MARKETPLACE_KEY} marketplace stays on; the next due check reads it again`,
    {
      promotedVersion,
      problem: publication.kind === 'failed' ? publication.message : `not published by the workflow (missing ${publication.missing.join(', ')})`,
    });
}

/**
 * Log a turn-off that stopped, with its stage. A file that cannot be written
 * usually stays that way until someone fixes it, and the step runs on every
 * tick, so the first failure at each stage in a boot is a WARN and each later
 * one a DEBUG: the rule logFailedAutoUpdateTick applies to a broken settings
 * file.
 */
function logClaudeCodeBackgroundUpdateStepFailure(deps: AutoUpdateCheckDeps, stage: ClaudeCodeBackgroundUpdateStage, error: unknown): void {
  const cause = error instanceof Error ? error : new Error(String(error));
  const message = `Could not turn off Claude Code's background update of the ${CLAUDE_MEM_MARKETPLACE_KEY} marketplace; its known_marketplaces.json is left as it was, and the next tick tries again`;
  const details = { stage, problem: cause.message };
  const warnedKey: AutoUpdateOncePerBootLogKey = `claude-code-background-update-failed-at-${stage}`;
  if (deps.oncePerBootLogsWritten.has(warnedKey)) {
    logger.debug('AUTO_UPDATE', message, { ...details, loggedAtWarnEarlierThisBoot: true }, cause);
    return;
  }
  deps.oncePerBootLogsWritten.add(warnedKey);
  logger.warn('AUTO_UPDATE', message, details, cause);
}

/**
 * The production writeClaudeCodeKnownMarketplaces: the document written back
 * the way install.ts registerMarketplace writes the file (writeJsonFileAtomic),
 * unless the file is not writable. writeJsonFileAtomic renames a new file over
 * the old one, which only the folder's permissions allow or refuse, and gives
 * the new file the old one's mode, so on its own it would replace a file the
 * user made read-only. One this process may not write, or one that is gone,
 * throws, naming it, and is left as it is.
 */
export function writeClaudeCodeKnownMarketplacesUnlessReadOnly(knownMarketplacesFilePath: string, knownMarketplaces: Record<string, unknown>): void {
  try {
    accessSync(knownMarketplacesFilePath, fsConstants.W_OK);
  } catch (error: unknown) {
    throw new Error(`${knownMarketplacesFilePath} is not writable, so it is left as it is: ${errorMessageOf(error)}`, { cause: error });
  }
  writeJsonFileAtomic(knownMarketplacesFilePath, knownMarketplaces);
}

/**
 * The first of Claude Code's switches in force, as a disabled reason, or
 * null. The worker's env is read first, then the env block of each settings
 * file in order, and a switch on in any of them counts, unless plugin
 * auto-updates are forced (arePluginAutoUpdatesForced, over the same places),
 * which takes every one of them out of force (FORCE_PLUGIN_AUTO_UPDATES).
 */
export function claudeCodeSwitchInForce(env: NodeJS.ProcessEnv, settingsFileEnvBlocks: ClaudeCodeSettingsEnvBlock[]): string | null {
  const places: Array<{ valueOf: (name: string) => string | undefined; whereSet: string }> = [
    { valueOf: (name) => env[name], whereSet: '' },
    ...settingsFileEnvBlocks.map((block) => ({
      valueOf: (name: string) => settingsEnvValueText(block.env[name]),
      whereSet: ` in the env block of ${block.path}`,
    })),
  ];
  if (arePluginAutoUpdatesForced(places.map((place) => place.valueOf(FORCE_PLUGIN_AUTO_UPDATES)))) return null;
  for (const place of places) {
    const switchOn = claudeCodeSwitchSetIn(place.valueOf);
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
 * environment variable over both (applyEnvOverrides), except for two keys.
 * CLAUDE_MEM_AUTO_UPDATE the environment can turn off but never on over a
 * saved off (autoUpdateSwitchFromEnvAndFile). CLAUDE_MEM_AUTO_UPDATE_PROMOTED_RELEASE_URL
 * is read from the file alone, its environment variable never: it names the
 * release switch, the file that picks the version the updater installs, and
 * the worker's environment comes from whatever process started it (a
 * project's SessionStart hook can cold-start the worker), so an inherited
 * variable could point the switch at a file of its own. The file may still
 * name a file:// or http(s) URL, for tests and the sandbox. Those defaults are
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
    const fromFile = saved[key] !== undefined ? coercePersistedSettingValue(saved[key]) : defaults[key];
    // The check reads every value through settingText, so a number or null a
    // hand edit left here is read as text, never thrown on.
    settings[key] = (key === 'CLAUDE_MEM_AUTO_UPDATE' ? autoUpdateSwitchFromEnvAndFile(fromEnv, fromFile)
      : key === 'CLAUDE_MEM_AUTO_UPDATE_PROMOTED_RELEASE_URL' ? fromFile
      : fromEnv !== undefined ? fromEnv : fromFile) as string;
  }
  return settings;
}

/**
 * CLAUDE_MEM_AUTO_UPDATE from both places it is set: anything but on
 * (parseAutoUpdateSwitch) in either one keeps the updater off. So the
 * environment can turn it off, never on over a settings.json that saves it
 * off: the worker's environment comes from whatever process started it (a
 * project's SessionStart hook can cold-start the worker), and the updater
 * installs code on this machine. An environment value that is on gives way
 * to the file's value (a missing key is its shipped default, on); any other
 * is the value read, so its reason names it. The other keys keep the
 * settings manager's rule, the environment over the file, except the
 * release-switch URL, which only the file sets (readAutoUpdateSettings). The
 * worker's tick and doctor's row both read it here
 * (auto-update-switch-readers.ts).
 */
function autoUpdateSwitchFromEnvAndFile(fromEnv: string | undefined, fromFile: unknown): unknown {
  if (fromEnv === undefined) return fromFile;
  return parseAutoUpdateSwitch(fromEnv) === 'on' ? fromFile : fromEnv;
}

/**
 * Whether a settings.json that loadDocument could not parse is empty: nothing
 * but whitespace or a byte order mark, which reads as an empty document, the
 * way readClaudeCodeSettingsFile reads an empty Claude Code settings file.
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
 * turns auto-update off, so the files are read one by one, not merged. From
 * the same files, in the same order, it takes the thedotmack entry each
 * declares under extraKnownMarketplaces (claudeMemMarketplaceDeclarationIn).
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
 *    directory's included) is skipped, and anything else throws: a switch in
 *    it could not be seen.
 * An env that is not an object is a broken value in either scope: it is
 * dropped, listed in `skipped`, and the rest of the file is still read.
 * Each skipped path is listed in `skipped`, for the check to warn about.
 */
export function readClaudeCodeSettingsEnvBlocks(files: { userSettingsPath: string; managedSettingsDirectory: string }): ClaudeCodeSettingsEnvRead {
  const read: ClaudeCodeSettingsEnvRead = { envBlocks: [], skipped: [], claudeMemMarketplaceDeclarations: [] };
  const addFile = (filePath: string, scope: ClaudeCodeSettingsScope): void => {
    let settingsFile: ClaudeCodeSettingsFileRead | null;
    try {
      settingsFile = readClaudeCodeSettingsFile(filePath);
    } catch (error: unknown) {
      if (!(error instanceof UnusableClaudeCodeSettingsFile) || !claudeCodeRunsWithout(scope, error.problemKind)) throw error;
      read.skipped.push({ path: filePath, problem: error.message });
      return;
    }
    if (settingsFile === null) return;
    if (settingsFile.env.kind === 'block') read.envBlocks.push({ path: filePath, env: settingsFile.env.block });
    else read.skipped.push({ path: filePath, problem: settingsFile.env.problem });
    if (settingsFile.claudeMemMarketplaceDeclaration !== null) {
      read.claudeMemMarketplaceDeclarations.push(settingsFile.claudeMemMarketplaceDeclaration);
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

/**
 * The extraKnownMarketplaces declaration of claude-mem's marketplace that
 * Claude Code uses, or null when no file read declares one. Its rule for
 * whether a marketplace auto-updates "follows the first of these that is set:
 * 1. `autoUpdate` on its `extraKnownMarketplaces` entry in a settings file
 * 2. `autoUpdate` on its `known_marketplaces.json` entry, which the Enable
 * auto-update toggle under /plugin Marketplaces writes. When a settings file
 * also declares the marketplace under `extraKnownMarketplaces`, the toggle
 * writes `autoUpdate` to that settings entry as well 3. The default: ... off
 * for every other marketplace", and "When you run `claude plugin marketplace
 * add`, Claude Code writes the marketplace to `extraKnownMarketplaces` in your
 * user settings as well as to disk" (https://code.claude.com/docs/en/plugins/loading,
 * "Which marketplaces and plugins auto-update" and "Check which stage a plugin
 * reached", read 2026-11-08).
 *
 * Which entry counts: "When more than one settings file defines a marketplace
 * entry under the same name, Claude Code uses the entry from the
 * highest-precedence file whole" (https://code.claude.com/docs/en/settings-reference
 * `extraKnownMarketplaces`), and between managed files "a later entry with the
 * same name replaces the earlier one whole" (managed-settings). The files are
 * read user settings first, then managed settings in merge order, so the last
 * declaration read is the one in force, autoUpdate set or not. Project and
 * local settings belong to one repository each, and the worker reads neither.
 *
 * The check reads its autoUpdate and never writes it:
 *  - true: Claude Code's own updater is on by the user's or their admin's
 *    choice, and both would race, so claude-mem's stays off (gate 1);
 *  - false: Claude Code's is off already, so there is nothing to turn off;
 *  - not set: known_marketplaces.json decides (settleClaudeCodeBackgroundUpdate).
 */
export function claudeMemMarketplaceDeclarationInForce(declarations: ReadonlyArray<ClaudeMemMarketplaceDeclaration>): ClaudeMemMarketplaceDeclaration | null {
  return declarations.length === 0 ? null : declarations[declarations.length - 1];
}

/** Claude Code's background update of the thedotmack marketplace as Claude Code itself decides it (claudeCodeBackgroundUpdateSetting). */
export type ClaudeCodeBackgroundUpdateSetting =
  /** `setIn` names where: an extraKnownMarketplaces entry in a settings file, or known_marketplaces.json. */
  | { kind: 'set'; on: boolean; setIn: string }
  /** Nothing sets it, so it is off: `why` says which default applies. */
  | { kind: 'off-by-default'; why: string }
  | { kind: 'unreadable'; problem: string };

/**
 * Whether Claude Code's own background update of the thedotmack marketplace
 * is on now, by Claude Code's rule (claudeMemMarketplaceDeclarationInForce
 * quotes it): the autoUpdate of the extraKnownMarketplaces declaration in
 * force, else the autoUpdate of the entry in known_marketplaces.json, else
 * Claude Code's default, which is off for every marketplace but its own
 * official one. A marketplace with neither an entry nor a declaration is not
 * registered, so nothing updates it. Read from what the check's readers read
 * (readClaudeCodeSettingsEnvBlocks, readClaudeCodePluginState), for the doctor
 * row; an autoUpdate that is not a JSON boolean is not set, as Claude Code
 * reads it.
 */
export function claudeCodeBackgroundUpdateSetting(
  declarations: ReadonlyArray<ClaudeMemMarketplaceDeclaration>,
  knownMarketplaces: ClaudeCodePluginState['knownMarketplaces'],
): ClaudeCodeBackgroundUpdateSetting {
  const declaration = claudeMemMarketplaceDeclarationInForce(declarations);
  if (declaration?.autoUpdate !== undefined) {
    return { kind: 'set', on: declaration.autoUpdate, setIn: `extraKnownMarketplaces in ${declaration.path}` };
  }
  if (knownMarketplaces.kind === 'unreadable') return { kind: 'unreadable', problem: knownMarketplaces.problem };
  const entry = knownMarketplaces.document?.[CLAUDE_MEM_MARKETPLACE_KEY];
  if (isPlainObject(entry) && typeof entry.autoUpdate === 'boolean') return { kind: 'set', on: entry.autoUpdate, setIn: knownMarketplaces.path };
  if (isPlainObject(entry) || declaration !== null) {
    return { kind: 'off-by-default', why: 'nothing sets it, and Claude Code\'s default for a marketplace it does not ship is off' };
  }
  return { kind: 'off-by-default', why: `the ${CLAUDE_MEM_MARKETPLACE_KEY} marketplace is not registered in ${knownMarketplaces.path}` };
}

/** Which of Claude Code's settings a file is: the user's own, or managed (the file-based policy). */
type ClaudeCodeSettingsScope = 'user' | 'managed';

/** What is wrong with a JSON file that exists, in the cases Claude Code's settings docs tell apart. */
type ClaudeCodeSettingsFileProblemKind = 'read-denied' | 'read-failed' | 'not-a-json-object';

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
  return scope === 'user' || problemKind === 'read-denied';
}

/** EACCES and EPERM: the operating system denied the read, "for example on a root-only file". */
function isReadDeniedByTheOperatingSystem(code: string | undefined): boolean {
  return code === 'EACCES' || code === 'EPERM';
}

/** What one of Claude Code's settings files holds for the check. */
interface ClaudeCodeSettingsFileRead {
  /** Its env block, or why Claude Code drops it: an env that is not an object. */
  env: { kind: 'block'; block: Record<string, unknown> } | { kind: 'dropped'; problem: string };
  claudeMemMarketplaceDeclaration: ClaudeMemMarketplaceDeclaration | null;
}

/**
 * One settings file, or null when it does not exist. Throws
 * UnusableClaudeCodeSettingsFile for one that exists but cannot be read or
 * does not hold a JSON object (readJsonObjectFile; an empty file reads as `{}`).
 */
function readClaudeCodeSettingsFile(filePath: string): ClaudeCodeSettingsFileRead | null {
  const read = readJsonObjectFile(filePath, { emptyFileIsAnEmptyObject: true });
  if (read.kind === 'missing') return null;
  if (read.kind === 'unusable') throw new UnusableClaudeCodeSettingsFile(read.problemKind, read.problem, { cause: read.cause });
  const env = read.document.env;
  return {
    // A null env sets nothing, as a null policy key does in managed settings.
    env: env === undefined || env === null
      ? { kind: 'block', block: {} }
      : isPlainObject(env)
        ? { kind: 'block', block: env }
        : { kind: 'dropped', problem: `${filePath}: its env is ${Array.isArray(env) ? 'an array' : typeof env}, not an object` },
    claudeMemMarketplaceDeclaration: claudeMemMarketplaceDeclarationIn(filePath, read.document),
  };
}

/**
 * The file's extraKnownMarketplaces.thedotmack entry, or null when it declares
 * none. An extraKnownMarketplaces or an entry that is not an object is a
 * broken value Claude Code drops, so it declares nothing; an autoUpdate that
 * is not a JSON boolean, the type Claude Code reads, is not set.
 */
function claudeMemMarketplaceDeclarationIn(filePath: string, settings: Record<string, unknown>): ClaudeMemMarketplaceDeclaration | null {
  const declaredMarketplaces = settings.extraKnownMarketplaces;
  const entry = isPlainObject(declaredMarketplaces) ? declaredMarketplaces[CLAUDE_MEM_MARKETPLACE_KEY] : undefined;
  if (!isPlainObject(entry)) return null;
  return { path: filePath, autoUpdate: typeof entry.autoUpdate === 'boolean' ? entry.autoUpdate : undefined };
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
 * not blocked. Otherwise it failed; where the attempt left the install is read
 * the supervisor's way (deps.readInterruptedAttemptInstall), and whether the
 * version is never retried follows vanishedAttemptBlocksItsTarget. A reboot can kill the supervisor and
 * its installer after the target is registered, and then no supervisor
 * repairs it and nothing tells the user: an install left with part of the
 * target in place is recorded as restore_failed, naming the target's own
 * installer as the fix, to run now (auto-update-state-file.ts
 * interruptedAttemptFix says why the target, in the message and as
 * fixCommand), so the notice and the doctor row show it. Every outcome keeps
 * the stage, so the doctor row and telemetry show how it ended. A worker that
 * finished starting on the version the install resolves to after the attempt
 * was cut off marked it resolved (auto-update-state-file.ts
 * markAutoUpdateFailuresResolvedByReadyWorker); a failure recorded for it now
 * keeps that mark, so the person whose install works does not see the warning
 * come back.
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
  const resolution = attempt.resolvedAt === undefined
    ? {}
    : {
        resolvedAt: attempt.resolvedAt,
        ...(attempt.resolvedWithWorkerVersion === undefined ? {} : { resolvedWithWorkerVersion: attempt.resolvedWithWorkerVersion }),
      };
  if (leftAt.kind === 'half-switched') {
    const fix = interruptedAttemptFix(attempt);
    state.lastAttemptOutcome = {
      result: 'restore_failed',
      ...versions,
      finishedAt: now,
      failureStage: 'supervisor-vanished',
      message: `${whatHappened} ${leftAt.where} Part of ${attempt.targetVersion} is in place, and nothing restored ${attempt.previousVersion} or proved ${attempt.targetVersion}. Run: ${fix.command}`,
      fixCommand: fix.command,
      fixCommandWhen: fix.when,
      ...resolution,
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
      message: `${whatHappened} ${leftAt.where}${movedOn}${whatBecomesOfTheTarget(attempt, leftAt)}`,
      ...resolution,
    };
  }
  if (vanishedAttemptBlocksItsTarget(attempt, leftAt) && !state.versionsThatFailedToApply.includes(attempt.targetVersion)) {
    state.versionsThatFailedToApply.push(attempt.targetVersion);
  }
  return state.lastAttemptOutcome;
}

/**
 * Whether a vanished attempt that did not apply blocks its target, never
 * retried automatically. The install's readings alone cannot tell an attempt
 * that changed nothing (a reboot during the npm download) from one whose
 * restore put the previous version back before the supervisor was killed, so
 * the phase the supervisor recorded decides with them
 * (AutoUpdateInFlightAttempt.supervisorPhase):
 *  - blocked once the restore had begun, since a restore runs only after the
 *    target's switch failed, or when the readings show part of the target in
 *    place (half-switched);
 *  - not blocked while it was still installing the target with no part of it
 *    in place, the supervisor's own rule when nothing switched
 *    (auto-update-apply.ts recoverOnPreviousVersion): the next due check tries
 *    it again;
 *  - blocked for an attempt claimed with no phase recorded, by a supervisor
 *    from before the phase was, as every vanished attempt was before.
 */
function vanishedAttemptBlocksItsTarget(attempt: AutoUpdateInFlightAttempt, leftAt: InterruptedAttemptInstall): boolean {
  if (attempt.supervisorPhase === undefined) return true;
  return attempt.supervisorPhase === 'restoring-previous-version' || leftAt.kind === 'half-switched';
}

/** What the failed outcome of a vanished attempt says becomes of its target, for the doctor row and the log ('' when there is nothing to add). */
function whatBecomesOfTheTarget(attempt: AutoUpdateInFlightAttempt, leftAt: Exclude<InterruptedAttemptInstall, { kind: 'half-switched' }>): string {
  if (attempt.supervisorPhase === 'restoring-previous-version') {
    return ` Its supervisor had begun restoring ${attempt.previousVersion}, so ${attempt.targetVersion} had already failed here and is not tried again.`;
  }
  if (attempt.supervisorPhase === 'installing-target' && leftAt.kind === 'on-previous-version') {
    return ` Its supervisor was still installing ${attempt.targetVersion}, and nothing of it is in place, so it is tried again at the next due check.`;
  }
  return '';
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

/** The decisions that mean auto-update is off on this install (gates 1 and 2); every other one means it is on. */
export const AUTO_UPDATE_OFF_DECISIONS: ReadonlySet<string> = new Set<AutoUpdateDecisionName>([
  'disabled',
  'no-install',
  'not-a-standard-install',
  'unknown-installed-version',
]);

/** Unit conversion, so the deferral's reason states the quiet window in minutes. */
const QUIET_WINDOW_MINUTES = Math.round(AUTO_UPDATE_QUIET_WINDOW_MS / MILLISECONDS_PER_MINUTE);

/**
 * A decision in plain words, as the doctor row shows the worker's last one.
 * Times are left out: the row shows when it was decided, and when the last
 * check ran, on lines of their own.
 */
export function describeAutoUpdateDecision(decision: AutoUpdateDecision): string {
  switch (decision.decision) {
    case 'disabled': return decision.reason;
    case 'no-install': return 'no claude-mem install was found';
    case 'not-a-standard-install':
      return `${decision.root} is not in Claude Code's plugin cache or marketplace folder (a source checkout or an override), so it is left alone`;
    case 'unknown-installed-version':
      return `the version installed at ${decision.root} (${decision.installedVersion ?? 'none recorded'}) is not one claude-mem can compare`;
    // Neither is recorded (runAutoUpdateCheck): each ends a tick with an attempt in flight.
    case 'attempt-in-flight':
    case 'launch-unconfirmed':
      return `updating ${decision.previousVersion} → ${decision.targetVersion}`;
    case 'not-due': return 'checked less than a day ago, so the next check waits';
    case 'check-failed':
      return decision.stage === 'fetch-promoted-release'
        ? 'the last check could not read the promoted release file'
        : 'the last check could not read npm\'s record of the promoted release';
    case 'unknown-schema': return 'the promoted release file is in a format this version does not read, so nothing is installed';
    case 'up-to-date': return `up to date: ${decision.installedVersion} is installed, and the promoted release is ${decision.promotedVersion}`;
    case 'previously-failed': return `${decision.promotedVersion} is promoted, but it failed here before, so it waits for the next promoted release`;
    case 'not-published-by-workflow':
      return `${decision.promotedVersion} is promoted, but npm does not show it published by claude-mem's release workflow (missing ${decision.missing.join(', ')}), so it is skipped`;
    case 'deferred-busy':
      return `${decision.promotedVersion ?? 'the promoted release'} waits until claude-mem has had nothing to do for ${QUIET_WINDOW_MINUTES} minutes, or has been busy for a full day`;
    case 'worker-shutting-down': return `the worker was shutting down, so ${decision.targetVersion} waits for its next start`;
    case 'apply': return `installing ${decision.targetVersion} (from ${decision.previousVersion})`;
    case 'launch-failed': return `${decision.targetVersion} could not be started (${decision.message}); the next daily check tries again`;
  }
}

function recordDecision(state: AutoUpdateState, decision: AutoUpdateDecision, now: number): void {
  state.lastDecision = { decision: decision.decision, reason: describeAutoUpdateDecision(decision), decidedAt: now };
}

/**
 * Record an off decision (gates 1 and 2) for doctor, which runs in a terminal
 * whose environment can differ from the worker's, so only the worker can say
 * that it is off. An off tick reads the state file only for this, and writes
 * it only while no attempt is in flight (its supervisor writes the file then).
 * A file that cannot be read or written does not change the decision: doctor
 * works the status out itself until a tick records one. That is logged with
 * the rule logClaudeCodeBackgroundUpdateStepFailure applies: a broken file
 * stays broken and the tick runs every hour, so the first failure in a boot is
 * a WARN and each later one a DEBUG.
 */
function recordOffDecision(deps: AutoUpdateCheckDeps, decision: AutoUpdateOffDecision, now: number): void {
  try {
    const state = deps.readState();
    if (state.inFlightAttempt !== null) return;
    recordDecision(state, decision, now);
    deps.writeState(state);
  } catch (error: unknown) {
    const cause = error instanceof Error ? error : new Error(String(error));
    const message = 'Could not record the off decision in the auto-update state file; doctor works the status out itself until a tick can';
    const details = { decision: decision.decision, problem: cause.message };
    if (deps.oncePerBootLogsWritten.has('record-off-decision-failed')) {
      logger.debug('AUTO_UPDATE', message, { ...details, loggedAtWarnEarlierThisBoot: true }, cause);
      return;
    }
    deps.oncePerBootLogsWritten.add('record-off-decision-failed');
    logger.warn('AUTO_UPDATE', message, details, cause);
  }
}

function logDecision<D extends AutoUpdateDecision>(deps: AutoUpdateCheckDeps, decision: D): D {
  const { decision: name, ...details } = decision;
  const writeLog = (): void => {
    const message = `Auto-update decision: ${name}`;
    if (name === 'not-due') {
      // 23 of every 24 ticks end here; the state file has the time of the last check.
      logger.debug('AUTO_UPDATE', message, details);
    } else if (name === 'launch-failed' || name === 'launch-unconfirmed') {
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

/** The first of Claude Code's switches that is on, reading each value through `valueOf`, or null. */
function claudeCodeSwitchSetIn(valueOf: (name: string) => string | undefined): string | null {
  for (const { name, isOn } of CLAUDE_CODE_NO_BACKGROUND_UPDATE_SWITCHES) {
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
