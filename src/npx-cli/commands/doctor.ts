/**
 * `npx claude-mem doctor` — a minimal diagnostic that probes every layer an
 * operator would otherwise check by hand (#2548). Read-only: it never mutates
 * state. Exits 0 when all REQUIRED checks pass, 1 otherwise, so it is CI/script
 * friendly.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { styleText } from 'node:util';
import { IS_WINDOWS, marketplaceDirectory, readPluginVersion } from '../utils/paths.js';
import { resolvePluginRoot, type PluginRootResolution } from '../../shared/worker-utils.js';
import {
  getBunVersion,
  getUvVersion,
  isInstallCurrent,
  isTreeSitterCliBinaryUsable,
  treeSitterCliBinaryPath,
} from '../install/setup-runtime.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { resolveDataDir } from '../../shared/paths.js';
import { paths } from '../../shared/paths.js';
import { findOrphanedChromaRoots, readProcessTablePosix } from '../../supervisor/orphan-chroma-sweep.js';
import { isPidAlive } from '../../supervisor/process-registry.js';
import { checkWindowsGitBash } from '../utils/windows-git-bash-preflight.js';

type CheckStatus = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  /** When false, a 'fail' does not affect the overall exit code. */
  required: boolean;
}

/** The worker's `health.chroma` block from /api/admin/doctor. */
interface ChromaCrashState {
  count: number;
  lastExit: {
    timestamp: string;
    code: number | null;
    signal: string | null;
  } | null;
  chromaMcpVersion: string;
  dependencyOverrides: string[];
  /** uvx prewarm circuit breaker (#4108); absent from older workers. */
  prewarm?: {
    consecutiveFailures: number;
    state: 'ok' | 'paused' | 'stopped';
  };
  /** A collection dropped as corrupt and rebuilt from SQLite (#3202); absent from older workers. */
  collectionDrop?: {
    collection: string;
    droppedAt: string;
    documentCount: number | null;
    error: string;
  } | null;
}

function probeVersion(bin: 'bun' | 'uv'): string | null {
  try {
    return bin === 'bun' ? getBunVersion() : getUvVersion();
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.warn(`[doctor] Failed to probe \`${bin} --version\`:`, err);
    return null;
  }
}

async function probeWorkerHealth(workerHost: string, workerPort: string): Promise<{
  status: CheckStatus;
  detail: string;
  workerUrl: string;
}> {
  const workerUrl = `http://${workerHost}:${workerPort}`;
  const res = await fetch(`${workerUrl}/api/health`, {
    signal: AbortSignal.timeout(3000),
  });
  if (res.ok) {
    return { status: 'ok', detail: `healthy at ${workerUrl}`, workerUrl };
  }
  return { status: 'warn', detail: `reachable but unhealthy (HTTP ${res.status}) at ${workerUrl}`, workerUrl };
}

function isChromaCrashState(value: unknown): value is ChromaCrashState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<ChromaCrashState>;
  return typeof state.count === 'number' && Number.isInteger(state.count) && state.count >= 0 && Array.isArray(state.dependencyOverrides)
    && typeof state.chromaMcpVersion === 'string'
    && (state.lastExit === null || (typeof state.lastExit === 'object' && state.lastExit !== null
      && typeof state.lastExit.timestamp === 'string'
      && (typeof state.lastExit.code === 'number' || state.lastExit.code === null)
      && (typeof state.lastExit.signal === 'string' || state.lastExit.signal === null)))
    && (state.prewarm === undefined || (typeof state.prewarm === 'object' && state.prewarm !== null
      && typeof state.prewarm.consecutiveFailures === 'number'
      && ['ok', 'paused', 'stopped'].includes(state.prewarm.state)))
    && (state.collectionDrop === undefined || state.collectionDrop === null
      || (typeof state.collectionDrop === 'object'
        && typeof state.collectionDrop.collection === 'string'
        && typeof state.collectionDrop.droppedAt === 'string'
        && (typeof state.collectionDrop.documentCount === 'number' || state.collectionDrop.documentCount === null)));
}

/**
 * The direct child is uvx, not python, so a crash in chroma-mcp (e.g. a
 * SIGSEGV in the engine) usually reaches the worker as uvx's exit code; a
 * signal only shows when uvx itself was killed.
 */
