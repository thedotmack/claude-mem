// SPDX-License-Identifier: Apache-2.0
//
// end-to-end setupServerBeta() orchestrator.
//
// When the operator picks `runtime: "server-beta"` during install, this
// function walks the full happy-path setup: Docker preflight → .env → compose
// override → `docker compose up` → wait healthy → bootstrap API key →
// populate plugin/node_modules → inject MCP configs into all 4 IDEs.
//
// Fail-fast at every step. The caller is install.ts which MUST commit the
// CLAUDE_MEM_RUNTIME setting only AFTER this returns success.
//
// Idempotency: re-running on a system where the stack is already up and
// the API key is already in settings.json is a no-op (returns 'reused').

import { execSync, spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { paths } from '../../shared/paths.js';
import { injectAllIdes, type InjectionResult } from './ide-mcp-injection.js';

export interface SetupOptions {
  marketplaceDir: string;
  dryRun?: boolean;
  optInIdes?: string[];
  /** Override docker bin for tests (default: 'docker'). */
  dockerBin?: string;
  /** Override server-beta bootstrap (default: real bootstrap). For tests. */
  bootstrapImpl?: BootstrapFn;
  /** Max seconds to wait for docker compose health (default: 90). */
  healthTimeoutSeconds?: number;
  /** Logger functions — caller wires these into clack. */
  logger?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    success: (msg: string) => void;
  };
}

export interface SetupResult {
  ok: boolean;
  dryRun: boolean;
  steps: SetupStepResult[];
  apiKey?: string;
  projectId?: string;
  ideResults?: InjectionResult[];
}

export interface SetupStepResult {
  step: string;
  status: 'ok' | 'reused' | 'failed' | 'skipped';
  message?: string;
}

interface BootstrapResult {
  rawKey: string;
  apiKeyId: string;
  teamId: string;
  projectId: string;
}

type BootstrapFn = () => Promise<BootstrapResult>;

const DEFAULT_HEALTH_TIMEOUT = 90;

function noopLogger() {
  return {
    info: (_msg: string) => undefined,
    warn: (_msg: string) => undefined,
    error: (_msg: string) => undefined,
    success: (_msg: string) => undefined,
  };
}

