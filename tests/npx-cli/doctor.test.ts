import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  autoUpdateCheck,
  hookLauncherCheck,
  observerProviderCheck,
  probeChromaDiagnostics,
  probeWorkerDependencies,
  treeSitterCliCheck,
  workerDependencyChecks,
  type AutoUpdateDoctorSources,
} from '../../src/npx-cli/commands/doctor.js';
import { LAUNCHER_PROTOCOL } from '../../src/launcher/launcher-protocol.js';
import {
  describeAutoUpdateDecision,
  readAutoUpdateSwitches,
  type AutoUpdateDecision,
  type AutoUpdateSettings,
  type AutoUpdateSwitchReaders,
  type ClaudeCodePluginState,
  type ClaudeMemMarketplaceDeclaration,
} from '../../src/services/auto-update/auto-update-check.js';
import type { ClaudeMemInstallShape } from '../../src/services/auto-update/auto-update-install-shape.js';
import {
  AUTO_UPDATE_FORWARD_FIX_COMMAND,
  defaultAutoUpdateState,
  type AutoUpdateAttemptOutcome,
  type AutoUpdateDecisionRecord,
  type AutoUpdateState,
} from '../../src/services/auto-update/auto-update-state.js';

// `npx claude-mem doctor` reads the worker's /api/admin/doctor `health.chroma`
// block (#3362). These rows are optional: a missing, malformed or unreachable
// payload must never produce a row or change the worker's own status.

const WORKER_URL = 'http://127.0.0.1:37777';
const OVERRIDES = ['onnxruntime>=1.20', 'protobuf<7', 'chromadb==1.5.9'];

let fetchSpy: ReturnType<typeof spyOn> | null = null;
let requestedUrls: string[] = [];

function workerReportingChroma(chroma: unknown, status = 200): void {
  fetchSpy?.mockImplementation(async (input: RequestInfo | URL) => {
    requestedUrls.push(String(input));
    return new Response(JSON.stringify({ health: { chroma } }), { status });
  });
}

function workerReportingDependencies(dependencies: unknown, status = 200): void {
  fetchSpy?.mockImplementation(async (input: RequestInfo | URL) => {
    requestedUrls.push(String(input));
    return new Response(JSON.stringify({ health: { dependencies } }), { status });
  });
}

function chromaState(overrides: Record<string, unknown> = {}) {
  return {
    count: 1,
    lastExit: { timestamp: '2026-07-23T12:00:00.000Z', code: null, signal: 'SIGSEGV' },
    chromaMcpVersion: '0.2.6',
    dependencyOverrides: OVERRIDES,
    prewarm: { consecutiveFailures: 0, state: 'ok' },
    ...overrides,
  };
}

describe('npx doctor Chroma diagnostics', () => {
  beforeEach(() => {
    requestedUrls = [];
    fetchSpy = spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    fetchSpy = null;
  });

  it('reports the last exit by signal with versions and overrides', async () => {
    workerReportingChroma(chromaState());

    const [row, ...rest] = await probeChromaDiagnostics(WORKER_URL);

    expect(requestedUrls).toEqual([`${WORKER_URL}/api/admin/doctor`]);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ name: 'Chroma child exits', status: 'warn', required: false });
    expect(row.detail).toContain('1 unexpected exit(s) since the worker started, last by signal SIGSEGV');
    expect(row.detail).toContain('2026-07-23T12:00:00.000Z');
    expect(row.detail).toContain('chroma-mcp 0.2.6');
    expect(row.detail).toContain('onnxruntime>=1.20, protobuf<7, chromadb==1.5.9');
  });

  it('reports a crash inside chroma-mcp as uvx\'s exit code', async () => {
    // uvx is the direct child: a SIGSEGV in the Python engine arrives as uvx's
    // exit code, with no signal on uvx itself.
    workerReportingChroma(chromaState({
      count: 3,
      lastExit: { timestamp: '2026-07-23T12:00:00.000Z', code: 139, signal: null },
    }));

    const [row] = await probeChromaDiagnostics(WORKER_URL);

    expect(row.detail).toContain('3 unexpected exit(s) since the worker started, last by exit code 139');
  });

  it('warns when the prewarm breaker has paused or stopped spawning uvx', async () => {
    workerReportingChroma(chromaState({ count: 0, lastExit: null, prewarm: { consecutiveFailures: 20, state: 'stopped' } }));
    const stopped = await probeChromaDiagnostics(WORKER_URL);
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toMatchObject({ name: 'Chroma prewarm', status: 'warn', required: false });
    expect(stopped[0].detail).toContain('stopped after 20 consecutive uvx failures');

    workerReportingChroma(chromaState({ count: 0, lastExit: null, prewarm: { consecutiveFailures: 6, state: 'paused' } }));
    const paused = await probeChromaDiagnostics(WORKER_URL);
    expect(paused[0].detail).toContain('paused after 6 consecutive uvx failures');
  });

  it('warns when a corrupt collection was dropped and is being rebuilt (#3202)', async () => {
    workerReportingChroma(chromaState({
      count: 0,
      lastExit: null,
      collectionDrop: {
        collection: 'cm__claude-mem',
        droppedAt: '2026-09-30T10:00:00.000Z',
        documentCount: 48213,
        error: 'Failed to apply logs to the hnsw segment writer',
      },
    }));

    const rows = await probeChromaDiagnostics(WORKER_URL);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Chroma collection', status: 'warn', required: false });
    expect(rows[0].detail).toContain('cm__claude-mem had a corrupt HNSW segment and was dropped at 2026-09-30T10:00:00.000Z (48213 documents)');
    expect(rows[0].detail).toContain('rebuilt from SQLite');
  });

  it('shows no rows for a healthy child, including from an older worker without prewarm state', async () => {
    workerReportingChroma({ ...chromaState({ count: 0, lastExit: null }), prewarm: undefined });

    expect(await probeChromaDiagnostics(WORKER_URL)).toEqual([]);
  });

  it('shows no rows when the worker is unreachable or the endpoint fails', async () => {
    fetchSpy?.mockImplementation(async () => { throw new Error('connection refused'); });
    expect(await probeChromaDiagnostics(WORKER_URL)).toEqual([]);

    workerReportingChroma(chromaState(), 500);
    expect(await probeChromaDiagnostics(WORKER_URL)).toEqual([]);
  });

  it('ignores a missing or malformed admin Chroma payload', async () => {
    workerReportingChroma({ count: 'not-a-number' });
    expect(await probeChromaDiagnostics(WORKER_URL)).toEqual([]);

    workerReportingChroma(chromaState({ prewarm: { consecutiveFailures: 3, state: 'exploded' } }));
    expect(await probeChromaDiagnostics(WORKER_URL)).toEqual([]);

    workerReportingChroma(undefined);
    expect(await probeChromaDiagnostics(WORKER_URL)).toEqual([]);
  });
});

