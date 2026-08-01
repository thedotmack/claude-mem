import { styleText } from 'node:util';
import { readFlatSettings } from '../utils/settings.js';
import {
  runServerRestartCommand,
  runServerStartCommand,
  runServerStatusCommand,
  runServerStopCommand,
  runServerWorkerStartCommand,
  runRestartCommand,
  runServerApiKeyCommand,
  runStartCommand,
  runStatusCommand,
  runStopCommand,
} from './runtime.js';

function printServerUsage(): void {
  console.error(`Usage: ${styleText('bold', 'npx claude-mem server <command>')}`);
  console.error('Commands: start, stop, restart, status, api-key create|list|revoke, keys rotate, worker start, jobs status|failed|retry|cancel');
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

function runServerLifecycleCommand(command: string): boolean {
  switch (command) {
    case 'start':
      runServerStartCommand();
      return true;
    case 'stop':
      runServerStopCommand();
      return true;
    case 'restart':
      runServerRestartCommand();
      return true;
    case 'status':
      runServerStatusCommand();
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

  if (runServerLifecycleCommand(subCommand)) {
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
      runServerWorkerStartCommand();
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
  const { rotateServerApiKey, revokeServerApiKey, persistServerSettings, canPersistServerSettings } = await import(
    '../../services/hooks/server-bootstrap.js'
  );
  const { USER_SETTINGS_PATH: settingsPath } = await import('../../shared/paths.js');

  // Up-front writability check: refuse before revoking the old key so a
  // corrupt or non-object settings file never causes credential loss.
  if (!canPersistServerSettings(settingsPath)) {
    console.error(styleText('red', 'Cannot rotate: existing settings.json is corrupt or not a JSON object.'));
    console.error('Repair or restore the file, then re-run this command.');
    process.exit(1);
  }

  let previousApiKeyId: string | null = null;
  let currentApiKey: string | null = null;
  let currentProjectId: string | null = null;
  try {
    const flat = readFlatSettings(settingsPath);
    // Phase 1d: read the new canonical key first, fall back to the
    // legacy `CLAUDE_MEM_SERVER_BETA_API_KEY` so rotations work for
    // both fresh installs and pre-rename installs.
    const previousKeyId = flat?.CLAUDE_MEM_SERVER_PREVIOUS_API_KEY_ID;
    if (typeof previousKeyId === 'string' && previousKeyId.length > 0) {
      previousApiKeyId = previousKeyId;
    }
    const previousKey = flat?.CLAUDE_MEM_SERVER_API_KEY ?? flat?.CLAUDE_MEM_SERVER_BETA_API_KEY;
    if (typeof previousKey === 'string' && previousKey.length > 0) {
      currentApiKey = previousKey;
    }
    const projectId = flat?.CLAUDE_MEM_SERVER_PROJECT_ID ?? flat?.CLAUDE_MEM_SERVER_BETA_PROJECT_ID;
    if (typeof projectId === 'string' && projectId.length > 0) {
      currentProjectId = projectId;
    }
    if (!previousApiKeyId && typeof previousKey === 'string' && previousKey.length > 0) {
      previousApiKeyId = await lookupApiKeyIdByPlaintext(previousKey);
    }
  } catch {
    // ignore — we'll just generate a new key without revoking the old one
  }

  // A prior rotation may have saved the current credential while its old-key
  // revocation failed. Resolve that pending revocation in place; creating a
  // third key would leave the saved current key active but untracked.
  if (previousApiKeyId) {
    if (!currentApiKey || !currentProjectId) {
      console.error(styleText('red', 'Cannot resume rotation: the pending retry marker has no current credential.'));
      console.error('Repair or restore settings.json before rotating again.');
      process.exit(1);
    }
    try {
      await revokeServerApiKey(previousApiKeyId);
    } catch {
      console.error(styleText('red', 'Cannot finish the pending rotation: the previous API key could not be revoked.'));
      console.error('The current API key remains active and is still recorded in settings.json. Retry after confirming Postgres is available.');
      process.exit(1);
    }
    if (!persistServerSettings(settingsPath, { apiKey: currentApiKey, projectId: currentProjectId })) {
      console.error(styleText('red', 'The previous API key was revoked, but the retry marker could not be removed from settings.json.'));
      console.error('Repair settings.json before rotating again.');
      process.exit(1);
    }
    console.log(JSON.stringify({
      rotated: true,
      retryResolved: true,
      settingsPath,
    }, null, 2));
    return;
  }

  let result: Awaited<ReturnType<typeof rotateServerApiKey>>;
  let settingsPersisted = false;
  try {
    result = await rotateServerApiKey({
      previousApiKeyId,
      beforeRevoke: next => {
        if (!persistServerSettings(settingsPath, {
          apiKey: next.rawKey,
          projectId: next.projectId,
          previousApiKeyId,
        })) {
          throw new Error('settings.json could not be updated');
        }
        settingsPersisted = true;
      },
    });
  } catch {
    if (settingsPersisted) {
      console.error(styleText('red', 'A new API key was saved, but revoking the previous key failed.'));
      console.error('Retry the rotation after confirming Postgres is available.');
    } else {
      console.error(styleText('red', 'Cannot rotate: settings.json was not updated, so the existing API key remains active.'));
      console.error('Repair or restore the file, then re-run this command.');
    }
    process.exit(1);
  }
  let cleanupPersisted = false;
  try {
    cleanupPersisted = persistServerSettings(settingsPath, {
      apiKey: result.rawKey,
      projectId: result.projectId,
    });
  } catch {
    cleanupPersisted = false;
  }
  if (!cleanupPersisted) {
    let retryMarkerPersisted = false;
    try {
      retryMarkerPersisted = persistServerSettings(settingsPath, {
        apiKey: result.rawKey,
        projectId: result.projectId,
        previousApiKeyId: result.apiKeyId,
      });
    } catch {
      retryMarkerPersisted = false;
    }
    if (!retryMarkerPersisted) {
      console.error(styleText('red', 'The new API key is active, but its retry marker could not be saved. Repair settings.json before rotating again.'));
      process.exit(1);
    }
    console.error('The new API key is active; its ID was saved for the next rotation retry.');
    process.exit(1);
  }
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

  if (!subCommand || !runWorkerLifecycleCommand(subCommand)) {
    console.error(styleText('red', `Unknown worker command: ${subCommand ?? '(none)'}`));
    console.error('Usage: npx claude-mem worker start|stop|restart|status');
    process.exit(1);
  }
}