export async function setupServerBeta(options: SetupOptions): Promise<SetupResult> {
  const log = options.logger ?? noopLogger();
  const steps: SetupStepResult[] = [];
  const dryRun = options.dryRun === true;

  const step = (name: string, status: SetupStepResult['status'], message?: string): SetupStepResult => {
    const result: SetupStepResult = { step: name, status, message };
    steps.push(result);
    return result;
  };

  // STEP 1 — Docker preflight
  const dockerCheck = checkDockerInstalled(options.dockerBin);
  if (!dockerCheck.ok) {
    log.error(dockerCheck.message);
    step('docker-preflight', 'failed', dockerCheck.message);
    return { ok: false, dryRun, steps };
  }
  step('docker-preflight', 'ok', dockerCheck.message);
  log.info(dockerCheck.message);

  // STEP 2 — .env file with PG creds
  const envResult = ensurePostgresEnv(dryRun);
  step(envResult.step, envResult.status, envResult.message);
  log.info(`${envResult.step}: ${envResult.message}`);
  if (envResult.status === 'failed') {
    return { ok: false, dryRun, steps };
  }

  // STEP 2b: Claude subscription credentials extraction.
  // Reads ~/.claude-mem/settings.json (CLAUDE_MEM_CLAUDE_AUTH_METHOD) and
  // when auth='subscription' extracts the host's OAuth token from the macOS
  // Keychain (or ~/.claude/.credentials.json fallback) into a file the
  // docker-compose can mount into the worker container. When auth='api-key'
  // this step is a no-op.
  const credsResult = ensureClaudeSubscriptionCreds(dryRun);
  step(credsResult.step, credsResult.status, credsResult.message);
  log.info(`${credsResult.step}: ${credsResult.message}`);
  // Subscription extraction failure is non-fatal: the worker can still use
  // ANTHROPIC_API_KEY. Only surface a warning so the operator knows.

  // STEP 3 — docker-compose override
  const overrideResult = ensureDockerComposeOverride(options.marketplaceDir, dryRun);
  step(overrideResult.step, overrideResult.status, overrideResult.message);
  log.info(`${overrideResult.step}: ${overrideResult.message}`);
  if (overrideResult.status === 'failed') {
    return { ok: false, dryRun, steps };
  }

  // STEP 4 — docker compose up + healthcheck wait
  if (dryRun) {
    step('docker-compose-up', 'skipped', '[dry-run] would run docker compose up -d --build and wait for health');
    log.info('[dry-run] skipping docker compose up');
  } else {
    const composeResult = runDockerComposeUp({
      marketplaceDir: options.marketplaceDir,
      dockerBin: options.dockerBin ?? 'docker',
      healthTimeoutSeconds: options.healthTimeoutSeconds ?? DEFAULT_HEALTH_TIMEOUT,
      logger: log,
    });
    step('docker-compose-up', composeResult.ok ? 'ok' : 'failed', composeResult.message);
    if (!composeResult.ok) {
      return { ok: false, dryRun, steps };
    }
  }

  // STEP 5 — Bootstrap API key
  let apiKey: string | undefined;
  let projectId: string | undefined;
  if (dryRun) {
    step('bootstrap-api-key', 'skipped', '[dry-run] would bootstrap API key via Postgres');
  } else {
    const bootstrapResult = await runBootstrap({
      bootstrapImpl: options.bootstrapImpl,
      logger: log,
    });
    if (!bootstrapResult.ok) {
      step('bootstrap-api-key', 'failed', bootstrapResult.message);
      return { ok: false, dryRun, steps };
    }
    step('bootstrap-api-key', bootstrapResult.reused ? 'reused' : 'ok', bootstrapResult.message);
    apiKey = bootstrapResult.apiKey;
    projectId = bootstrapResult.projectId;
  }

  // STEP 6 — Populate marketplace plugin/node_modules so tree-sitter grammars exist.
  if (dryRun) {
    step('marketplace-plugin-deps', 'skipped', '[dry-run] would run npm install in marketplace/plugin');
  } else {
    const npmResult = ensurePluginNodeModules(options.marketplaceDir);
    step('marketplace-plugin-deps', npmResult.ok ? 'ok' : 'failed', npmResult.message);
    if (!npmResult.ok) {
      log.warn(`Plugin deps install failed: ${npmResult.message}. Tree-sitter grammars (smart_search/outline/unfold) may not work.`);
    }
  }

  // STEP 7 — Inject MCP configs into all 4 IDEs.
  let ideResults: InjectionResult[] | undefined;
  if (dryRun) {
    step('ide-mcp-injection', 'skipped', '[dry-run] would inject MCP configs');
  } else {
    const mcpServerPath = join(options.marketplaceDir, 'plugin', 'scripts', 'mcp-server.cjs');
    if (!existsSync(mcpServerPath)) {
      step('ide-mcp-injection', 'failed', `mcp-server.cjs not found at ${mcpServerPath}`);
      return { ok: false, dryRun, steps, apiKey, projectId };
    }
    ideResults = injectAllIdes({
      mcpServerPath,
      marketplaceDir: options.marketplaceDir,
      optInIdes: options.optInIdes,
    });
    const failures = ideResults.filter(r => r.status === 'failed');
    const overallStatus = failures.length === 0 ? 'ok' : 'failed';
    const summary = ideResults.map(r => `${r.ide}=${r.status}`).join(', ');
    step('ide-mcp-injection', overallStatus, summary);
    for (const result of ideResults) {
      if (result.status === 'failed') {
        log.error(`IDE inject failed for ${result.ide}: ${result.message ?? '(no detail)'}`);
      } else if (result.status === 'written') {
        log.success(`IDE inject ${result.ide}: ${result.configPath}`);
      } else if (result.status === 'already-current') {
        log.info(`IDE inject ${result.ide}: already current`);
      } else if (result.status === 'skipped') {
        log.info(`IDE inject ${result.ide}: skipped (${result.message ?? 'not detected'})`);
      }
    }
  }

  // Honor the fail-fast contract: if any IDE injection failed, the overall
  // install is not 'ok' and the caller should NOT commit the runtime
  // selector. Without this, install.ts saw ok:true even when Claude
  // Desktop's config write failed.
  const finalOk = steps.every(s => s.status !== 'failed');
  return { ok: finalOk, dryRun, steps, apiKey, projectId, ideResults };
}

