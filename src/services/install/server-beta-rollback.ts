// SPDX-License-Identifier: Apache-2.0
//
// rollback path for `claude-mem uninstall --runtime server-beta`.
//
// Tears down the Docker stack, restores per-IDE MCP config backups, and
// reverts the CLAUDE_MEM_RUNTIME setting. Data is preserved by default:
//   - Volumes survive unless --purge-data
//   - .env survives unless --purge-data
//   - settings.json server-beta keys (API key, project id) are removed but
//     other settings stay intact.

import { spawnSync } from 'child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { paths } from '../../shared/paths.js';
import {
  parseEnvFile,
} from './server-beta-setup.js';
import {
  rollbackAllIdes,
  type RollbackResult,
} from './ide-mcp-injection.js';

export interface RollbackOptions {
  marketplaceDir: string;
  purgeData?: boolean;
  dryRun?: boolean;
  dockerBin?: string;
  logger?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    success: (msg: string) => void;
  };
}

export interface RollbackOutcome {
  ok: boolean;
  dryRun: boolean;
  steps: Array<{ step: string; status: 'ok' | 'failed' | 'skipped'; message?: string }>;
  ideResults?: RollbackResult[];
}

function noopLogger() {
  return {
    info: (_msg: string) => undefined,
    warn: (_msg: string) => undefined,
    error: (_msg: string) => undefined,
    success: (_msg: string) => undefined,
  };
}

export async function rollbackServerBeta(options: RollbackOptions): Promise<RollbackOutcome> {
  const log = options.logger ?? noopLogger();
  const steps: RollbackOutcome['steps'] = [];
  const dryRun = options.dryRun === true;
  const dockerBin = options.dockerBin ?? 'docker';

  // STEP 1 — docker compose down (preserve volumes unless --purge-data)
  const composeFile = join(options.marketplaceDir, 'docker-compose.yml');
  const overrideFile = join(options.marketplaceDir, 'docker-compose.override.yml');
  const envFile = paths.envFile();

  if (!existsSync(composeFile)) {
    steps.push({ step: 'docker-compose-down', status: 'skipped', message: `docker-compose.yml missing at ${composeFile}` });
  } else if (dryRun) {
    steps.push({ step: 'docker-compose-down', status: 'skipped', message: '[dry-run] would run docker compose down' });
  } else {
    const args = [
      'compose',
      ...(existsSync(envFile) ? ['--env-file', envFile] : []),
      '-f', composeFile,
      ...(existsSync(overrideFile) ? ['-f', overrideFile] : []),
      'down',
    ];
    if (options.purgeData) args.push('-v');
    log.info(`Running: ${dockerBin} ${args.join(' ')}`);
    const result = spawnSync(dockerBin, args, {
      cwd: options.marketplaceDir,
      stdio: 'inherit',
    });
    if (result.error || result.status !== 0) {
      steps.push({
        step: 'docker-compose-down',
        status: 'failed',
        message: result.error?.message ?? `exit ${result.status}`,
      });
    } else {
      steps.push({ step: 'docker-compose-down', status: 'ok' });
    }
  }

  // STEP 2 — restore IDE configs from newest backup (or remove claude-mem entry).
  let ideResults: RollbackResult[] | undefined;
  if (dryRun) {
    steps.push({ step: 'ide-mcp-rollback', status: 'skipped', message: '[dry-run] would restore IDE configs from backup' });
  } else {
    ideResults = rollbackAllIdes();
    const failures = ideResults.filter(r => r.action === 'failed');
    steps.push({
      step: 'ide-mcp-rollback',
      status: failures.length === 0 ? 'ok' : 'failed',
      message: ideResults.map(r => `${r.ide}=${r.action}`).join(', '),
    });
    for (const r of ideResults) {
      if (r.action === 'failed') log.error(`Rollback failed for ${r.ide}: ${r.message ?? '(no detail)'}`);
      else if (r.action === 'restored') log.success(`Rolled back ${r.ide} (restored ${r.backupRestored})`);
      else if (r.action === 'removed-entry') log.info(`Removed claude-mem entry from ${r.ide} (no backup)`);
      else if (r.action === 'absent') log.info(`${r.ide}: nothing to roll back (config absent)`);
      else if (r.action === 'no-backup') log.warn(`${r.ide}: ${r.message}`);
    }
  }

  // STEP 3 — Remove server-beta keys from settings.json + revert CLAUDE_MEM_RUNTIME.
  const settingsPath = paths.settings();
  if (!existsSync(settingsPath)) {
    steps.push({ step: 'revert-runtime-setting', status: 'skipped', message: 'settings.json absent' });
  } else if (dryRun) {
    steps.push({ step: 'revert-runtime-setting', status: 'skipped', message: '[dry-run] would revert CLAUDE_MEM_RUNTIME and strip server-beta keys' });
  } else {
    try {
      const raw = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
      const isNested = raw.env && typeof raw.env === 'object';
      const flat = (isNested ? (raw.env as Record<string, unknown>) : raw) as Record<string, unknown>;
      let changed = false;
      if (flat.CLAUDE_MEM_RUNTIME === 'server-beta') {
        flat.CLAUDE_MEM_RUNTIME = 'worker';
        changed = true;
      }
      for (const key of ['CLAUDE_MEM_SERVER_BETA_API_KEY', 'CLAUDE_MEM_SERVER_BETA_PROJECT_ID', 'CLAUDE_MEM_SERVER_BETA_URL']) {
        if (key in flat) {
          delete flat[key];
          changed = true;
        }
      }
      if (changed) {
        const toWrite = isNested ? { ...raw, env: flat } : flat;
        writeFileSync(settingsPath, JSON.stringify(toWrite, null, 2) + '\n', 'utf-8');
      }
      steps.push({
        step: 'revert-runtime-setting',
        status: 'ok',
        message: changed ? 'Reverted runtime + stripped server-beta keys' : 'Nothing to revert',
      });
    } catch (err) {
      steps.push({
        step: 'revert-runtime-setting',
        status: 'failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // STEP 4 — Optionally remove .env (and Postgres creds inside it).
  if (options.purgeData && existsSync(envFile)) {
    if (dryRun) {
      steps.push({ step: 'purge-env', status: 'skipped', message: '[dry-run] would delete .env (--purge-data)' });
    } else {
      try {
        const parsed = parseEnvFile(readFileSync(envFile, 'utf-8'));
        const pgKeys = ['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB', 'CLAUDE_MEM_SERVER_DATABASE_URL'];
        const remaining: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (!pgKeys.includes(k)) remaining[k] = v;
        }
        if (Object.keys(remaining).length === 0) {
          rmSync(envFile, { force: true });
          steps.push({ step: 'purge-env', status: 'ok', message: `Removed ${envFile}` });
        } else {
          const lines = [
            '# claude-mem credentials',
            '# (PG credentials removed by uninstall --purge-data)',
            '',
            ...Object.entries(remaining).map(([k, v]) => /[\s#=]/.test(v) ? `${k}="${v}"` : `${k}=${v}`),
          ];
          writeFileSync(envFile, lines.join('\n') + '\n', { encoding: 'utf-8', mode: 0o600 });
          steps.push({
            step: 'purge-env',
            status: 'ok',
            message: `Stripped Postgres credentials from ${envFile} (preserved ${Object.keys(remaining).length} other keys)`,
          });
        }
      } catch (err) {
        steps.push({
          step: 'purge-env',
          status: 'failed',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const ok = steps.every(s => s.status !== 'failed');
  return { ok, dryRun, steps, ideResults };
}
