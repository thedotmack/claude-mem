import pc from 'picocolors';
import {
  runServerBetaRestartCommand,
  runServerBetaStartCommand,
  runServerBetaStatusCommand,
  runServerBetaStopCommand,
  runServerBetaWorkerStartCommand,
  runRestartCommand,
  runServerApiKeyCommand,
  runStartCommand,
  runStatusCommand,
  runStopCommand,
} from './runtime.js';

const UNSUPPORTED_SERVER_COMMANDS = new Set([
  'logs',
  'doctor',
  'migrate',
  'export',
  'import',
]);

function printServerUsage(): void {
  console.error(`Usage: ${pc.bold('npx claude-mem server <command>')}`);
  console.error('Commands: start, stop, restart, status, logs, doctor, migrate, export, import, api-key create|list|revoke, keys rotate, worker start, jobs status|failed|retry|cancel');
}

function failUnsupported(command: string): never {
  console.error(pc.red(`Server command not implemented yet: ${command}`));
  console.error('This CLI route is reserved for the server runtime, but no backend API exists for it yet.');
  process.exit(1);
}

function runWorkerLifecycleCommand(command: string): boolean {
  switch (command) {
    case 'start':
      runStartCommand();
      return true;
    case 'stop':
      runStopCommand();
      return true;
    case 'restart':
      runRestartCommand();
      return true;
    case 'status':
      runStatusCommand();
      return true;
    default:
      return false;
  }
}

function runServerBetaLifecycleCommand(command: string): boolean {
  switch (command) {
    case 'start':
      runServerBetaStartCommand();
      return true;
    case 'stop':
      runServerBetaStopCommand();
      return true;
    case 'restart':
      runServerBetaRestartCommand();
      return true;
    case 'status':
      runServerBetaStatusCommand();
      return true;
    default:
      return false;
  }
}

export async function runServerCommand(argv: string[] = []): Promise<void> {
  const subCommand = argv[0]?.toLowerCase();

  if (!subCommand) {
    printServerUsage();
    process.exit(1);
  }

  if (UNSUPPORTED_SERVER_COMMANDS.has(subCommand)) {
    failUnsupported(`server ${subCommand}`);
  }

  if (runServerBetaLifecycleCommand(subCommand)) {
    return;
  }

  if (subCommand === 'api-key') {
    const apiKeyCommand = argv[1]?.toLowerCase();
    if (apiKeyCommand !== 'create' && apiKeyCommand !== 'list' && apiKeyCommand !== 'revoke') {
      console.error(pc.red(`Unknown server api-key subcommand: ${apiKeyCommand ?? '(none)'}`));
      console.error('Usage: npx claude-mem server api-key create|list|revoke');
      process.exit(1);
    }
    // fix — when CLAUDE_MEM_RUNTIME=server-beta the worker SQLite
    // backend is invisible (server-beta reads from Postgres). Route to a
    // Postgres-aware path that writes to the api_keys table the running
    // server actually consumes; otherwise the worker rejects every call
    // with 403 and the operator has no way to recover.
    const runtime = (process.env.CLAUDE_MEM_RUNTIME ?? '').trim().toLowerCase();
    if (runtime === 'server-beta') {
      await runServerBetaApiKeyCommand(apiKeyCommand, argv.slice(2));
      return;
    }
    runServerApiKeyCommand(argv.slice(1));
    return;
  }

  if (subCommand === 'worker') {
    const workerCommand = argv[1]?.toLowerCase();
    if (workerCommand === 'start') {
      runServerBetaWorkerStartCommand();
      return;
    }
    console.error(pc.red(`Unknown server worker subcommand: ${workerCommand ?? '(none)'}`));
    console.error('Usage: npx claude-mem server worker start');
    process.exit(1);
  }

  if (subCommand === 'keys') {
    const keysCommand = argv[1]?.toLowerCase();
    if (keysCommand === 'rotate') {
      await runServerBetaKeysRotateCommand();
      return;
    }
    console.error(pc.red(`Unknown server keys subcommand: ${keysCommand ?? '(none)'}`));
    console.error('Usage: npx claude-mem server keys rotate');
    process.exit(1);
  }

  if (subCommand === 'jobs') {
    // operator queue console. Uses Postgres (canonical) +
    // BullMQ (transport) directly. See src/npx-cli/commands/server-jobs.ts.
    const { runServerJobsCommand } = await import('./server-jobs.js');
    await runServerJobsCommand(argv.slice(1));
    return;
  }

  console.error(pc.red(`Unknown server command: ${subCommand}`));
  printServerUsage();
  process.exit(1);
}

