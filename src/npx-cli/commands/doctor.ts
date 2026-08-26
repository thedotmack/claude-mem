/**
 * `npx claude-mem doctor` — a minimal diagnostic that probes every layer an
 * operator would otherwise check by hand (#2548). Read-only: it never mutates
 * state. Exits 0 when all REQUIRED checks pass, 1 otherwise, so it is CI/script
 * friendly.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { styleText } from 'node:util';
import { IS_WINDOWS, isPluginInstalled, marketplaceDirectory, readPluginVersion } from '../utils/paths.js';
import { getBunVersion, getHeadroomPath, getUvVersion, isInstallCurrent } from '../install/setup-runtime.js';
import { HeadroomService } from '../../services/headroom/HeadroomService.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { resolveDataDir, paths, USER_SETTINGS_PATH } from '../../shared/paths.js';
import { isBackupAddonRequired } from '../../shared/backup-addon-marker.js';
import { backupAddonUrl } from '../../shared/pro-promo.js';
import { checkWindowsGitBash } from '../utils/windows-git-bash-preflight.js';

type CheckStatus = 'ok' | 'warn' | 'fail';

interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  /** When false, a 'fail' does not affect the overall exit code. */
  required: boolean;
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

async function probeWorkerHealth(workerHost: string, workerPort: string): Promise<{ status: CheckStatus; detail: string }> {
  const workerUrl = `http://${workerHost}:${workerPort}`;
  const res = await fetch(`${workerUrl}/api/health`, {
    signal: AbortSignal.timeout(3000),
  });
  if (res.ok) {
    return { status: 'ok', detail: `healthy at ${workerUrl}` };
  }
  return { status: 'warn', detail: `reachable but unhealthy (HTTP ${res.status}) at ${workerUrl}` };
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

  // 4. Marketplace runtime root materialized. The .install-version marker is
  // written only by the npx installer; installs via Claude Code's own plugin
  // marketplace flow and dev `build-and-sync` never write one, so a missing
  // marker with node_modules present is informational, not a failure (#3661).
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
        ? 'node_modules present; no npx install marker (normal for marketplace/dev installs)'
        : 'install marker stale — run `npx claude-mem repair`';
  const marketplaceStatus: CheckStatus = !installed
    ? 'warn'
    : marketplaceCurrent
      ? 'ok'
      : depsPresent && !markerPresent
        ? 'warn'
        : 'fail';
  checks.push({
    name: 'Marketplace runtime',
    status: marketplaceStatus,
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
  } catch {
    // leave as fail
  }
  checks.push({
    name: 'Worker daemon',
    status: workerStatus,
    detail: workerDetail,
    required: false, // worker can be intentionally stopped; don't hard-fail
  });

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

  // 7. Headroom compression sidecar (opt-in; all checks informational — the
  // worker degrades to uncompressed payloads whenever the proxy is absent).
  const headroomEnabled = SettingsDefaultsManager.get('CLAUDE_MEM_HEADROOM_ENABLED') === 'true';
  if (headroomEnabled) {
    const headroomUrl = SettingsDefaultsManager.get('CLAUDE_MEM_HEADROOM_URL');

    const headroomPath = getHeadroomPath();
    checks.push({
      name: 'Headroom binary',
      status: headroomPath ? 'ok' : 'warn',
      detail: headroomPath
        ?? 'not found — worker installs it on next start via `uv tool install --python 3.13 "headroom-ai[proxy]"`',
      required: false,
    });

    // healthCheck() has NO fallback path: it REJECTS when the proxy is
    // unreachable, so the catch below is the 'unreachable' report.
    let headroomProxyStatus: CheckStatus = 'warn';
    let headroomProxyDetail = `unreachable at ${headroomUrl} — payloads pass through uncompressed`;
    try {
      await HeadroomService.getInstance().healthCheck();
      headroomProxyStatus = 'ok';
      headroomProxyDetail = `healthy at ${headroomUrl}`;
      try {
        const stats = await HeadroomService.getInstance().proxyStats();
        headroomProxyDetail += ` — stats: ${JSON.stringify(stats)}`;
      } catch {
        // stats are decoration; health already passed
      }
    } catch {
      // leave as unreachable
    }
    checks.push({
      name: 'Headroom proxy',
      status: headroomProxyStatus,
      detail: headroomProxyDetail,
      required: false,
    });
  } else {
    checks.push({
      name: 'Headroom',
      status: 'ok',
      detail: 'disabled (set CLAUDE_MEM_HEADROOM_ENABLED=true to opt in)',
      required: false,
    });
  }

  // 8. Last recorded install error (surface remediation if present).
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

  // 8. Backups (informational). Backup settings live in settings.json, which
  // env-only SettingsDefaultsManager.get cannot see — load the file when it
  // exists (doctor is read-only, so never let loadFromFile seed a missing
  // settings.json; fall back to env/defaults instead).
  const backupSettings = existsSync(USER_SETTINGS_PATH)
    ? SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH)
    : {
        CLAUDE_MEM_BACKUP_ENABLED: SettingsDefaultsManager.get('CLAUDE_MEM_BACKUP_ENABLED'),
        CLAUDE_MEM_BACKUP_INTERVAL_HOURS: SettingsDefaultsManager.get('CLAUDE_MEM_BACKUP_INTERVAL_HOURS'),
      };
  if (backupSettings.CLAUDE_MEM_BACKUP_ENABLED !== 'true') {
    checks.push({
      name: 'Backups',
      status: 'ok',
      detail: 'disabled',
      required: false,
    });
  } else {
    const backupsDir = paths.backups();
    let newestMtime: number | null = null;
    try {
      for (const name of readdirSync(backupsDir)) {
        if (!/^claude-mem-.*\.db$/.test(name)) continue;
        const mtime = statSync(join(backupsDir, name)).mtimeMs;
        if (newestMtime === null || mtime > newestMtime) newestMtime = mtime;
      }
    } catch {
      // missing dir = no snapshots yet
    }
    const intervalHours = Number.parseFloat(backupSettings.CLAUDE_MEM_BACKUP_INTERVAL_HOURS);
    const staleThresholdMs = 2 * (Number.isFinite(intervalHours) && intervalHours > 0 ? intervalHours : 24) * 3_600_000;
    const fresh = newestMtime !== null && Date.now() - newestMtime <= staleThresholdMs;
    const snapshotDetail = newestMtime === null
      ? 'enabled but no snapshots yet — first run lands ~5 min after worker start'
      : fresh
        ? `last snapshot ${new Date(newestMtime).toLocaleString()}`
        : `last snapshot stale (${new Date(newestMtime).toLocaleString()}) — is the worker running?`;
    // Phase 4: the hub 403'd addon_required within its 24h marker TTL — local
    // snapshots still run, so the base status stands, but the cloud leg is
    // paused behind the paid add-on.
    const addonGated = isBackupAddonRequired();
    checks.push({
      name: 'Backups',
      status: addonGated ? 'warn' : fresh ? 'ok' : 'warn',
      detail: addonGated
        ? `${snapshotDetail}; cloud: add-on required — ${backupAddonUrl('doctor')}`
        : snapshotDetail,
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