describe.skipIf(process.platform === 'win32')('npx doctor tree-sitter CLI row', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'doctor-tree-sitter-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('checks the executable at the plugin root the worker runs from', async () => {
    const cliDir = join(root, 'node_modules', 'tree-sitter-cli');
    mkdirSync(cliDir, { recursive: true });
    writeFileSync(join(cliDir, 'tree-sitter'), "#!/usr/bin/env node\nprocess.stdout.write('tree-sitter 0.26.8\\n');\n");
    chmodSync(join(cliDir, 'tree-sitter'), 0o755);

    expect(await treeSitterCliCheck(root)).toMatchObject({ name: 'tree-sitter CLI', status: 'ok', required: false });
  });

  function writeCli(dir: string, script: string): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'tree-sitter'), `#!/bin/sh\n${script}\n`);
    chmodSync(join(dir, 'tree-sitter'), 0o755);
  }

  it('warns with the repair hint when the executable is missing', async () => {
    const row = await treeSitterCliCheck(root, join(root, 'empty-path'));
    expect(row).toMatchObject({ status: 'warn', required: false });
    expect(row.detail).toContain('missing at');
    expect(row.detail).toContain('npx claude-mem repair');
    expect(row.detail).toContain('on PATH');
  });

  // #4858: musl has no tree-sitter release build, so the package-local one is
  // missing, but the parser falls back to a working tree-sitter on PATH.
  it('is ok when the package-local executable is missing but a working one is on PATH', async () => {
    const pathDir = join(root, 'path-bin');
    writeCli(pathDir, 'echo "tree-sitter 0.26.9"');

    const row = await treeSitterCliCheck(root, pathDir);
    expect(row).toMatchObject({ status: 'ok', detail: 'tree-sitter on PATH' });
  });

  it('is ok when the package-local executable cannot run but a working one is on PATH', async () => {
    writeCli(join(root, 'node_modules', 'tree-sitter-cli'), "echo 'Error loading shared library' >&2\nexit 127");
    const pathDir = join(root, 'path-bin');
    writeCli(pathDir, 'echo "tree-sitter 0.26.9"');

    const row = await treeSitterCliCheck(root, pathDir);
    expect(row).toMatchObject({ status: 'ok', detail: join(pathDir, 'tree-sitter') });
  });

  it('reports why the package-local executable cannot run when nothing on PATH works', async () => {
    writeCli(join(root, 'node_modules', 'tree-sitter-cli'), "echo 'Error loading shared library' >&2\nexit 127");

    const row = await treeSitterCliCheck(root, join(root, 'empty-path'));
    expect(row.status).toBe('warn');
    expect(row.detail).toContain('Error loading shared library');
  });
});

// `npx claude-mem doctor` runs with npx's own `node_modules/.bin` first on PATH, so the first `claude-mem` there is
// this CLI, not the hook launcher. Hooks run outside npx and find the launcher, so doctor must look past itself.
describe.skipIf(process.platform === 'win32')('npx doctor hook launcher', () => {
  let root: string;
  let npxBin: string;
  let runningCli: string;
  let launcherDir: string;

  function executable(path: string, output: string): void {
    writeFileSync(path, `#!/bin/sh\necho ${output}\n`);
    chmodSync(path, 0o755);
  }

  function host(pathValue: string) {
    return { homeDirectory: root, platform: process.platform, environmentVariables: { PATH: pathValue } };
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'doctor-launcher-'));
    // npx runs packages from npm's cache, `<cache>/_npx/<hash>/node_modules`.
    const cliDir = join(root, '_npx', 'abc123', 'node_modules', 'claude-mem', 'dist', 'npx-cli');
    npxBin = join(root, '_npx', 'abc123', 'node_modules', '.bin');
    launcherDir = join(root, 'local-bin');
    mkdirSync(cliDir, { recursive: true });
    mkdirSync(npxBin, { recursive: true });
    mkdirSync(launcherDir, { recursive: true });
    runningCli = join(cliDir, 'index.js');
    executable(runningCli, '13.41.0');
    symlinkSync('../claude-mem/dist/npx-cli/index.js', join(npxBin, 'claude-mem'));
    executable(join(launcherDir, 'claude-mem'), String(LAUNCHER_PROTOCOL));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('checks the launcher behind its own npx bin, not itself', () => {
    const result = hookLauncherCheck(host(`${npxBin}:${launcherDir}:/usr/bin:/bin`), runningCli);
    expect(result.status).toBe('ok');
    expect(result.detail).toContain(join(launcherDir, 'claude-mem'));
  });

  it('still fails when another claude-mem that is not the launcher comes first', () => {
    const otherDir = join(root, 'other');
    mkdirSync(otherDir);
    executable(join(otherDir, 'claude-mem'), '13.15.0');
    const result = hookLauncherCheck(host(`${otherDir}:${launcherDir}:/usr/bin:/bin`), runningCli);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain(join(otherDir, 'claude-mem'));
  });

  it('still fails when a persistent install of this CLI comes before the launcher', () => {
    // A global `npm i -g claude-mem` is the CLI, not the launcher, and hooks reach it first. Only npx's copy is skipped.
    const globalRoot = join(root, 'npm-global');
    const globalCli = join(globalRoot, 'lib', 'node_modules', 'claude-mem', 'dist', 'npx-cli', 'index.js');
    const globalBin = join(globalRoot, 'bin');
    mkdirSync(join(globalCli, '..'), { recursive: true });
    mkdirSync(globalBin, { recursive: true });
    executable(globalCli, '13.41.0');
    symlinkSync(globalCli, join(globalBin, 'claude-mem'));
    const result = hookLauncherCheck(host(`${globalBin}:${launcherDir}:/usr/bin:/bin`), globalCli);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain(join(globalBin, 'claude-mem'));
  });

    it('reports a missing launcher when the only claude-mem on PATH is itself', () => {
    const result = hookLauncherCheck(host(`${npxBin}:/usr/bin:/bin`), runningCli);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('not on PATH');
  });
});