interface DockerCheckResult {
  ok: boolean;
  message: string;
}

function checkDockerInstalled(dockerBin?: string): DockerCheckResult {
  const bin = dockerBin ?? 'docker';
  try {
    const result = spawnSync(bin, ['version', '--format', '{{.Server.Version}}'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error) {
      return { ok: false, message: dockerMissingHint() };
    }
    if (result.status !== 0) {
      const stderr = (result.stderr ?? '').trim();
      const lowered = stderr.toLowerCase();
      if (lowered.includes('cannot connect') || lowered.includes('docker daemon')) {
        return {
          ok: false,
          message: `Docker is installed but the daemon is not running. Start Docker Desktop and re-run install.${process.platform === 'darwin' ? ' On macOS: open -a Docker' : ''}`,
        };
      }
      return { ok: false, message: `Docker preflight failed: ${stderr || `exit ${result.status}`}` };
    }
    const version = (result.stdout ?? '').trim();
    return { ok: true, message: `Docker ${version} (daemon reachable)` };
  } catch {
    return { ok: false, message: dockerMissingHint() };
  }
}

function dockerMissingHint(): string {
  if (process.platform === 'darwin') {
    return 'Docker is not installed. Run: brew install --cask docker && open -a Docker';
  }
  if (process.platform === 'linux') {
    return 'Docker is not installed. Install via your distro package manager (apt/yum/pacman) then start the docker service.';
  }
  return 'Docker is not installed. Install Docker Desktop from https://www.docker.com/products/docker-desktop/';
}

interface PostgresEnv {
  user: string;
  password: string;
  db: string;
}

export function generatePostgresEnv(): PostgresEnv {
  return {
    user: 'claude_mem',
    password: randomBytes(24).toString('base64url'),
    db: 'claude_mem_server',
  };
}

function ensurePostgresEnv(dryRun: boolean): SetupStepResult {
  try {
    const envFile = paths.envFile();
    const dir = paths.dataDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    try {
      chmodSync(dir, 0o700);
    } catch {
      // best-effort
    }
    const existing = parseEnvFile(existsSync(envFile) ? readFileSync(envFile, 'utf-8') : '');
    const needsUser = !existing.POSTGRES_USER;
    const needsPassword = !existing.POSTGRES_PASSWORD;
    const needsDb = !existing.POSTGRES_DB;
    const needsDbUrl = !existing.CLAUDE_MEM_SERVER_DATABASE_URL;

    if (!needsUser && !needsPassword && !needsDb && !needsDbUrl) {
      return { step: 'ensure-postgres-env', status: 'reused', message: `${envFile} already has Postgres credentials` };
    }

    if (dryRun) {
      return {
        step: 'ensure-postgres-env',
        status: 'skipped',
        message: `[dry-run] would write Postgres creds to ${envFile}`,
      };
    }

    const next: Record<string, string> = { ...existing };
    if (needsUser) next.POSTGRES_USER = 'claude_mem';
    if (needsPassword) next.POSTGRES_PASSWORD = randomBytes(24).toString('base64url');
    if (needsDb) next.POSTGRES_DB = 'claude_mem_server';
    if (needsDbUrl) {
      const user = encodeURIComponent(next.POSTGRES_USER);
      const password = encodeURIComponent(next.POSTGRES_PASSWORD);
      const db = encodeURIComponent(next.POSTGRES_DB);
      next.CLAUDE_MEM_SERVER_DATABASE_URL = `postgres://${user}:${password}@127.0.0.1:55432/${db}`;
    }

    writeFileSync(envFile, serializeEnvFile(next), { encoding: 'utf-8', mode: 0o600 });
    try {
      chmodSync(envFile, 0o600);
    } catch {
      // non-POSIX
    }
    return { step: 'ensure-postgres-env', status: 'ok', message: `Wrote Postgres credentials to ${envFile}` };
  } catch (err) {
    return {
      step: 'ensure-postgres-env',
      status: 'failed',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

// Claude Code subscription credentials extraction.
//
// When ~/.claude-mem/settings.json sets CLAUDE_MEM_CLAUDE_AUTH_METHOD =
// 'subscription', extract the host's OAuth credentials and write them to
// ~/.claude-mem/.claude-credentials.json (chmod 600). The .env file gets
// CLAUDE_CREDS_FILE=<host path> so docker-compose mounts the file into
// each container at /run/secrets/claude-credentials.json (where the
// generation provider factory's readClaudeOAuthToken() looks for it).
//
// Lookup order on the host:
//   1. macOS Keychain: `security find-generic-password -s 'Claude Code-credentials' -w`
//   2. ~/.claude/.credentials.json (legacy on-disk form, still present on
//      older Claude CLI installs and migrated machines)
// If neither is available, this step degrades gracefully — the worker still
// runs but generation falls back to ANTHROPIC_API_KEY (api-key auth).
// Claude subscription auth wiring.
//
// Strategy:
//   1. ~/.claude/.credentials.json exists  → LIVE BIND-MOUNT the host file
//      into the container. Claude CLI atomic-renames on every token refresh
//      and account-switch; the container re-reads on every generate() call.
//   2. No .credentials.json (macOS Keychain-only install)  → start the host
//      bridge service so the container can proxy generation through the host's
//      Claude CLI (which has live access to the Keychain).
//
// When auth_method='api-key' this step is a no-op — the worker uses
// ANTHROPIC_API_KEY directly.
function ensureClaudeSubscriptionCreds(dryRun: boolean): SetupStepResult {
  try {
    const settingsPath = paths.settings();
    let authMethod = 'subscription';
    if (existsSync(settingsPath)) {
      try {
        const raw = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
        const flat = (raw.env && typeof raw.env === 'object' ? raw.env : raw) as Record<string, unknown>;
        const v = flat.CLAUDE_MEM_CLAUDE_AUTH_METHOD;
        if (typeof v === 'string' && v.length > 0) authMethod = v;
      } catch {
        /* keep default */
      }
    }

    if (authMethod !== 'subscription') {
      // Clear any previous CLAUDE_CREDS_FILE so the mount resolves to /dev/null.
      const envFile = paths.envFile();
      if (existsSync(envFile)) {
        const existing = parseEnvFile(readFileSync(envFile, 'utf-8'));
        if (existing.CLAUDE_CREDS_FILE || existing.CLAUDE_MEM_CLAUDE_BRIDGE_URL) {
          if (dryRun) {
            return {
              step: 'ensure-claude-creds',
              status: 'skipped',
              message: `[dry-run] would clear CLAUDE_CREDS_FILE and CLAUDE_MEM_CLAUDE_BRIDGE_URL from ${envFile}`,
            };
          }
          delete existing.CLAUDE_CREDS_FILE;
          delete existing.CLAUDE_MEM_CLAUDE_BRIDGE_URL;
          delete existing.CLAUDE_HOST_BRIDGE_TOKEN_FILE;
          writeFileSync(envFile, serializeEnvFile(existing), { encoding: 'utf-8', mode: 0o600 });
        }
      }
      return {
        step: 'ensure-claude-creds',
        status: 'skipped',
        message: `auth-method=${authMethod}; subscription wiring not needed`,
      };
    }

    if (dryRun) {
      return {
        step: 'ensure-claude-creds',
        status: 'skipped',
        message: `[dry-run] would wire Claude subscription credentials for container`,
      };
    }

    const envFile = paths.envFile();
    const home = process.env.HOME ?? '';
    const hostCredsPath = join(home, '.claude', '.credentials.json');
    const existing = parseEnvFile(existsSync(envFile) ? readFileSync(envFile, 'utf-8') : '');

    // ── Path 1: file present — bind-mount it live ──────────────────────────
    if (existsSync(hostCredsPath)) {
      // Confirm it's actually a Claude CLI creds file before mounting.
      try {
        const raw = JSON.parse(readFileSync(hostCredsPath, 'utf-8')) as {
          claudeAiOauth?: { accessToken?: string };
        };
        if (!raw.claudeAiOauth?.accessToken) {
          throw new Error('claudeAiOauth.accessToken missing');
        }
      } catch (parseErr) {
        // Clear any stale CLAUDE_CREDS_FILE / CLAUDE_MEM_CLAUDE_BRIDGE_URL
        // from a previous successful install so the next compose-up doesn't
        // bind-mount a now-invalid credentials file silently.
        if (existing.CLAUDE_CREDS_FILE || existing.CLAUDE_MEM_CLAUDE_BRIDGE_URL) {
          delete existing.CLAUDE_CREDS_FILE;
          delete existing.CLAUDE_MEM_CLAUDE_BRIDGE_URL;
          delete existing.CLAUDE_HOST_BRIDGE_TOKEN_FILE;
          if (!dryRun) {
            writeFileSync(envFile, serializeEnvFile(existing), { encoding: 'utf-8', mode: 0o600 });
          }
        }
        return {
          step: 'ensure-claude-creds',
          status: 'failed',
          message: `${hostCredsPath} exists but is not a valid Claude credentials file: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
        };
      }

      existing.CLAUDE_CREDS_FILE = hostCredsPath;
      delete existing.CLAUDE_MEM_CLAUDE_BRIDGE_URL;
          delete existing.CLAUDE_HOST_BRIDGE_TOKEN_FILE;
      writeFileSync(envFile, serializeEnvFile(existing), { encoding: 'utf-8', mode: 0o600 });
      return {
        step: 'ensure-claude-creds',
        status: 'ok',
        message: `Bind-mounting ${hostCredsPath} into worker container (live — token refresh + account switch propagate automatically)`,
      };
    }

    // ── Path 2: no file — set up the host bridge ───────────────────────────
    // Implementation lands in Phase 2 (ensureClaudeHostBridge below). For now,
    // surface a clear instruction so the operator knows what's needed.
    const bridgeResult = launchClaudeHostBridge();
    if (bridgeResult.ok) {
      existing.CLAUDE_MEM_CLAUDE_BRIDGE_URL = bridgeResult.bridgeUrl;
      // Where docker-compose mounts the token file from; the in-container
      // path is hard-coded to /run/secrets/claude-host-bridge-token.
      existing.CLAUDE_HOST_BRIDGE_TOKEN_FILE = join(paths.dataDir(), 'host-bridge-token');
      delete existing.CLAUDE_CREDS_FILE;
      writeFileSync(envFile, serializeEnvFile(existing), { encoding: 'utf-8', mode: 0o600 });
      return {
        step: 'ensure-claude-creds',
        status: 'ok',
        message: `Started Claude host-bridge at ${bridgeResult.bridgeUrl} (container proxies through host's Claude CLI — always live)`,
      };
    }

    // Bridge couldn't start — graceful fallback to api-key.
    delete existing.CLAUDE_CREDS_FILE;
    delete existing.CLAUDE_MEM_CLAUDE_BRIDGE_URL;
    delete existing.CLAUDE_HOST_BRIDGE_TOKEN_FILE;
    writeFileSync(envFile, serializeEnvFile(existing), { encoding: 'utf-8', mode: 0o600 });
    return {
      step: 'ensure-claude-creds',
      status: 'skipped',
      message: `no ${hostCredsPath} and host-bridge not available (${bridgeResult.message}) — worker will fall back to ANTHROPIC_API_KEY if configured`,
    };
  } catch (err) {
    return {
      step: 'ensure-claude-creds',
      status: 'failed',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

// Re-export the host-bridge launcher from its own module to keep this file
// focused on orchestration. claude-host-bridge.ts owns the script source,
// launchd/systemd unit installation, and health-check polling.
import { ensureClaudeHostBridge as launchClaudeHostBridge } from './claude-host-bridge.js';

// (Internal shim removed — ensureClaudeSubscriptionCreds() above now calls
// launchClaudeHostBridge() directly via the import alias.)

// (readHostClaudeCredentials() removed refactor switched from
// snapshot-extract to live bind-mount. The setup script no longer needs to
// pull bytes out of the host; it just points CLAUDE_CREDS_FILE at the
// host's .credentials.json directly.)

function ensureDockerComposeOverride(marketplaceDir: string, dryRun: boolean): SetupStepResult {
  try {
    const sourceExample = join(marketplaceDir, 'docker-compose.override.yml.example');
    const targetOverride = join(marketplaceDir, 'docker-compose.override.yml');

    if (!existsSync(sourceExample)) {
      return {
        step: 'docker-compose-override',
        status: 'failed',
        message: `Marketplace missing docker-compose.override.yml.example at ${sourceExample}`,
      };
    }

    if (existsSync(targetOverride)) {
      return {
        step: 'docker-compose-override',
        status: 'reused',
        message: `${targetOverride} already exists`,
      };
    }

    if (dryRun) {
      return {
        step: 'docker-compose-override',
        status: 'skipped',
        message: `[dry-run] would write ${targetOverride}`,
      };
    }

    const activeOverride = activateDockerComposeOverride(readFileSync(sourceExample, 'utf-8'));
    writeFileSync(targetOverride, activeOverride, 'utf-8');
    return {
      step: 'docker-compose-override',
      status: 'ok',
      message: `Wrote dev profile override to ${targetOverride}`,
    };
  } catch (err) {
    return {
      step: 'docker-compose-override',
      status: 'failed',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export function activateDockerComposeOverride(exampleContent: string): string {
  const lines = exampleContent.split('\n');
  const activated: string[] = [];
  let inServicesBlock = false;
  for (const line of lines) {
    if (/^\s*$/.test(line)) {
      activated.push(line);
      continue;
    }
    if (/^# (services|  )/.test(line)) {
      inServicesBlock = true;
      activated.push(line.replace(/^# /, ''));
      continue;
    }
    if (inServicesBlock && /^#( {2,}|\t)/.test(line)) {
      activated.push(line.replace(/^# /, ''));
      continue;
    }
    activated.push(line);
  }
  if (!activated.some(l => /^services:/.test(l))) {
    return [
      '# Auto-generated by claude-mem install --runtime server-beta',
      '# Exposes Postgres on 127.0.0.1:55432 so host-side tooling can connect.',
      'services:',
      '  postgres:',
      '    ports:',
      '      - "127.0.0.1:55432:5432"',
      '',
    ].join('\n');
  }
  return activated.join('\n');
}

interface ComposeUpResult {
  ok: boolean;
  message: string;
}

function runDockerComposeUp(args: {
  marketplaceDir: string;
  dockerBin: string;
  healthTimeoutSeconds: number;
  logger: NonNullable<SetupOptions['logger']>;
}): ComposeUpResult {
  const composeFile = join(args.marketplaceDir, 'docker-compose.yml');
  const overrideFile = join(args.marketplaceDir, 'docker-compose.override.yml');
  const envFile = paths.envFile();

  if (!existsSync(composeFile)) {
    return { ok: false, message: `docker-compose.yml missing at ${composeFile}` };
  }
  if (!existsSync(envFile)) {
    return { ok: false, message: `Postgres .env file missing at ${envFile}` };
  }

  const composeArgs = [
    'compose',
    '--env-file', envFile,
    '-f', composeFile,
  ];
  if (existsSync(overrideFile)) {
    composeArgs.push('-f', overrideFile);
  }
  composeArgs.push('up', '-d', '--build');

  args.logger.info(`Running: ${args.dockerBin} ${composeArgs.join(' ')}`);

  try {
    const result = spawnSync(args.dockerBin, composeArgs, {
      cwd: args.marketplaceDir,
      stdio: 'inherit',
    });
    if (result.error) {
      return { ok: false, message: `docker compose up failed: ${result.error.message}` };
    }
    if (result.status !== 0) {
      return { ok: false, message: `docker compose up exited ${result.status}` };
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }

  const healthy = waitForComposeHealth({
    marketplaceDir: args.marketplaceDir,
    dockerBin: args.dockerBin,
    envFile,
    composeFile,
    overrideFile: existsSync(overrideFile) ? overrideFile : undefined,
    timeoutSeconds: args.healthTimeoutSeconds,
    logger: args.logger,
  });
  if (!healthy.ok) return healthy;

  return { ok: true, message: 'docker compose stack is healthy' };
}

function waitForComposeHealth(args: {
  marketplaceDir: string;
  dockerBin: string;
  envFile: string;
  composeFile: string;
  overrideFile?: string;
  timeoutSeconds: number;
  logger: NonNullable<SetupOptions['logger']>;
}): ComposeUpResult {
  const deadline = Date.now() + args.timeoutSeconds * 1000;
  const baseArgs = [
    'compose',
    '--env-file', args.envFile,
    '-f', args.composeFile,
    ...(args.overrideFile ? ['-f', args.overrideFile] : []),
  ];
  const services = ['postgres', 'valkey', 'claude-mem-server', 'claude-mem-worker'];

  while (Date.now() < deadline) {
    const allHealthy = services.every((svc) => isServiceHealthy({
      dockerBin: args.dockerBin,
      cwd: args.marketplaceDir,
      composeArgs: baseArgs,
      service: svc,
    }));
    if (allHealthy) {
      return { ok: true, message: 'all services healthy' };
    }
    sleepSync(2000);
  }
  return { ok: false, message: `docker compose stack did not become healthy in ${args.timeoutSeconds}s` };
}

function isServiceHealthy(args: {
  dockerBin: string;
  cwd: string;
  composeArgs: string[];
  service: string;
}): boolean {
  try {
    const psArgs = [...args.composeArgs, 'ps', '--format', 'json', args.service];
    const result = spawnSync(args.dockerBin, psArgs, {
      cwd: args.cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.status !== 0) return false;
    const stdout = (result.stdout ?? '').trim();
    if (!stdout) return false;
    const lines = stdout.split('\n').filter(Boolean);
    if (lines.length === 0) return false;
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as { Health?: string; State?: string };
        const health = (parsed.Health ?? '').toLowerCase();
        const state = (parsed.State ?? '').toLowerCase();
        if (health === 'healthy') continue;
        if (health === '' && state === 'running') continue;
        return false;
      } catch {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>process.exit(0),' + Math.min(ms, 500) + ')'], { stdio: 'ignore' });
    if (Date.now() >= end) return;
  }
}

interface BootstrapOutcome {
  ok: boolean;
  reused: boolean;
  message: string;
  apiKey?: string;
  projectId?: string;
}

async function runBootstrap(args: {
  bootstrapImpl?: BootstrapFn;
  logger: NonNullable<SetupOptions['logger']>;
}): Promise<BootstrapOutcome> {
  const settingsPath = paths.settings();

  if (settingsAlreadyHasServerBetaKey(settingsPath)) {
    return { ok: true, reused: true, message: 'API key already present in settings.json' };
  }

  const databaseUrl = readDatabaseUrlFromEnvFile();
  if (databaseUrl && !process.env.CLAUDE_MEM_SERVER_DATABASE_URL) {
    process.env.CLAUDE_MEM_SERVER_DATABASE_URL = databaseUrl;
  }

  if (!process.env.CLAUDE_MEM_SERVER_DATABASE_URL) {
    return { ok: false, reused: false, message: 'CLAUDE_MEM_SERVER_DATABASE_URL missing — cannot bootstrap API key' };
  }

  try {
    const { bootstrapServerBetaApiKey, persistServerBetaSettings } = await import('../hooks/server-beta-bootstrap.js');
    const impl: BootstrapFn = args.bootstrapImpl ?? (() => bootstrapServerBetaApiKey());
    const result = await impl();
    // fix — docker-compose.yml hardcodes the server on 127.0.0.1:37877.
    // The UID-derived default in SettingsDefaultsManager only fits worker-mode;
    // for server-beta we must write the actual Docker-exposed URL so the hooks
    // (and the doctor CLI) hit the right port. Pass serverBaseUrl explicitly.
    persistServerBetaSettings(settingsPath, {
      apiKey: result.rawKey,
      projectId: result.projectId,
      serverBaseUrl: 'http://127.0.0.1:37877',
    });
    return {
      ok: true,
      reused: false,
      message: `Provisioned API key for project ${result.projectId.slice(0, 8)}…`,
      apiKey: result.rawKey,
      projectId: result.projectId,
    };
  } catch (err) {
    return {
      ok: false,
      reused: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function settingsAlreadyHasServerBetaKey(settingsPath: string): boolean {
  if (!existsSync(settingsPath)) return false;
  try {
    const raw = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
    const flat = (raw.env && typeof raw.env === 'object' ? raw.env : raw) as Record<string, unknown>;
    const key = flat.CLAUDE_MEM_SERVER_BETA_API_KEY;
    return typeof key === 'string' && key.length > 0;
  } catch {
    return false;
  }
}

function readDatabaseUrlFromEnvFile(): string | undefined {
  const envFile = paths.envFile();
  if (!existsSync(envFile)) return undefined;
  const parsed = parseEnvFile(readFileSync(envFile, 'utf-8'));
  return parsed.CLAUDE_MEM_SERVER_DATABASE_URL;
}

interface PluginDepsResult {
  ok: boolean;
  message: string;
}

function ensurePluginNodeModules(marketplaceDir: string): PluginDepsResult {
  const pluginDir = join(marketplaceDir, 'plugin');
  if (!existsSync(join(pluginDir, 'package.json'))) {
    return { ok: false, message: `plugin/package.json missing at ${pluginDir}` };
  }
  try {
    execSync('npm install --ignore-scripts --no-audit --no-fund', {
      cwd: pluginDir,
      stdio: 'pipe',
      encoding: 'utf-8',
    });
    return { ok: true, message: 'plugin/node_modules populated' };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// .env parse/serialize helpers — minimal duplication of EnvManager so this
// module stays decoupled from the existing Anthropic credential-only schema.
// ---------------------------------------------------------------------------

export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) result[key] = value;
  }
  return result;
}

export function serializeEnvFile(env: Record<string, string>): string {
  const lines: string[] = [
    '# claude-mem credentials and runtime config',
    '# This file is managed by `claude-mem install`. Hand-edit at your own risk.',
    '',
  ];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value === null) continue;
    const str = String(value);
    // Quote whenever the value contains whitespace, '#', '=', or a literal
    // double-quote so the round-trip via parseEnvFile is lossless. Embedded
    // double-quotes are backslash-escaped inside the quoted form.
    const needsQuotes = /[\s#="]/.test(str) || str === '';
    const escaped = str.replace(/"/g, '\\"');
    lines.push(`${key}=${needsQuotes ? `"${escaped}"` : str}`);
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Re-exports for tests
// ---------------------------------------------------------------------------

export const __internal__ = {
  checkDockerInstalled,
  ensurePostgresEnv,
  ensureDockerComposeOverride,
  ensurePluginNodeModules,
  parseEnvFile,
  serializeEnvFile,
};
