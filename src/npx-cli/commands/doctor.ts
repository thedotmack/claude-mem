/**
 * `npx claude-mem doctor` — a minimal diagnostic that probes every layer an
 * operator would otherwise check by hand (#2548). Read-only: it never mutates
 * state. Exits 0 when all REQUIRED checks pass, 1 otherwise, so it is CI/script
 * friendly.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import pc from 'picocolors';
import { isPluginInstalled, marketplaceDirectory } from '../utils/paths.js';
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

const IS_WINDOWS = process.platform === 'win32';

function probeVersion(bin: string): string | null {
  try {
    const result = spawnSync(bin, ['--version'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: IS_WINDOWS,
    });
    return result.status === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
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

  // 4. Marketplace dependencies materialized.
  const marketplaceNodeModules = join(marketplaceDirectory(), 'node_modules');
  const depsPresent = existsSync(marketplaceNodeModules);
  checks.push({
    name: 'Marketplace deps',
    status: installed ? (depsPresent ? 'ok' : 'fail') : 'warn',
    detail: depsPresent ? 'node_modules present' : 'missing — run `npx claude-mem repair`',
    required: installed,
  });

  // 5. Worker health.
  const workerPort = SettingsDefaultsManager.get('CLAUDE_MEM_WORKER_PORT');
  let workerStatus: CheckStatus = 'fail';
  let workerDetail = `no response on port ${workerPort} — start with \`npx claude-mem start\``;
  try {
    const res = await fetch(`http://127.0.0.1:${workerPort}/api/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      workerStatus = 'ok';
      workerDetail = `healthy at http://127.0.0.1:${workerPort}`;
    } else {
      workerStatus = 'warn';
      workerDetail = `reachable but unhealthy (HTTP ${res.status}) on port ${workerPort}`;
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
    s === 'ok' ? pc.green('✓') : s === 'warn' ? pc.yellow('!') : pc.red('✗');

  console.log(pc.bold('\nclaude-mem doctor\n'));
  for (const c of checks) {
    console.log(`  ${icon(c.status)} ${c.name.padEnd(22)} ${pc.dim(c.detail)}`);
  }

  const hardFailures = checks.filter((c) => c.required && c.status === 'fail');
  console.log('');
  if (hardFailures.length === 0) {
    console.log(pc.green('All required checks passed.'));
    process.exit(0);
  } else {
    console.log(pc.red(`${hardFailures.length} required check(s) failed — see remediation above.`));
    process.exit(1);
  }
}