function describeChromaExit(lastExit: NonNullable<ChromaCrashState['lastExit']>): string {
  return lastExit.signal ? `signal ${lastExit.signal}` : `exit code ${lastExit.code ?? 'unknown'}`;
}

/**
 * Warn rows from the worker's /api/admin/doctor `health.chroma` block. These
 * are optional: any failure yields no rows and never changes the worker's
 * own status.
 */
export async function probeChromaDiagnostics(workerUrl: string): Promise<CheckResult[]> {
  try {
    const response = await fetch(`${workerUrl}/api/admin/doctor`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      return [];
    }
    const diagnostics = await response.json() as { health?: { chroma?: unknown } };
    const chroma = diagnostics?.health?.chroma;
    return isChromaCrashState(chroma) ? chromaDiagnosticChecks(chroma) : [];
  } catch {
    // Diagnostics are optional and must not change worker health status.
    return [];
  }
}

/** Warn rows for the worker's Chroma child exits and prewarm breaker, if any. */
function chromaDiagnosticChecks(chroma: ChromaCrashState): CheckResult[] {
  const checks: CheckResult[] = [];
  if (chroma.count > 0 && chroma.lastExit) {
    checks.push({
      name: 'Chroma child exits',
      status: 'warn',
      detail: `${chroma.count} unexpected exit(s) since the worker started, last by ${describeChromaExit(chroma.lastExit)} at ${chroma.lastExit.timestamp}; chroma-mcp ${chroma.chromaMcpVersion}; overrides: ${chroma.dependencyOverrides.join(', ')}`,
      required: false,
    });
  }
  if (chroma.prewarm && chroma.prewarm.state !== 'ok') {
    checks.push({
      name: 'Chroma prewarm',
      status: 'warn',
      detail: chroma.prewarm.state === 'stopped'
        ? `stopped after ${chroma.prewarm.consecutiveFailures} consecutive uvx failures — fix uv or free disk space, then run \`npx claude-mem restart\``
        : `paused after ${chroma.prewarm.consecutiveFailures} consecutive uvx failures; retrying with a growing cooldown`,
      required: false,
    });
  }
  if (chroma.collectionDrop) {
    const drop = chroma.collectionDrop;
    checks.push({
      name: 'Chroma collection',
      status: 'warn',
      detail: `${drop.collection} had a corrupt HNSW segment and was dropped at ${drop.droppedAt} (${drop.documentCount ?? 'unknown'} documents); it is being rebuilt from SQLite, so semantic search results are incomplete until that finishes`,
      required: false,
    });
  }
  return checks;
}

async function probeChromaCensus(): Promise<CheckResult> {
  const name = 'Chroma processes';
  if (IS_WINDOWS) {
    return { name, status: 'ok', detail: 'not checked on Windows', required: false };
  }
  let registered = 0;
  try {
    const registryPath = paths.supervisorRegistry();
    if (existsSync(registryPath)) {
      const raw = JSON.parse(readFileSync(registryPath, 'utf-8')) as { processes?: Record<string, { type?: string }> };
      registered = Object.values(raw.processes ?? {}).filter((p) => p.type === 'chroma').length;
    }
  } catch {
    // unreadable registry: report from the process table alone
  }
  try {
    const rows = await readProcessTablePosix();
    const { roots, orphans } = findOrphanedChromaRoots(rows, { isAlive: isPidAlive, selfPid: process.pid });
    const detail = `${roots.length} live chroma-mcp tree(s), ${registered} registered, ${orphans.length} orphaned`;
    if (orphans.length > 0) {
      return {
        name,
        status: 'warn',
        detail: `${detail} — orphans are reaped at the next worker start (claude-mem worker restart)`,
        required: false,
      };
    }
    return { name, status: 'ok', detail, required: false };
  } catch (error) {
    return {
      name,
      status: 'warn',
      detail: `could not read the process table: ${error instanceof Error ? error.message : String(error)}`,
      required: false,
    };
  }
}

const MISSING_DEPENDENCIES_SHOWN = 5;

