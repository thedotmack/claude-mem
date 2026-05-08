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
    if (apiKeyCommand === 'create' || apiKeyCommand === 'list' || apiKeyCommand === 'revoke') {
      runServerApiKeyCommand(argv.slice(1));
      return;
    }
    console.error(pc.red(`Unknown server api-key subcommand: ${apiKeyCommand ?? '(none)'}`));
    console.error('Usage: npx claude-mem server api-key create|list|revoke');
    process.exit(1);
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
    // Phase 12 — operator queue console. Uses Postgres (canonical) +
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
  const config = parsePostgresConfig({ requireDatabaseUrl: true });
  if (!config) return null;
  const pool = createPostgresPool(config);
  try {
    const result = await pool.query<{ id: string }>(
      'SELECT id FROM api_keys WHERE key_hash = $1 LIMIT 1',
      [hashApiKey(rawKey)],
    );
    return result.rows[0]?.id ?? null;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

export function runWorkerAliasCommand(argv: string[] = []): void {
  const subCommand = argv[0]?.toLowerCase();

  if (!subCommand || !runWorkerLifecycleCommand(subCommand)) {
    console.error(pc.red(`Unknown worker command: ${subCommand ?? '(none)'}`));
    console.error('Usage: npx claude-mem worker start|stop|restart|status');
    process.exit(1);
  }
}