// The Auto-update row, from fixtures: the state file as the worker and the
// supervisor write it, the install's shape as the notice's checks read it, and
// gates 1 and 2 run through the check's own readAutoUpdateSwitches with
// scripted readers, so the off reasons are the worker's. Nothing here reads
// the real ~/.claude or ~/.claude-mem.
describe('npx doctor Auto-update row', () => {
  const NOW = Date.UTC(2026, 10, 8, 12, 0, 0);
  const MINUTE_MS = 60_000;
  const INSTALLED = '15.12.0';
  const TARGET = '15.13.0';
  const CLAUDE_CONFIG = join('/fixture', '.claude');
  const CACHE_ROOT = join(CLAUDE_CONFIG, 'plugins', 'cache', 'thedotmack', 'claude-mem');
  const MARKETPLACE = join(CLAUDE_CONFIG, 'plugins', 'marketplaces', 'thedotmack');
  const KNOWN_MARKETPLACES = join(CLAUDE_CONFIG, 'plugins', 'known_marketplaces.json');
  const USER_SETTINGS = join(CLAUDE_CONFIG, 'settings.json');
  const STATE_PATH = '/fixture/.claude-mem/auto-update-state.json';
  const LIVE_SUPERVISOR_PID = 4242;
  const DEAD_SUPERVISOR_PID = 4343;
  const RECORDED_DEADLINE_MS = 90 * MINUTE_MS;
  /** A fixed rendering of an instant, minutes from NOW, so every expected line is exact. */
  const at = (epochMs: number): string => `[${(epochMs - NOW) / MINUTE_MS} min]`;
  const HALF_WRITTEN: ClaudeMemInstallShape = { kind: 'looks-half-written', what: `the folder Claude Code loads claude-mem from (${join(CACHE_ROOT, TARGET)}) has no node_modules` };

  const SHIPPED_SETTINGS: AutoUpdateSettings = {
    CLAUDE_MEM_AUTO_UPDATE: 'true',
    CLAUDE_MEM_AUTO_UPDATE_PROMOTED_RELEASE_URL: '',
    CLAUDE_MEM_WORKER_AUTOSTART: 'true',
    CLAUDE_MEM_WORKER_URL: '',
    CLAUDE_MEM_RUNTIME: 'worker',
  };

  /** known_marketplaces.json with claude-mem's entry as the installer writes it, with Claude Code's update off, as the worker leaves it once it has turned it off. */
  const INSTALLERS_ENTRY: ClaudeCodePluginState['knownMarketplaces'] = {
    kind: 'read',
    path: KNOWN_MARKETPLACES,
    document: { thedotmack: { source: { source: 'github', repo: 'thedotmack/claude-mem' }, installLocation: MARKETPLACE, lastUpdated: '2026-11-01T09:30:00.000Z', autoUpdate: false } },
  };

  interface ReaderOptions {
    settings?: Partial<AutoUpdateSettings>;
    env?: NodeJS.ProcessEnv;
    install?: { root: string; version: string | null; missingDependencies: string[] } | null;
    knownMarketplaces?: ClaudeCodePluginState['knownMarketplaces'];
    declarations?: ClaudeMemMarketplaceDeclaration[];
  }

  /** Gates 1 and 2's readers on a standard install at INSTALLED, with these settings, environment and files. */
  function switchReaders(options: ReaderOptions = {}): AutoUpdateSwitchReaders {
    return {
      env: options.env ?? {},
      readSettings: () => ({ ...SHIPPED_SETTINGS, ...options.settings }),
      readClaudeCodeSettingsEnv: () => ({ envBlocks: [], skipped: [], claudeMemMarketplaceDeclarations: options.declarations ?? [] }),
      readClaudeCodePluginState: () => ({
        userSettings: { kind: 'not-disabled' },
        registration: { kind: 'registered', versions: [INSTALLED] },
        knownMarketplaces: options.knownMarketplaces ?? INSTALLERS_ENTRY,
      }),
      resolvePluginRoot: () => (options.install !== undefined ? options.install : { root: join(CACHE_ROOT, INSTALLED), version: INSTALLED, missingDependencies: [] }),
      pluginCacheRootDirectory: () => CACHE_ROOT,
      marketplaceDirectory: () => MARKETPLACE,
    };
  }

  let shapeReads = 0;

  function sources(options: {
    /** The state file's fields; with `noStateFile`, there is none. */
    state?: Partial<AutoUpdateState>;
    noStateFile?: boolean;
    readers?: ReaderOptions;
    installShape?: ClaudeMemInstallShape;
    readStateFile?: AutoUpdateDoctorSources['readStateFile'];
    readSwitches?: AutoUpdateDoctorSources['readSwitches'];
    /** The version the install resolves to; INSTALLED unless an update moved it. */
    installedVersion?: string;
  } = {}): AutoUpdateDoctorSources {
    const readers = switchReaders(options.readers);
    shapeReads = 0;
    return {
      now: NOW,
      readSwitches: options.readSwitches ?? (() => readAutoUpdateSwitches(readers)),
      readClaudeCodeSettingsEnv: readers.readClaudeCodeSettingsEnv,
      readClaudeCodePluginState: readers.readClaudeCodePluginState,
      installedVersion: options.installedVersion ?? INSTALLED,
      statePath: STATE_PATH,
      readStateFile: options.readStateFile ?? (() => ({
        state: { ...defaultAutoUpdateState(), ...structuredClone(options.state ?? {}) },
        exists: options.noStateFile !== true,
        problem: null,
      })),
      readInstallShape: () => { shapeReads++; return options.installShape ?? { kind: 'looks-whole' }; },
      isProcessAlive: (pid) => pid === LIVE_SUPERVISOR_PID,
      formatTime: at,
    };
  }

  /** The decision the worker recorded at a tick 10 minutes ago, worded by the check's own describeAutoUpdateDecision. */
  const recorded = (decision: AutoUpdateDecision): AutoUpdateDecisionRecord => ({
    decision: decision.decision,
    reason: describeAutoUpdateDecision(decision),
    decidedAt: NOW - 10 * MINUTE_MS,
  });
  const UP_TO_DATE = recorded({ decision: 'up-to-date', installedVersion: INSTALLED, promotedVersion: INSTALLED });

  const checked = { lastNetworkCheckAt: NOW - 30 * MINUTE_MS, lastSeenPromotedVersion: INSTALLED, lastDecision: UP_TO_DATE };
  const outcome = (result: AutoUpdateAttemptOutcome['result'], extra: Partial<AutoUpdateAttemptOutcome> = {}): AutoUpdateAttemptOutcome => ({
    result,
    targetVersion: TARGET,
    previousVersion: INSTALLED,
    finishedAt: NOW - 20 * MINUTE_MS,
    ...(result === 'applied' ? {} : { failureStage: 'prove-install' }),
    message: 'what happened',
    ...extra,
  });
  const lines = (detail: string): string[] => detail.split('\n');
  const CLAUDE_CODE_OFF_UNCHANGED = `Claude Code's background update: off (set in ${KNOWN_MARKETPLACES}); claude-mem has not changed it`;
  const WORKED_OUT_HERE = '(worked out by doctor, because the worker has not recorded a decision yet; its environment can differ from this terminal\'s)';

  describe('the status is the worker\'s own last decision', () => {
    it('off by the worker\'s decision, while doctor\'s own environment would say on: the worker\'s, with when it decided', () => {
      const row = autoUpdateCheck(sources({ state: { ...checked, lastDecision: recorded({ decision: 'disabled', reason: 'DISABLE_AUTOUPDATER is set (Claude Code\'s switch for no background updates)' }) } }));
      expect(row).toMatchObject({ name: 'Auto-update', status: 'ok', required: false });
      expect(lines(row.detail)[0]).toBe('Off: DISABLE_AUTOUPDATER is set (Claude Code\'s switch for no background updates) (the worker\'s decision at [-10 min])');
    });

    it('on by the worker\'s decision, while doctor\'s own environment has Claude Code\'s switch set: still the worker\'s', () => {
      const row = autoUpdateCheck(sources({ state: checked, readers: { env: { DISABLE_AUTOUPDATER: '1' } } }));
      expect(lines(row.detail)[0]).toBe(`On: up to date: ${INSTALLED} is installed, and the promoted release is ${INSTALLED} (the worker's decision at [-10 min])`);
    });

    it('up to date: on, with the versions, the last check, the last update and Claude Code\'s update as Claude Code reads it, with what claude-mem did', () => {
      const row = autoUpdateCheck(sources({
        state: { ...checked, lastAttemptOutcome: outcome('applied', { targetVersion: INSTALLED, previousVersion: '15.11.0' }), claudeCodeBackgroundUpdateTurnedOffAt: NOW - 24 * 60 * MINUTE_MS },
      }));
      expect(row.status).toBe('ok');
      expect(lines(row.detail)).toEqual([
        `On: up to date: ${INSTALLED} is installed, and the promoted release is ${INSTALLED} (the worker's decision at [-10 min])`,
        `Installed: ${INSTALLED}`,
        `Promoted: ${INSTALLED}`,
        'Last check: [-30 min]',
        `Last update: 15.11.0 → ${INSTALLED}, applied, [-20 min]`,
        `Claude Code's background update: off (set in ${KNOWN_MARKETPLACES}); claude-mem turned it off at [-1440 min]`,
      ]);
    });

    it('a promoted version that waits, and Claude Code\'s update left on with the reason', () => {
      const row = autoUpdateCheck(sources({
        state: {
          ...checked,
          lastSeenPromotedVersion: TARGET,
          lastDecision: recorded({ decision: 'deferred-busy', promotedVersion: TARGET, busySince: NOW - 60 * MINUTE_MS, observedBusyMs: 60 * MINUTE_MS }),
          claudeCodeBackgroundUpdateLeftOnReason: 'npx is not on the worker\'s PATH',
        },
        readers: { knownMarketplaces: { ...INSTALLERS_ENTRY, document: { thedotmack: { autoUpdate: true } } } as ClaudeCodePluginState['knownMarketplaces'] },
      }));
      expect(row.status).toBe('ok');
      expect(lines(row.detail)[0]).toBe(`On: ${TARGET} waits until claude-mem has had nothing to do for 18 minutes, or has been busy for a full day (the worker's decision at [-10 min])`);
      expect(lines(row.detail)).toContain(`Claude Code's background update: on (set in ${KNOWN_MARKETPLACES}); claude-mem left it on: npx is not on the worker's PATH`);
    });
  });

  describe('after the worker\'s apply, once its attempt has ended: how it ended, never "installing"', () => {
    // The worker records apply before it launches the attempt (gate 9) and no other decision until its next
    // tick; the supervisor replaces the attempt in flight with its outcome, here at [-2 min].
    const afterApply: Partial<AutoUpdateState> = {
      lastNetworkCheckAt: NOW - 10 * MINUTE_MS,
      lastSeenPromotedVersion: TARGET,
      lastDecision: recorded({ decision: 'apply', targetVersion: TARGET, previousVersion: INSTALLED, applyReason: 'quiet' }),
      inFlightAttempt: null,
    };
    const ended = (result: AutoUpdateAttemptOutcome['result'], extra: Partial<AutoUpdateAttemptOutcome> = {}): AutoUpdateAttemptOutcome =>
      outcome(result, { finishedAt: NOW - 2 * MINUTE_MS, ...extra });

    it('applied: updated to the target, and when', () => {
      const row = autoUpdateCheck(sources({ state: { ...afterApply, lastAttemptOutcome: ended('applied') }, installedVersion: TARGET }));
      expect(row.status).toBe('ok');
      expect(lines(row.detail)).toEqual([
        `On: updated to ${TARGET} at [-2 min]`,
        `Installed: ${TARGET}`,
        `Promoted: ${TARGET}`,
        'Last check: [-10 min]',
        `Last update: ${INSTALLED} → ${TARGET}, applied, [-2 min]`,
        CLAUDE_CODE_OFF_UNCHANGED,
      ]);
    });

    it('failed: the last update to the target did not complete, with its stage, and no warning (the installed version still works)', () => {
      const row = autoUpdateCheck(sources({ state: { ...afterApply, lastAttemptOutcome: ended('failed', { failureStage: 'installer-exit' }) } }));
      expect(row.status).toBe('ok');
      expect(lines(row.detail)).toEqual([
        `On: the last update to ${TARGET} did not complete (failed at installer-exit, [-2 min])`,
        `Installed: ${INSTALLED}`,
        `Promoted: ${TARGET}`,
        'Last check: [-10 min]',
        `Last update: ${INSTALLED} → ${TARGET}, failed at installer-exit, [-2 min]`,
        CLAUDE_CODE_OFF_UNCHANGED,
      ]);
    });

    it('restored: did not complete, with its stage, and no warning (the previous version was put back)', () => {
      const row = autoUpdateCheck(sources({ state: { ...afterApply, lastAttemptOutcome: ended('restored', { failureStage: 'prove-install' }) } }));
      expect(row.status).toBe('ok');
      expect(lines(row.detail)).toEqual([
        `On: the last update to ${TARGET} did not complete (restored at prove-install, [-2 min])`,
        `Installed: ${INSTALLED}`,
        `Promoted: ${TARGET}`,
        'Last check: [-10 min]',
        `Last update: ${INSTALLED} → ${TARGET}, restored at prove-install, [-2 min]`,
        CLAUDE_CODE_OFF_UNCHANGED,
      ]);
    });

    it('restore_failed: did not complete, with its stage, under the warning, ending with the fix the outcome recorded', () => {
      const row = autoUpdateCheck(sources({
        state: { ...afterApply, lastAttemptOutcome: ended('restore_failed', { failureStage: 'installer-exit', fixCommand: `npx claude-mem@${INSTALLED} update`, fixCommandWhen: 'now' }) },
      }));
      expect(row.status).toBe('warn');
      expect(lines(row.detail)).toEqual([
        `claude-mem may not work: the automatic update to ${TARGET} failed`,
        `On: the last update to ${TARGET} did not complete (restore_failed at installer-exit, [-2 min])`,
        `Installed: ${INSTALLED}`,
        `Promoted: ${TARGET}`,
        'Last check: [-10 min]',
        `Last update: ${INSTALLED} → ${TARGET}, restore_failed at installer-exit, [-2 min]`,
        CLAUDE_CODE_OFF_UNCHANGED,
        `Fix: run \`npx claude-mem@${INSTALLED} update\`, then restart Claude Code.`,
      ]);
    });
  });

  describe('a launch the worker could not confirm, whose attempt it left in flight', () => {
    // The worker writes nothing after that launch error (auto-update-check.ts gate 9): the file keeps the apply
    // it saved before the launch, and the attempt as the launcher recorded it, no supervisor pid yet.
    it('the apply the worker recorded before the launch, and the attempt in progress, with no warning', () => {
      const row = autoUpdateCheck(sources({
        state: {
          ...checked,
          lastSeenPromotedVersion: TARGET,
          lastDecision: recorded({ decision: 'apply', targetVersion: TARGET, previousVersion: INSTALLED, applyReason: 'quiet' }),
          inFlightAttempt: { targetVersion: TARGET, previousVersion: INSTALLED, startedAt: NOW - 10 * MINUTE_MS, supervisorPid: null, supervisorDeadlineMs: RECORDED_DEADLINE_MS },
        },
      }));
      expect(row.status).toBe('ok');
      expect(lines(row.detail)[0]).toBe(`On: installing ${TARGET} (from ${INSTALLED}) (the worker's decision at [-10 min])`);
      expect(lines(row.detail)).toContain(`In progress: ${INSTALLED} → ${TARGET}, started [-10 min]`);
    });
  });

  describe('worked out by doctor while the worker has recorded no decision, saying so', () => {
    it('no state file: no check has run here yet, and an older install needs one update by hand', () => {
      const row = autoUpdateCheck(sources({ noStateFile: true }));
      expect(row.status).toBe('ok');
      expect(lines(row.detail)).toEqual([
        `On ${WORKED_OUT_HERE}`,
        `Installed: ${INSTALLED}`,
        'No auto-update check has run on this machine yet. An install from before the first release with auto-update needs one `npx claude-mem update` by hand.',
        CLAUDE_CODE_OFF_UNCHANGED,
      ]);
    });

    it('off by a setting: the reason the worker\'s own gate gives', () => {
      const row = autoUpdateCheck(sources({ readers: { settings: { CLAUDE_MEM_AUTO_UPDATE: 'false' } } }));
      expect(row.status).toBe('ok');
      expect(lines(row.detail)).toEqual([
        `Off: CLAUDE_MEM_AUTO_UPDATE=false ${WORKED_OUT_HERE}`,
        `Installed: ${INSTALLED}`,
        'Promoted: not seen yet',
        'Last check: never',
        'Last update: none yet',
        CLAUDE_CODE_OFF_UNCHANGED,
      ]);
    });

    it('off by Claude Code\'s switch in the environment doctor runs in', () => {
      expect(lines(autoUpdateCheck(sources({ readers: { env: { DISABLE_AUTOUPDATER: '1' } } })).detail)[0])
        .toBe(`Off: DISABLE_AUTOUPDATER is set (Claude Code's switch for no background updates) ${WORKED_OUT_HERE}`);
    });

    it('off because no install was found', () => {
      expect(lines(autoUpdateCheck(sources({ readers: { install: null } })).detail)[0]).toBe(`Off: no claude-mem install was found ${WORKED_OUT_HERE}`);
    });

    it('off because the install is not a standard one (a source checkout or an override)', () => {
      const checkout = join('/fixture', 'claude-mem-checkout', 'plugin');
      expect(lines(autoUpdateCheck(sources({ readers: { install: { root: checkout, version: TARGET, missingDependencies: [] } } })).detail)[0])
        .toBe(`Off: ${checkout} is not in Claude Code's plugin cache or marketplace folder (a source checkout or an override), so it is left alone ${WORKED_OUT_HERE}`);
    });

    it('off because the installed version cannot be compared', () => {
      const root = join(MARKETPLACE, 'plugin');
      expect(lines(autoUpdateCheck(sources({ readers: { install: { root, version: 'dev', missingDependencies: [] } } })).detail)[0])
        .toBe(`Off: the version installed at ${root} (dev) is not one claude-mem can compare ${WORKED_OUT_HERE}`);
      expect(lines(autoUpdateCheck(sources({ readers: { install: { root, version: null, missingDependencies: [] } } })).detail)[0])
        .toBe(`Off: the version installed at ${root} (none recorded) is not one claude-mem can compare ${WORKED_OUT_HERE}`);
    });

    it('a settings file the check cannot read: off until it is fixed, as the worker\'s tick stops there too, and no warning', () => {
      const row = autoUpdateCheck(sources({
        readSwitches: () => { throw new Error('/fixture/.claude-mem/settings.json exists but cannot be read as settings: JSON Parse error'); },
      }));
      expect(row.status).toBe('ok');
      expect(lines(row.detail)[0]).toBe('Off until this is fixed: /fixture/.claude-mem/settings.json exists but cannot be read as settings: JSON Parse error');
    });
  });

  describe('warnings only when the person needs to act', () => {
    it('failed: information with its stage, no warning and no fix line (the installed version still works)', () => {
      const row = autoUpdateCheck(sources({ state: { ...checked, lastAttemptOutcome: outcome('failed', { failureStage: 'installer-exit' }) } }));
      expect(row.status).toBe('ok');
      expect(lines(row.detail)).toContain(`Last update: ${INSTALLED} → ${TARGET}, failed at installer-exit, [-20 min]`);
      expect(row.detail).not.toContain('Fix:');
    });

    it('restore_failed not resolved: a warning, and the fix the outcome recorded, never one rebuilt from the previous version', () => {
      const row = autoUpdateCheck(sources({
        state: {
          ...checked,
          lastSeenPromotedVersion: TARGET,
          // A recorded fix that differs from what `npx claude-mem@<previousVersion> update` would build, so building it again is caught.
          lastAttemptOutcome: outcome('restore_failed', { failureStage: 'installer-exit', message: 'Run: npx claude-mem@9.9.9 update', fixCommand: `npx claude-mem@${TARGET} update`, fixCommandWhen: 'now' }),
        },
      }));
      expect(row.status).toBe('warn');
      expect(lines(row.detail)).toEqual([
        `claude-mem may not work: the automatic update to ${TARGET} failed`,
        `On: up to date: ${INSTALLED} is installed, and the promoted release is ${INSTALLED} (the worker's decision at [-10 min])`,
        `Installed: ${INSTALLED}`,
        `Promoted: ${TARGET}`,
        'Last check: [-30 min]',
        `Last update: ${INSTALLED} → ${TARGET}, restore_failed at installer-exit, [-20 min]`,
        CLAUDE_CODE_OFF_UNCHANGED,
        `Fix: run \`npx claude-mem@${TARGET} update\`, then restart Claude Code.`,
      ]);
    });

    it('restore_failed blocked by the schema: the whole instruction, the command and when to run it', () => {
      const row = autoUpdateCheck(sources({
        state: { ...checked, lastAttemptOutcome: outcome('restore_failed', { failureStage: 'restore-blocked-by-schema', fixCommand: AUTO_UPDATE_FORWARD_FIX_COMMAND, fixCommandWhen: 'once-a-release-newer-than-the-target-is-out' }) },
      }));
      expect(lines(row.detail).at(-1)).toBe(`Fix: once a claude-mem release newer than ${TARGET} is out, run \`npx claude-mem@latest update\`, then restart Claude Code.`);
    });

    it('restore_failed with the installer still running: the fix, for once that update has finished', () => {
      const row = autoUpdateCheck(sources({
        state: { ...checked, lastAttemptOutcome: outcome('restore_failed', { failureStage: 'installer-still-running', fixCommand: `npx claude-mem@${INSTALLED} update`, fixCommandWhen: 'once-the-running-update-has-finished' }) },
      }));
      expect(lines(row.detail).at(-1)).toBe(`Fix: once the update that is still running has finished, run \`npx claude-mem@${INSTALLED} update\`, then restart Claude Code.`);
    });

    it('restore_failed resolved by a ready worker: no warning and no fix line, with the worker\'s version and when', () => {
      const row = autoUpdateCheck(sources({
        state: {
          ...checked,
          lastAttemptOutcome: outcome('restore_failed', { fixCommand: `npx claude-mem@${TARGET} update`, resolvedAt: NOW - 5 * MINUTE_MS, resolvedWithWorkerVersion: INSTALLED }),
        },
      }));
      expect(row.status).toBe('ok');
      expect(lines(row.detail)).toContain(`Last update: ${INSTALLED} → ${TARGET}, restore_failed at prove-install, [-20 min]; fixed: a worker on ${INSTALLED} finished starting at [-5 min]`);
      expect(row.detail).not.toContain('Fix:');
      expect(row.detail).not.toContain('may not work');
    });

    it('restored: no warning, the install works', () => {
      expect(autoUpdateCheck(sources({ state: { ...checked, lastAttemptOutcome: outcome('restored') } })).status).toBe('ok');
    });

    it('the last check failed while the updater is on: a warning with its message', () => {
      const row = autoUpdateCheck(sources({
        state: {
          ...checked,
          lastDecision: recorded({ decision: 'check-failed', stage: 'fetch-promoted-release', message: 'HTTP 503' }),
          lastCheckError: { at: NOW - 30 * MINUTE_MS, message: 'https://raw.githubusercontent.com/thedotmack/claude-mem/main/releases/promoted-release.json: HTTP 503' },
        },
      }));
      expect(row.status).toBe('warn');
      expect(lines(row.detail).slice(0, 2)).toEqual([
        'The last update check failed: https://raw.githubusercontent.com/thedotmack/claude-mem/main/releases/promoted-release.json: HTTP 503',
        'On: the last check could not read the promoted release file (the worker\'s decision at [-10 min])',
      ]);
    });

    it('an old check error while the updater is off: no warning', () => {
      const row = autoUpdateCheck(sources({
        state: {
          ...checked,
          lastDecision: recorded({ decision: 'disabled', reason: 'CLAUDE_MEM_AUTO_UPDATE=false' }),
          lastCheckError: { at: NOW - 3 * 24 * 60 * MINUTE_MS, message: 'HTTP 503' },
        },
      }));
      expect(row.status).toBe('ok');
      expect(row.detail).not.toContain('The last update check failed');
    });

    it('an update cut off whose supervisor is gone, on an install that looks half-written: the warning, what looks half-written, and the target\'s own installer', () => {
      const row = autoUpdateCheck(sources({
        state: {
          ...checked,
          inFlightAttempt: { targetVersion: TARGET, previousVersion: INSTALLED, startedAt: NOW - 3 * MINUTE_MS, supervisorPid: DEAD_SUPERVISOR_PID, supervisorDeadlineMs: RECORDED_DEADLINE_MS },
        },
        installShape: HALF_WRITTEN,
      }));
      expect(row.status).toBe('warn');
      expect(lines(row.detail)[0]).toBe(`claude-mem may not work: the automatic update to ${TARGET} did not finish (${HALF_WRITTEN.what})`);
      expect(lines(row.detail)).toContain(`Interrupted: ${INSTALLED} → ${TARGET}, started [-3 min]; the worker records how it ended at its next check`);
      expect(lines(row.detail).at(-1)).toBe(`Fix: run \`npx claude-mem@${TARGET} update\`, then restart Claude Code.`);
    });

    it('the same, on an install that looks whole: no warning, only the attempt as information', () => {
      const row = autoUpdateCheck(sources({
        state: { ...checked, inFlightAttempt: { targetVersion: TARGET, previousVersion: INSTALLED, startedAt: NOW - 3 * MINUTE_MS, supervisorPid: DEAD_SUPERVISOR_PID, supervisorDeadlineMs: RECORDED_DEADLINE_MS } },
      }));
      expect(row.status).toBe('ok');
      expect(lines(row.detail)).toContain(`Interrupted: ${INSTALLED} → ${TARGET}, started [-3 min]; the worker records how it ended at its next check`);
      expect(row.detail).not.toContain('Fix:');
    });

    it('interrupted, then fixed: the attempt with the worker that has since finished starting, and no warning', () => {
      const row = autoUpdateCheck(sources({
        state: {
          ...checked,
          inFlightAttempt: {
            targetVersion: TARGET, previousVersion: INSTALLED, startedAt: NOW - 120 * MINUTE_MS, supervisorPid: DEAD_SUPERVISOR_PID, supervisorDeadlineMs: RECORDED_DEADLINE_MS,
            resolvedAt: NOW - 2 * MINUTE_MS, resolvedWithWorkerVersion: TARGET,
          },
        },
        installShape: HALF_WRITTEN,
      }));
      expect(row.status).toBe('ok');
      expect(lines(row.detail)).toContain(`Interrupted: ${INSTALLED} → ${TARGET}, started [-120 min]; fixed: a worker on ${TARGET} finished starting at [-2 min]`);
      expect(shapeReads).toBe(0);
    });

    it('never started: the attempt, for the worker to record, and no warning on an install that looks whole', () => {
      const row = autoUpdateCheck(sources({
        state: { ...checked, inFlightAttempt: { targetVersion: TARGET, previousVersion: INSTALLED, startedAt: NOW - 120 * MINUTE_MS, supervisorPid: null, supervisorDeadlineMs: RECORDED_DEADLINE_MS } },
      }));
      expect(row.status).toBe('ok');
      expect(lines(row.detail)).toContain(`Never started: ${INSTALLED} → ${TARGET}, started [-120 min]; the worker records it at its next check`);
    });

    it('an update running now: in progress, and no warning or fix while its supervisor works, the install not even read', () => {
      const row = autoUpdateCheck(sources({
        state: {
          ...checked,
          lastDecision: recorded({ decision: 'apply', targetVersion: '15.14.0', previousVersion: INSTALLED, applyReason: 'quiet' }),
          lastAttemptOutcome: outcome('restore_failed', { fixCommand: `npx claude-mem@${INSTALLED} update` }),
          inFlightAttempt: { targetVersion: '15.14.0', previousVersion: INSTALLED, startedAt: NOW - 3 * MINUTE_MS, supervisorPid: LIVE_SUPERVISOR_PID, supervisorDeadlineMs: RECORDED_DEADLINE_MS },
        },
        installShape: HALF_WRITTEN,
      }));
      expect(row.status).toBe('ok');
      expect(lines(row.detail)[0]).toBe(`On: installing 15.14.0 (from ${INSTALLED}) (the worker's decision at [-10 min])`);
      expect(lines(row.detail)).toContain(`In progress: ${INSTALLED} → 15.14.0, started [-3 min]`);
      expect(row.detail).not.toContain('Fix:');
      expect(shapeReads).toBe(0);
    });

    it('no promoted version seen yet', () => {
      const row = autoUpdateCheck(sources({ state: { lastDecision: recorded({ decision: 'check-failed', stage: 'fetch-promoted-release', message: 'offline' }) } }));
      expect(lines(row.detail)).toContain('Promoted: not seen yet');
      expect(lines(row.detail)).toContain('Last check: never');
    });

    it('a state file with a problem: said as information, the rest read as the defaults', () => {
      const row = autoUpdateCheck(sources({ readStateFile: () => ({ state: defaultAutoUpdateState(), exists: true, problem: { kind: 'invalid-fields', invalidFields: ['lastAttemptOutcome'] } }) }));
      expect(row.status).toBe('ok');
      expect(lines(row.detail)[1]).toBe(`${STATE_PATH} has invalid fields (lastAttemptOutcome), so they read as the defaults until the next save replaces them`);
    });

    it('a state file that cannot be read: said as information, and the facts it holds left out', () => {
      const row = autoUpdateCheck(sources({ readStateFile: () => { throw new Error('EACCES: permission denied'); } }));
      expect(row.status).toBe('ok');
      expect(lines(row.detail)).toEqual([`On ${WORKED_OUT_HERE}`, `Cannot read ${STATE_PATH}: EACCES: permission denied`, `Installed: ${INSTALLED}`, 'Claude Code\'s background update: off (set in /fixture/.claude/plugins/known_marketplaces.json)']);
    });
  });

  describe('Claude Code\'s background update, as Claude Code reads it now', () => {
    const claudeCodeLine = (readers: ReaderOptions, state: Partial<AutoUpdateState> = checked) =>
      lines(autoUpdateCheck(sources({ state, readers })).detail).find((line) => line.startsWith('Claude Code\'s background update'));

    it('an extraKnownMarketplaces declaration outranks known_marketplaces.json, here an entry with it off', () => {
      expect(claudeCodeLine({ declarations: [{ path: USER_SETTINGS, autoUpdate: true }] }))
        .toBe(`Claude Code's background update: on (set in extraKnownMarketplaces in ${USER_SETTINGS}); claude-mem has not changed it`);
    });

    it('an entry with no autoUpdate: off by Claude Code\'s default', () => {
      expect(claudeCodeLine({ knownMarketplaces: { kind: 'read', path: KNOWN_MARKETPLACES, document: { thedotmack: { installLocation: MARKETPLACE } } } }))
        .toBe('Claude Code\'s background update: off (nothing sets it, and Claude Code\'s default for a marketplace it does not ship is off); claude-mem has not changed it');
    });

    it('no entry: the marketplace is not registered there', () => {
      expect(claudeCodeLine({ knownMarketplaces: { kind: 'read', path: KNOWN_MARKETPLACES, document: null } }))
        .toBe(`Claude Code's background update: off (the thedotmack marketplace is not registered in ${KNOWN_MARKETPLACES}); claude-mem has not changed it`);
    });

    it('a known_marketplaces.json that cannot be read: said so', () => {
      expect(claudeCodeLine({ knownMarketplaces: { kind: 'unreadable', path: KNOWN_MARKETPLACES, problem: `${KNOWN_MARKETPLACES} is not valid JSON` } }))
        .toBe(`Claude Code's background update: cannot be read (${KNOWN_MARKETPLACES} is not valid JSON); claude-mem has not changed it`);
    });
  });
});