/** The "Plugin installed" row: root, version and dependency completeness. Exported for tests. */
export function pluginRootCheck(resolution: PluginRootResolution | null): CheckResult {
  const name = 'Plugin installed';
  if (!resolution) {
    return { name, status: 'fail', detail: 'run `npx claude-mem install`', required: true };
  }
  const where = resolution.version ? `${resolution.root} (v${resolution.version})` : resolution.root;
  const missing = resolution.missingDependencies;
  if (missing.length === 0) {
    return { name, status: 'ok', detail: where, required: true };
  }
  const shown = missing.slice(0, MISSING_DEPENDENCIES_SHOWN).join(', ');
  const more = missing.length > MISSING_DEPENDENCIES_SHOWN ? `, +${missing.length - MISSING_DEPENDENCIES_SHOWN} more` : '';
  return {
    name,
    status: 'fail',
    detail: `${where} — missing ${shown}${more} — run \`npx claude-mem repair\``,
    required: true,
  };
}

/** The "tree-sitter CLI" row for the plugin root the worker runs from. Exported for tests. */
export async function treeSitterCliCheck(pluginRoot: string): Promise<CheckResult> {
  const name = 'tree-sitter CLI';
  const binaryPath = treeSitterCliBinaryPath(pluginRoot);
  return (await isTreeSitterCliBinaryUsable(pluginRoot))
    ? { name, status: 'ok', detail: binaryPath, required: false }
    : {
        name,
        status: 'warn',
        detail: `missing or unusable at ${binaryPath} — smart_search/smart_outline disabled; run \`npx claude-mem repair\``,
        required: false,
      };
}

/** The "Marketplace manifest" row. Exported for tests. */
export function marketplaceManifestCheck(marketplaceDir: string): CheckResult {
  const manifestPath = join(marketplaceDir, '.claude-plugin', 'marketplace.json');
  return existsSync(manifestPath)
    ? { name: 'Marketplace manifest', status: 'ok', detail: manifestPath, required: false }
    : {
        name: 'Marketplace manifest',
        status: 'warn',
        detail: 'missing — Claude Code may not find the plugin; run `npx claude-mem install`',
        required: false,
      };
}

