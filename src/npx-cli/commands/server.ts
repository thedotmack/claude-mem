import { styleText } from 'node:util';
import { readFlatSettings } from '../utils/settings.js';
import {
  runServerApiKeyCommand,
  spawnBunServerCommand,
  spawnBunWorkerCommand,
} from './runtime.js';

function printServerUsage(): void {
  console.error(`Usage: ${styleText('bold', 'npx claude-mem server <command>')}`);
  console.error('Commands: start, stop, restart, status, api-key create|list|revoke, keys rotate, worker start, jobs status|failed|retry|cancel');
}

const LIFECYCLE_VERBS = new Set(['start', 'stop', 'restart', 'status']);

export async function runServerCommand(argv: string[] = []): Promise<void> {
  const subCommand = argv[0]?.toLowerCase();

  if (!subCommand) {
    printServerUsage();
    process.exit(1);
  }

  if (LIFECYCLE_VERBS.has(subCommand)) {
    spawnBunServerCommand(subCommand);
    return;
  }

  if (subCommand === 'api-key') {
    const apiKeyCommand = argv[1]?.toLowerCase();
    if (apiKeyCommand === 'create' || apiKeyCommand === 'list' || apiKeyCommand === 'revoke') {
      runServerApiKeyCommand(argv.slice(1));
      return;
    }
    console.error(styleText('red', `Unknown server api-key subcommand: ${apiKeyCommand ?? '(none)'}`));
    console.error('Usage: npx claude-mem server api-key create|list|revoke');
    process.exit(1);
  }

  if (subCommand === 'worker') {
    const workerCommand = argv[1]?.toLowerCase();
    if (workerCommand === 'start') {
      // Phase 10 — start the BullMQ generation worker (no HTTP). Use this in
      // Compose to scale generation horizontally while a single (or multiple)
      // HTTP-only server replicas serve writes/reads.
      spawnBunServerCommand('worker', ['start']);
      return;
    }
    console.error(styleText('red', `Unknown server worker subcommand: ${workerCommand ?? '(none)'}`));
    console.error('Usage: npx claude-mem server worker start');
    process.exit(1);
  }

  if (subCommand === 'keys') {
    const keysCommand = argv[1]?.toLowerCase();
    if (keysCommand === 'rotate') {
      await runServerKeysRotateCommand();
      return;
    }
    console.error(styleText('red', `Unknown server keys subcommand: ${keysCommand ?? '(none)'}`));
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

  console.error(styleText('red', `Unknown server command: ${subCommand}`));
  printServerUsage();
  process.exit(1);
}

async function runServerKeysRotateCommand(): Promise<void> {
  if (!process.env.CLAUDE_MEM_SERVER_DATABASE_URL) {
    console.error(styleText('red', 'Cannot rotate server API key: CLAUDE_MEM_SERVER_DATABASE_URL is not set.'));
    console.error('Configure Postgres first, then re-run this command.');
    process.exit(1);
  }
  const { rotateServerApiKey, persistServerSettings } = await import(
    '../../services/hooks/server-bootstrap.js'
  );
  const { SettingsDefaultsManager } = await import('../../shared/SettingsDefaultsManager.js');
  const { join } = await import('path');

  const settingsPath = join(SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR'), 'settings.json');
  let previousApiKeyId: string | null = null;
  try {
    const flat = readFlatSettings(settingsPath);
    // Phase 1d: read the new canonical key first, fall back to the
    // legacy `CLAUDE_MEM_SERVER_BETA_API_KEY` so rotations work for
    // both fresh installs and pre-rename installs.
    const previousKey = flat?.CLAUDE_MEM_SERVER_API_KEY ?? flat?.CLAUDE_MEM_SERVER_BETA_API_KEY;
    if (typeof previousKey === 'string' && previousKey.length > 0) {
      previousApiKeyId = await lookupApiKeyIdByPlaintext(previousKey);
    }
  } catch {
    // ignore — we'll just generate a new key without revoking the old one
  }

  const result = await rotateServerApiKey({ previousApiKeyId });
  persistServerSettings(settingsPath, {
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
  const { hashApiKey } = await import('../../services/hooks/server-bootstrap.js');
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

  if (!subCommand || !LIFECYCLE_VERBS.has(subCommand)) {
    console.error(styleText('red', `Unknown worker command: ${subCommand ?? '(none)'}`));
    console.error('Usage: npx claude-mem worker start|stop|restart|status');
    process.exit(1);
  }
  spawnBunWorkerCommand(subCommand);
}