async function runServerBetaKeysRotateCommand(): Promise<void> {
  if (!process.env.CLAUDE_MEM_SERVER_DATABASE_URL) {
    console.error(pc.red('Cannot rotate server-beta API key: CLAUDE_MEM_SERVER_DATABASE_URL is not set.'));
    console.error('Configure Postgres first, then re-run this command.');
    process.exit(1);
  }
  const { rotateServerBetaApiKey, persistServerBetaSettings } = await import(
    '../../services/hooks/server-beta-bootstrap.js'
  );
  const { SettingsDefaultsManager } = await import('../../shared/SettingsDefaultsManager.js');
  const { join } = await import('path');
  const { existsSync, readFileSync } = await import('fs');

  const settingsPath = join(SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR'), 'settings.json');
  let previousApiKeyId: string | null = null;
  if (existsSync(settingsPath)) {
    try {
      const raw = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
      const flat = (raw.env && typeof raw.env === 'object' ? raw.env : raw) as Record<string, unknown>;
      const previousKey = flat.CLAUDE_MEM_SERVER_BETA_API_KEY;
      if (typeof previousKey === 'string' && previousKey.length > 0) {
        previousApiKeyId = await lookupApiKeyIdByPlaintext(previousKey);
      }
    } catch {
      // ignore — we'll just generate a new key without revoking the old one
    }
  }

  const result = await rotateServerBetaApiKey({ previousApiKeyId });
  persistServerBetaSettings(settingsPath, {
    apiKey: result.rawKey,
    projectId: result.projectId,
  });
  console.log(JSON.stringify({
    rotated: true,
    apiKeyId: result.apiKeyId,
    teamId: result.teamId,
    projectId: result.projectId,
    settingsPath,
  }, null, 2));
}

async function lookupApiKeyIdByPlaintext(rawKey: string): Promise<string | null> {
  const { createPostgresPool } = await import('../../storage/postgres/pool.js');
  const { parsePostgresConfig } = await import('../../storage/postgres/config.js');
  const { hashApiKey } = await import('../../services/hooks/server-beta-bootstrap.js');
  const { verifyKeyHash } = await import('../../server/middleware/postgres-auth.js');
  const config = parsePostgresConfig({ requireDatabaseUrl: true });
  if (!config) return null;
  const pool = createPostgresPool(config);
  try {
    // Fast path: legacy SHA-256 lookup by indexed equality.
    const sha256Hex = hashApiKey(rawKey);
    const legacy = await pool.query<{ id: string }>(
      'SELECT id FROM api_keys WHERE key_hash = $1 LIMIT 1',
      [sha256Hex],
    );
    if (legacy.rows[0]) return legacy.rows[0].id;
    // fallback: argon2id rows cannot be looked up by equality.
    // Scan candidate rows and verify each against the raw key. Capped at
    // CLI_ARGON2_SCAN_LIMIT to bound worst-case latency (~50ms per verify);
    // operators with more active argon2 keys per tenant should rotate using
    // the key id directly rather than the plaintext.
    const argonRows = await pool.query<{ id: string; key_hash: string }>(
      `SELECT id, key_hash FROM api_keys
         WHERE key_hash LIKE '$argon2%'
           AND revoked_at IS NULL
         LIMIT 50`,
    );
    for (const row of argonRows.rows) {
      if (await verifyKeyHash(rawKey, row.key_hash)) {
        return row.id;
      }
    }
    return null;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

// fix — Postgres-aware api-key CLI for the server-beta runtime.
// Mirrors `runServerApiKeyCommand` (which is SQLite-only) so
// `claude-mem server api-key {create|list|revoke}` writes to the same
// api_keys table the running server-beta consumes. Otherwise the CLI
// produces keys the server cannot see and every call returns 403.
async function runServerBetaApiKeyCommand(
  subCommand: 'create' | 'list' | 'revoke',
  extraArgs: string[],
): Promise<void> {
  if (!process.env.CLAUDE_MEM_SERVER_DATABASE_URL) {
    console.error(pc.red('CLAUDE_MEM_SERVER_DATABASE_URL is required when CLAUDE_MEM_RUNTIME=server-beta.'));
    console.error('Configure Postgres first, then re-run this command.');
    process.exit(1);
  }
  const { createPostgresPool } = await import('../../storage/postgres/pool.js');
  const { parsePostgresConfig } = await import('../../storage/postgres/config.js');
  const { PostgresAuthRepository } = await import('../../storage/postgres/auth.js');
  const config = parsePostgresConfig({ requireDatabaseUrl: true });
  if (!config) {
    console.error(pc.red('CLAUDE_MEM_SERVER_DATABASE_URL parse failed.'));
    process.exit(1);
  }
  const pool = createPostgresPool(config);
  const repo = new PostgresAuthRepository(pool);
  const options = parseFlagArgs(extraArgs);

  try {
    if (subCommand === 'create') {
      const { bootstrapServerBetaApiKey, createRawApiKey, hashApiKeyForStorage } = await import(
        '../../services/hooks/server-beta-bootstrap.js'
      );
      const scopes = (options.scope ?? options.scopes ?? 'memories:read')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      // Reuse the bootstrap to get-or-create the local-hook team/project,
      // then create a NEW key under those IDs with the caller-requested
      // scopes. The bootstrap key uses the narrower hook scopes which are
      // the wrong default for an arbitrary CLI-issued key.
      let teamId = options.team ?? null;
      let projectId = options.project ?? null;
      if (!teamId || !projectId) {
        const bootstrap = await bootstrapServerBetaApiKey({ pool, closePool: false });
        teamId = bootstrap.teamId;
        projectId = bootstrap.projectId;
      }
      // Resolve --expires-in (e.g. '30d', '12h', '90m') to a Date for the
      // repo call. Without this the flag was silently dropped and every
      // CLI-issued key was effectively non-expiring.
      const expiresInRaw = options['expires-in'] ?? options.expiresIn ?? null;
      const expiresAt = expiresInRaw ? parseExpiresIn(expiresInRaw) : undefined;
      const keyName = options.name ?? 'server-api-key';
      const rawKey = createRawApiKey();
      // fix: hash via argon2id, not legacy SHA-256.
      const keyHash = await hashApiKeyForStorage(rawKey);
      const created = await repo.createApiKey({
        keyHash,
        teamId,
        projectId,
        scopes,
        name: keyName,
        ...(expiresAt ? { expiresAt } : {}),
        actorId: 'system:server-beta-cli',
      });
      await repo.createAuditLog({
        teamId,
        projectId,
        actorId: 'system:server-beta-cli',
        apiKeyId: created.id,
        action: 'api_key.create',
        resourceType: 'api_key',
        resourceId: created.id,
        details: { source: 'cli:server api-key create' },
      });
      console.log(JSON.stringify({
        id: created.id,
        key: rawKey,
        name: keyName,
        teamId,
        projectId,
        scopes,
      }, null, 2));
      return;
    }

    if (subCommand === 'list') {
      const teamFilter = options.team ?? null;
      const limit = options.limit ? Number.parseInt(options.limit, 10) : 100;
      const offset = options.offset ? Number.parseInt(options.offset, 10) : 0;
      const keys = await repo.listApiKeys({ teamId: teamFilter, limit, offset });
      console.log(JSON.stringify({
        teamId: teamFilter,
        limit,
        offset,
        count: keys.length,
        keys: keys.map(key => ({
          id: key.id,
          teamId: key.teamId,
          projectId: key.projectId,
          scopes: key.scopes,
          status: key.revokedAtEpoch ? 'revoked' : 'active',
          revokedAt: key.revokedAtEpoch ? new Date(key.revokedAtEpoch).toISOString() : null,
          expiresAt: key.expiresAtEpoch ? new Date(key.expiresAtEpoch).toISOString() : null,
          createdAt: new Date(key.createdAtEpoch).toISOString(),
        })),
      }, null, 2));
      return;
    }

    if (subCommand === 'revoke') {
      const id = extraArgs.find(arg => arg && !arg.startsWith('--'));
      if (!id) {
        // Throw — not process.exit — so the finally block below cleanly
        // closes the postgres pool. process.exit() short-circuits finally.
        console.error(pc.red('Usage: claude-mem server api-key revoke <id>'));
        throw new CliExitError(1);
      }
      const revoked = await repo.revokeApiKey(id);
      if (!revoked) {
        console.error(pc.red(`API key not found or already revoked: ${id}`));
        throw new CliExitError(1);
      }
      await repo.createAuditLog({
        teamId: revoked.teamId,
        projectId: revoked.projectId,
        actorId: 'system:server-beta-cli',
        apiKeyId: revoked.id,
        action: 'api_key.revoke',
        resourceType: 'api_key',
        resourceId: revoked.id,
        details: { source: 'cli:server api-key revoke' },
      });
      console.log(JSON.stringify({ id: revoked.id, status: 'revoked' }, null, 2));
      return;
    }
  } catch (err) {
    if (err instanceof CliExitError) {
      await pool.end().catch(() => undefined);
      process.exit(err.code);
    }
    throw err;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

// Internal marker exception so a CLI exit signal can travel up through
// try/finally cleanly, letting the pool.end() in the finally block run
// before the process actually exits. process.exit() in raw form would
// skip the finally and leave the pool's connections in an abrupt-close
// state on the Postgres side.
class CliExitError extends Error {
  constructor(public readonly code: number) { super(`CLI exit ${code}`); }
}

// Parse --expires-in flag values like '30d', '12h', '45m', '900s' into a
// future Date. Throws on unrecognised units so a typo doesn't silently turn
// into a non-expiring key (which would defeat the operator's intent).
function parseExpiresIn(raw: string): Date {
  const match = /^(\d+)\s*([smhdwy])$/i.exec(raw.trim());
  if (!match) {
    throw new Error(`Invalid --expires-in value '${raw}'. Expected e.g. '30d', '12h', '45m', '900s'.`);
  }
  const n = Number.parseInt(match[1]!, 10);
  const unit = match[2]!.toLowerCase();
  const seconds = unit === 's' ? n
    : unit === 'm' ? n * 60
    : unit === 'h' ? n * 3600
    : unit === 'd' ? n * 86400
    : unit === 'w' ? n * 86400 * 7
    : unit === 'y' ? n * 86400 * 365
    : 0;
  if (!seconds) {
    throw new Error(`Invalid --expires-in unit '${unit}'. Use one of s|m|h|d|w|y.`);
  }
  return new Date(Date.now() + seconds * 1000);
}

// Lightweight flag parser shared by runServerBetaApiKeyCommand. Mirrors the
// ServerBetaService CLI helper without coupling to that bundle.
function parseFlagArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg || !arg.startsWith('--')) continue;
    const equalsIdx = arg.indexOf('=');
    if (equalsIdx > -1) {
      out[arg.slice(2, equalsIdx)] = arg.slice(equalsIdx + 1);
    } else {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[arg.slice(2)] = next;
        i += 1;
      } else {
        out[arg.slice(2)] = 'true';
      }
    }
  }
  return out;
}

export function runWorkerAliasCommand(argv: string[] = []): void {
  const subCommand = argv[0]?.toLowerCase();

  if (!subCommand || !runWorkerLifecycleCommand(subCommand)) {
    console.error(pc.red(`Unknown worker command: ${subCommand ?? '(none)'}`));
    console.error('Usage: npx claude-mem worker start|stop|restart|status');
    process.exit(1);
  }
}