export async function runDoctorCommand(): Promise<void> {
  const checks: CheckResult[] = [];
  const dataDir = resolveDataDir();

  // 1. Bun (required — hooks run on Bun).
  const bunVersion = probeVersion('bun');
  checks.push({
    name: 'Bun runtime',
    status: bunVersion ? 'ok' : 'fail',
    detail: bunVersion ? `v${bunVersion.replace(/^v/, '')}` : 'not found on PATH — install: https://bun.sh',
    required: true,
  });

  // 2. uv (warn-only — only needed for vector search).
  const uvVersion = probeVersion('uv');
  checks.push({
    name: 'uv (vector search)',
    status: uvVersion ? 'ok' : 'warn',
    detail: uvVersion ? uvVersion : 'not found — vector/semantic search disabled until installed',
    required: false,
  });

  // 3. Plugin installed: the root the worker spawns from (the shared
  // resolveWorkerScript() oracle — cache, marketplace, or dev checkout), with
  // its version and dependency completeness.
  const pluginRoot = resolvePluginRoot();
  const installed = pluginRoot !== null;
  checks.push(pluginRootCheck(pluginRoot));

  // 3b. tree-sitter CLI at that root: smart_search and smart_outline shell out
  // to it, and installs suppress the script that downloads it (#2910).
  if (pluginRoot) checks.push(await treeSitterCliCheck(pluginRoot.root));

  // 4. Marketplace runtime root materialized. The .install-version marker is
  // written only by the npx installer; installs via Claude Code's own plugin
  // marketplace flow and dev `build-and-sync` never write one, so a missing
  // marker with node_modules present is informational, not a failure (#3661).
  // Required only when the marketplace copy is the root the worker spawns
  // from; a cache install is healthy without it.
  const marketplaceDir = marketplaceDirectory();
  const marketplaceIsActiveRoot = pluginRoot?.root === join(marketplaceDir, 'plugin');
  const marketplaceNodeModules = join(marketplaceDir, 'node_modules');
  const marketplaceMarker = join(marketplaceDir, '.install-version');
  const depsPresent = existsSync(marketplaceNodeModules);
  const markerPresent = existsSync(marketplaceMarker);
  const marketplaceCurrent = installed && isInstallCurrent(marketplaceDir, readPluginVersion());
  const marketplaceDetail = marketplaceCurrent
    ? 'node_modules and install marker present'
    : !depsPresent
      ? 'node_modules missing — run `npx claude-mem repair`'
      : !markerPresent
        ? 'node_modules present; no npx install marker (normal for marketplace/dev installs)'
        : 'install marker stale — run `npx claude-mem repair`';
  const marketplaceStatus: CheckStatus = !installed
    ? 'warn'
    : marketplaceCurrent
      ? 'ok'
      : (depsPresent && !markerPresent) || !marketplaceIsActiveRoot
        ? 'warn'
        : 'fail';
  checks.push({
    name: 'Marketplace runtime',
    status: marketplaceStatus,
    detail: marketplaceDetail,
    required: marketplaceIsActiveRoot,
  });

  // 4b. Marketplace manifest. Claude Code loads the plugin through the
  // marketplace root's .claude-plugin/marketplace.json; installs made before it
  // shipped (#3424) cache-miss until reinstalled.
  checks.push(marketplaceManifestCheck(marketplaceDir));

  // 5. Worker health.
  const workerHost = SettingsDefaultsManager.get('CLAUDE_MEM_WORKER_HOST');
  const workerPort = SettingsDefaultsManager.get('CLAUDE_MEM_WORKER_PORT');
  let workerStatus: CheckStatus = 'fail';
  let workerDetail = `no response at http://${workerHost}:${workerPort} — start with \`npx claude-mem start\``;
  let chromaChecks: CheckResult[] = [];
  try {
    const worker = await probeWorkerHealth(workerHost, workerPort);
    workerStatus = worker.status;
    workerDetail = worker.detail;
    chromaChecks = await probeChromaDiagnostics(worker.workerUrl);
  } catch {
    // leave as fail
  }
  checks.push({
    name: 'Worker daemon',
    status: workerStatus,
    detail: workerDetail,
    required: false, // worker can be intentionally stopped; don't hard-fail
  });
  checks.push(...chromaChecks);

  // 6. Windows Git Bash reachability. All claude-mem hooks run via
  // `"shell": "bash"`; on Windows, Claude Code resolves that through Git for
  // Windows with no WSL fallback. No-op on macOS/Linux.
  if (IS_WINDOWS) {
    const gitBash = checkWindowsGitBash();
    checks.push({
      name: 'Git Bash (Windows)',
      status: gitBash.ok ? 'ok' : 'fail',
      detail: gitBash.detail,
      required: true,
    });
  }

  // 7. Last recorded install error (surface remediation if present).
  const lastErrorPath = join(dataDir, 'last-install-error.json');
  if (existsSync(lastErrorPath)) {
    let detail = `present at ${lastErrorPath}`;
    try {
      const record = JSON.parse(readFileSync(lastErrorPath, 'utf-8'));
      if (record && typeof record === 'object') {
        detail = `${record.categoryId ?? 'error'}: ${record.remediation ?? detail}`;
      }
    } catch {
      // keep generic detail
    }
    checks.push({
      name: 'Last install error',
      status: 'warn',
      detail,
      required: false,
    });
  }

  const icon = (s: CheckStatus): string =>
    s === 'ok' ? styleText('green', '✓') : s === 'warn' ? styleText('yellow', '!') : styleText('red', '✗');

  // Chroma process census (#3905): live chroma-mcp trees against supervisor registry rows.
  // Anything other than one tree per row is the orphan leak. Read-only: the registry file is
  // parsed directly rather than through ProcessRegistry, whose initialize() prunes and persists.
  checks.push(await probeChromaCensus());

  console.log(styleText('bold', '\nclaude-mem doctor\n'));
  for (const c of checks) {
    console.log(`  ${icon(c.status)} ${c.name.padEnd(22)} ${styleText('dim', c.detail)}`);
  }

  const hardFailures = checks.filter((c) => c.required && c.status === 'fail');
  console.log('');
  if (hardFailures.length === 0) {
    console.log(styleText('green', 'All required checks passed.'));
    process.exit(0);
  } else {
    console.log(styleText('red', `${hardFailures.length} required check(s) failed — see remediation above.`));
    process.exit(1);
  }
}
