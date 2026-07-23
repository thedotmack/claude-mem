/**
 * `npx claude-mem doctor` — a minimal diagnostic that probes every layer an
 * operator would otherwise check by hand (#2548). Read-only: it never mutates
 * state. Exits 0 when all REQUIRED checks pass, 1 otherwise, so it is CI/script
 * friendly.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { styleText } from 'node:util';
import { isPluginInstalled, marketplaceDirectory, readPluginVersion } from '../utils/paths.js';
import { getBunVersion, getUvVersion, isInstallCurrent } from '../install/setup-runtime.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { resolveDataDir } from '../../shared/paths.js';

type CheckStatus = 'ok' | 'warn' | 'fail';

interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  /** When false, a 'fail' does not affect the overall exit code. */
  required: boolean;
}

interface ChromaCrashState {
  count: number;
  lastExit: {
    timestamp: string;
    code: number | null;
    signal: string | null;
  } | null;
  chromaMcpVersion: string;
  dependencyOverrides: string[];
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
      && (typeof state.lastExit.signal === 'string' || state.lastExit.signal === null)));
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

  // 3. Plugin installed in the marketplace.
  const installed = isPluginInstalled();
  checks.push({
    name: 'Plugin installed',
    status: installed ? 'ok' : 'fail',
    detail: installed ? marketplaceDirectory() : 'run `npx claude-mem install`',
    required: true,
  });

  // 4. Marketplace runtime root materialized.
  const marketplaceDir = marketplaceDirectory();
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
        ? 'install marker missing — run `npx claude-mem repair`'
        : 'install marker stale — run `npx claude-mem repair`';
  checks.push({
    name: 'Marketplace runtime',
    status: installed ? (marketplaceCurrent ? 'ok' : 'fail') : 'warn',
    detail: marketplaceDetail,
    required: installed,
  });

  // 5. Worker health.
  const workerHost = SettingsDefaultsManager.get('CLAUDE_MEM_WORKER_HOST');
  const workerPort = SettingsDefaultsManager.get('CLAUDE_MEM_WORKER_PORT');
  let workerStatus: CheckStatus = 'fail';
  let workerDetail = `no response at http://${workerHost}:${workerPort} — start with \`npx claude-mem start\``;
  try {
    const worker = await probeWorkerHealth(workerHost, workerPort);
    workerStatus = worker.status;
    workerDetail = worker.detail;
    try {
      const diagnosticsResponse = await fetch(`${worker.workerUrl}/api/admin/doctor`, {
        signal: AbortSignal.timeout(3000),
      });
      if (diagnosticsResponse.ok) {
        const diagnostics = await diagnosticsResponse.json() as { health?: { chroma?: unknown } };
        const chroma = diagnostics?.health?.chroma;
        if (isChromaCrashState(chroma) && chroma.count > 0 && chroma.lastExit) {
          const outcome = chroma.lastExit.signal
            ? `signal ${chroma.lastExit.signal}`
            : `code ${chroma.lastExit.code}`;
          checks.push({
            name: 'Chroma child exits',
            status: 'warn',
            detail: `${chroma.count} (${outcome}) at ${chroma.lastExit.timestamp}; chroma-mcp ${chroma.chromaMcpVersion}; overrides: ${chroma.dependencyOverrides.join(', ')}`,
            required: false,
          });
        }
      }
    } catch {
      // Diagnostics are optional and must not change worker health status.
    }
  } catch {
    // leave as fail
  }
  checks.push({
    name: 'Worker daemon',
    status: workerStatus,
    detail: workerDetail,
    required: false, // worker can be intentionally stopped; don't hard-fail
  });

  // 6. Last recorded install error (surface remediation if present).
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