describe('npx doctor observerProviderCheck (#5359)', () => {
  it('passes when configured for claude and Claude CLI is detected', () => {
    const res = observerProviderCheck({
      provider: 'claude',
      claudeDetected: true,
      detectedClaudeVersion: '2.1.316',
      codexDetected: false,
    });
    expect(res).toMatchObject({
      name: 'Observer provider',
      status: 'ok',
      required: false,
    });
    expect(res.detail).toContain('claude (Claude Code v2.1.316)');
  });

  it('warns when configured for claude and Claude CLI is missing but Codex CLI is detected on PATH', () => {
    const res = observerProviderCheck({
      provider: 'claude',
      claudeDetected: false,
      codexDetected: true,
      codexOnPath: true,
    });
    expect(res).toMatchObject({
      name: 'Observer provider',
      status: 'warn',
      required: false,
    });
    expect(res.detail).toContain('Claude CLI not found on PATH or at CLAUDE_CODE_PATH');
    expect(res.detail).toContain('Codex CLI is available — set CLAUDE_MEM_PROVIDER to codex in ~/.claude-mem/settings.json');
  });

  it('warns with CLAUDE_MEM_CODEX_PATH when Codex is detected at an off-PATH bundle location', () => {
    const res = observerProviderCheck({
      provider: 'claude',
      claudeDetected: false,
      codexDetected: true,
      codexOnPath: false,
      codexPath: '/Applications/Codex.app/Contents/Resources/codex',
    });
    expect(res).toMatchObject({
      name: 'Observer provider',
      status: 'warn',
      required: false,
    });
    expect(res.detail).toContain('set CLAUDE_MEM_PROVIDER to codex and CLAUDE_MEM_CODEX_PATH to "/Applications/Codex.app/Contents/Resources/codex"');
  });

  it('warns when configured for claude and neither Claude nor Codex is detected', () => {
    const res = observerProviderCheck({
      provider: 'claude',
      claudeDetected: false,
      codexDetected: false,
    });
    expect(res).toMatchObject({
      name: 'Observer provider',
      status: 'warn',
      required: false,
    });
    expect(res.detail).toContain('Claude CLI not found on PATH or at CLAUDE_CODE_PATH');
  });

  it('passes when configured for codex and Codex CLI is on PATH', () => {
    const res = observerProviderCheck({
      provider: 'codex',
      claudeDetected: false,
      codexDetected: true,
      codexOnPath: true,
    });
    expect(res).toMatchObject({
      name: 'Observer provider',
      status: 'ok',
      required: false,
    });
    expect(res.detail).toContain('codex (Codex CLI available)');
  });

  it('warns when configured for codex without path override and codex is only in app bundle', () => {
    const res = observerProviderCheck({
      provider: 'codex',
      claudeDetected: false,
      codexDetected: true,
      codexOnPath: false,
      codexPath: '/Applications/Codex.app/Contents/Resources/codex',
    });
    expect(res).toMatchObject({
      name: 'Observer provider',
      status: 'warn',
      required: false,
    });
    expect(res.detail).toContain('codex is not on PATH. Found at /Applications/Codex.app/Contents/Resources/codex');
    expect(res.detail).toContain('set CLAUDE_MEM_CODEX_PATH to "/Applications/Codex.app/Contents/Resources/codex"');
  });

  it('handles explicit CLAUDE_MEM_CODEX_PATH configured', () => {
    const ok = observerProviderCheck({
      provider: 'codex',
      claudeDetected: false,
      codexDetected: true,
      codexPath: '/opt/custom/codex',
      configuredCodexPath: '/opt/custom/codex',
    });
    expect(ok.status).toBe('ok');
    expect(ok.detail).toBe('codex (/opt/custom/codex)');

    const missing = observerProviderCheck({
      provider: 'codex',
      claudeDetected: false,
      codexDetected: false,
      configuredCodexPath: '/nonexistent/codex',
    });
    expect(missing.status).toBe('warn');
    expect(missing.detail).toContain('CLAUDE_MEM_CODEX_PATH "/nonexistent/codex" is missing or not executable');

    const tilde = observerProviderCheck({
      provider: 'codex',
      claudeDetected: false,
      codexDetected: false,
      configuredCodexPath: '~/bin/codex',
    });
    expect(tilde.status).toBe('warn');
    expect(tilde.detail).toContain('starts with ~, which the worker does not expand');
  });

  it('warns when configured for codex and Codex CLI is missing completely', () => {
    const res = observerProviderCheck({
      provider: 'codex',
      claudeDetected: false,
      codexDetected: false,
    });
    expect(res).toMatchObject({
      name: 'Observer provider',
      status: 'warn',
      required: false,
    });
    expect(res.detail).toContain('codex configured, but Codex CLI not found on PATH or at CLAUDE_MEM_CODEX_PATH');
  });

  it('validates openrouter provider with and without API key', () => {
    const withKey = observerProviderCheck({
      provider: 'openrouter',
      claudeDetected: false,
      codexDetected: false,
      hasOpenRouterKey: true,
    });
    expect(withKey.status).toBe('ok');
    expect(withKey.detail).toContain('API key configured');

    const withoutKey = observerProviderCheck({
      provider: 'openrouter',
      claudeDetected: false,
      codexDetected: false,
      hasOpenRouterKey: false,
    });
    expect(withoutKey.status).toBe('warn');
    expect(withoutKey.detail).toContain('no API key configured');
  });

  it('validates gemini provider with and without API key', () => {
    const withKey = observerProviderCheck({
      provider: 'gemini',
      claudeDetected: false,
      codexDetected: false,
      hasGeminiKey: true,
    });
    expect(withKey.status).toBe('ok');
    expect(withKey.detail).toContain('API key configured');

    const withoutKey = observerProviderCheck({
      provider: 'gemini',
      claudeDetected: false,
      codexDetected: false,
      hasGeminiKey: false,
    });
    expect(withoutKey.status).toBe('warn');
    expect(withoutKey.detail).toContain('no API key configured');
  });

  it('validates openai-compatible provider configurations (#5359)', () => {
    const noEndpoint = observerProviderCheck({
      provider: 'openai-compatible',
      claudeDetected: false,
      codexDetected: false,
      openaiCompat: {
        hasEndpoint: false,
        hasModel: false,
        hasKey: false,
        requiresKey: false,
      },
    });
    expect(noEndpoint.status).toBe('warn');
    expect(noEndpoint.detail).toContain('no endpoint URL or preset is set');

    const noModel = observerProviderCheck({
      provider: 'openai-compatible',
      claudeDetected: false,
      codexDetected: false,
      openaiCompat: {
        hasEndpoint: true,
        hasModel: false,
        hasKey: false,
        requiresKey: false,
        endpointUrl: 'https://integrate.api.nvidia.com/v1',
      },
    });
    expect(noModel.status).toBe('warn');
    expect(noModel.detail).toContain('no model is configured');

    const missingKey = observerProviderCheck({
      provider: 'openai-compatible',
      claudeDetected: false,
      codexDetected: false,
      openaiCompat: {
        hasEndpoint: true,
        hasModel: true,
        hasKey: false,
        requiresKey: true,
        endpointUrl: 'https://integrate.api.nvidia.com/v1',
        model: 'nvidia/nemotron-3.5',
      },
    });
    expect(missingKey.status).toBe('warn');
    expect(missingKey.detail).toContain('required API key is missing');

    const validRemote = observerProviderCheck({
      provider: 'openai-compatible',
      claudeDetected: false,
      codexDetected: false,
      openaiCompat: {
        hasEndpoint: true,
        hasModel: true,
        hasKey: true,
        requiresKey: true,
        endpointUrl: 'https://integrate.api.nvidia.com/v1',
        model: 'nvidia/nemotron-3.5',
      },
    });
    expect(validRemote.status).toBe('ok');
    expect(validRemote.detail).toBe('openai-compatible (nvidia/nemotron-3.5 via https://integrate.api.nvidia.com/v1)');

    const validLocalNoKey = observerProviderCheck({
      provider: 'openai-compatible',
      claudeDetected: false,
      codexDetected: false,
      openaiCompat: {
        hasEndpoint: true,
        hasModel: true,
        hasKey: false,
        requiresKey: false,
        endpointUrl: 'http://localhost:11434/v1',
        model: 'llama3',
      },
    });
    expect(validLocalNoKey.status).toBe('ok');
    expect(validLocalNoKey.detail).toBe('openai-compatible (llama3 via http://localhost:11434/v1)');
  });

  it('warns when provider value is unrecognized', () => {
    const unknown = observerProviderCheck({
      provider: 'unsupported-llm',
      claudeDetected: false,
      codexDetected: false,
    });
    expect(unknown.status).toBe('warn');
    expect(unknown.detail).toContain('Unknown provider "unsupported-llm"');
  });
});

describe('npx doctor probeWorkerDependencies (#5359)', () => {
  beforeEach(() => {
    requestedUrls = [];
    fetchSpy = spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    fetchSpy = null;
  });

  it('surfaces worker claude_cli setup_required with Codex alternative when codex is installed on PATH', async () => {
    workerReportingDependencies({
      degraded: true,
      statuses: [
        {
          dependency: 'claude_cli',
          kind: 'setup_required',
          message: 'Claude executable not found',
          remediation: 'Install Claude Code CLI',
        },
      ],
    });

    const rows = await probeWorkerDependencies(WORKER_URL, true, true);

    expect(requestedUrls).toEqual([`${WORKER_URL}/api/admin/doctor`]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: 'Claude CLI setup',
      status: 'warn',
      required: false,
    });
    expect(rows[0].detail).toContain('Claude executable not found');
    expect(rows[0].detail).toContain('Codex CLI is installed; you can switch by setting CLAUDE_MEM_PROVIDER to codex');
    expect(rows[0].detail).toContain('Install Claude Code CLI');
  });

  it('surfaces worker claude_cli setup_required with explicit CLAUDE_MEM_CODEX_PATH when codex is off PATH', async () => {
    workerReportingDependencies({
      degraded: true,
      statuses: [
        {
          dependency: 'claude_cli',
          kind: 'setup_required',
          message: 'Claude executable not found',
          remediation: 'Install Claude Code CLI',
        },
      ],
    });

    const rows = await probeWorkerDependencies(WORKER_URL, true, false, '/Applications/Codex.app/Contents/Resources/codex');
    expect(rows[0].detail).toContain('Codex CLI is installed at /Applications/Codex.app/Contents/Resources/codex');
    expect(rows[0].detail).toContain('CLAUDE_MEM_CODEX_PATH to "/Applications/Codex.app/Contents/Resources/codex"');
  });

  it('surfaces worker claude_cli setup_required without Codex alternative when codex is not installed', async () => {
    workerReportingDependencies({
      degraded: true,
      statuses: [
        {
          dependency: 'claude_cli',
          kind: 'setup_required',
          message: 'Claude executable not found',
          remediation: 'Install Claude Code CLI',
        },
      ],
    });

    const rows = await probeWorkerDependencies(WORKER_URL, false);
    expect(rows[0].detail).toContain('Claude executable not found');
    expect(rows[0].detail).not.toContain('Codex CLI is installed');
  });

  it('surfaces codex_cli, uvx, and chroma degraded statuses', () => {
    const statuses = [
      { dependency: 'codex_cli', kind: 'setup_required', message: 'Codex CLI missing', remediation: 'codex login' },
      { dependency: 'uvx', kind: 'vector_search_unavailable', message: 'uvx not on PATH', remediation: 'brew install uv' },
      { dependency: 'chroma', kind: 'vector_search_unavailable', message: 'port in use', remediation: 'stop worker' },
      { dependency: 'observer_dir', kind: 'setup_required', message: 'directory not writable', remediation: 'chmod' },
    ];

    const rows = workerDependencyChecks(statuses);
    expect(rows).toHaveLength(4);
    expect(rows.map(r => r.name)).toEqual([
      'Codex CLI setup',
      'uvx (vector search)',
      'Chroma vector search',
      'Observer data directory',
    ]);
    expect(rows.every(r => r.status === 'warn' && !r.required)).toBe(true);
  });

  it('returns no checks when worker dependencies are healthy', async () => {
    workerReportingDependencies({ degraded: false, statuses: [] });
    expect(await probeWorkerDependencies(WORKER_URL, true)).toEqual([]);
  });

  it('returns no checks when worker endpoint errors or fails', async () => {
    workerReportingDependencies({}, 500);
    expect(await probeWorkerDependencies(WORKER_URL, true)).toEqual([]);

    fetchSpy?.mockImplementation(async () => { throw new Error('network down'); });
    expect(await probeWorkerDependencies(WORKER_URL, true)).toEqual([]);
  });
});
