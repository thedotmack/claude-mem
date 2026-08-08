/**
 * `npx claude-mem setup` — change configuration (LLM provider, observation
 * model, Claude Code auto-memory) on an existing installation without
 * re-running the full installer. Reuses the exact prompt flows from
 * `install`, so the two paths can never drift, then restarts the worker so
 * the new settings take effect immediately.
 *
 * Full (re)installs remain the path for anything that touches installed
 * files: IDE hook setup, runtime switching (worker ⇄ server), and version
 * updates (`npx claude-mem update`).
 */
import * as p from '@clack/prompts';
import { styleText } from 'node:util';
import { existsSync } from 'fs';
import { join } from 'path';
import { SettingsDefaultsManager, type SettingsDefaults } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { ensureWorkerStarted } from '../../services/worker-spawner.js';
import { shutdownWorkerAndWait } from '../../services/install/shutdown-helper.js';
import { captureCliEvent } from '../../services/telemetry/cli-telemetry.js';
import {
  isPluginInstalled,
  marketplaceDirectory,
  pluginCacheDirectory,
  readPluginVersion,
} from '../utils/paths.js';
import {
  disableClaudeAutoMemory,
  promptClaudeModel,
  promptProvider,
  type InstallOptions,
} from './install.js';

const isInteractive = process.stdin.isTTY === true;

const log = {
  info: (msg: string) => isInteractive ? p.log.info(msg) : console.log(`  ${msg}`),
  success: (msg: string) => isInteractive ? p.log.success(msg) : console.log(`  ${msg}`),
  warn: (msg: string) => isInteractive ? p.log.warn(msg) : console.warn(`  ${msg}`),
  error: (msg: string) => isInteractive ? p.log.error(msg) : console.error(`  ${msg}`),
};

function getSetting<K extends keyof SettingsDefaults>(key: K): SettingsDefaults[K] {
  return SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH)[key];
}

/**
 * Render the currently stored configuration as display lines. Pure over the
 * flat settings record so it stays unit-testable without a TTY or a real
 * ~/.claude-mem/settings.json.
 */
export function formatCurrentConfig(settings: Record<string, unknown>): string[] {
  const read = (key: string): string => {
    const value = settings[key];
    return typeof value === 'string' ? value.trim() : '';
  };

  const provider = read('CLAUDE_MEM_PROVIDER') || 'claude';
  // Phase 1d dual-accept: stored `server-beta` displays as the canonical `server`.
  const storedRuntime = read('CLAUDE_MEM_RUNTIME') || 'worker';
  const runtime = storedRuntime === 'server-beta' ? 'server' : storedRuntime;

  const lines = [`provider  ${provider}`];
  if (provider === 'claude') {
    const authMethod = read('CLAUDE_MEM_CLAUDE_AUTH_METHOD');
    if (authMethod) {
      lines[0] = `provider  ${provider} (${authMethod})`;
    }
    const model = read('CLAUDE_MEM_MODEL');
    lines.push(`model     ${model || '(default)'}`);
  }
  lines.push(`runtime   ${runtime}`);
  return lines;
}

/**
 * First candidate worker script that actually exists, or `undefined` when none
 * do. Pure over the existence check so the "no script → don't touch the running
 * worker" guarantee is testable without a real plugin tree.
 */
export function selectWorkerScriptPath(
  candidates: string[],
  exists: (path: string) => boolean,
): string | undefined {
  return candidates.find((candidate) => exists(candidate));
}

export async function runSetupCommand(options: InstallOptions = {}): Promise<void> {
  const version = readPluginVersion();

  if (!isPluginInstalled()) {
    log.error('claude-mem is not installed yet — nothing to configure.');
    log.info(`Run ${styleText('cyan', 'npx claude-mem install')} first.`);
    process.exit(1);
  }

  if (isInteractive) {
    p.intro(styleText(['bgCyan', 'black'], ' claude-mem setup '));
  } else {
    console.log('claude-mem setup');
  }
  log.info(`${styleText('bold', 'claude-mem')} ${styleText('cyan', `v${version}`)} ${styleText('dim', '·')} editing ~/.claude-mem/settings.json in place`);

  const current = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH) as unknown as Record<string, unknown>;
  for (const line of formatCurrentConfig(current)) {
    log.info(styleText('dim', line));
  }

  const selectedProvider = await promptProvider(options);
  if (selectedProvider === 'claude') {
    await promptClaudeModel(options);
  }

  if (options.disableAutoMemory) {
    const wrote = disableClaudeAutoMemory();
    if (wrote) {
      log.success('Claude Code: auto-memory disabled (CLAUDE_CODE_DISABLE_AUTO_MEMORY=1).');
    } else {
      log.info('Claude Code: auto-memory already disabled, leaving settings.json untouched.');
    }
  }

  // Apply the change. The worker reads settings at startup, so a saved
  // provider/model only takes effect after a restart. The server runtime has
  // its own daemon lifecycle — point at `server restart` instead of touching
  // the worker path.
  const storedRuntime = String(getSetting('CLAUDE_MEM_RUNTIME') || 'worker');
  const isServerRuntime = storedRuntime === 'server' || storedRuntime === 'server-beta';

  let restartNote = '';
  if (isServerRuntime) {
    restartNote = `Run ${styleText('cyan', 'npx claude-mem server restart')} for the new settings to take effect.`;
  } else if (options.noAutoStart || !isInteractive) {
    restartNote = `Run ${styleText('cyan', 'npx claude-mem restart')} for the new settings to take effect.`;
  } else {
    const port = Number(getSetting('CLAUDE_MEM_WORKER_PORT'));
    // Resolve the script BEFORE stopping anything. `ensureWorkerStarted` only
    // rejects a missing script *after* the shutdown has already landed, so
    // picking an unchecked fallback path would turn a settings-only `setup`
    // into an outage: the healthy worker gets killed with nothing to replace it.
    const workerScriptCandidates = [
      join(marketplaceDirectory(), 'plugin', 'scripts', 'worker-service.cjs'),
      join(pluginCacheDirectory(version), 'scripts', 'worker-service.cjs'),
    ];

    if (!selectWorkerScriptPath(workerScriptCandidates, existsSync)) {
      log.warn('Worker script missing from both the marketplace and the plugin cache — leaving the running worker alone.');
      restartNote = `Settings are saved. Run ${styleText('cyan', 'npx claude-mem repair')} to restore the runtime, then ${styleText('cyan', 'npx claude-mem restart')}.`;
    } else {
      const spinner = p.spinner();
      spinner.start('Restarting worker so the new settings take effect…');
      try {
        await shutdownWorkerAndWait(port, 10000);
        // Re-resolve after the shutdown rather than reusing the path from
        // above: `install`/`update` replace these directories with rmSync +
        // cpSync, so a concurrent run can delete the chosen script while we
        // wait. Re-resolving starts from whichever copy exists *now*, and an
        // empty result means the tree is mid-replacement — say so instead of
        // handing ensureWorkerStarted a path that has since vanished.
        const scriptPath = selectWorkerScriptPath(workerScriptCandidates, existsSync);
        if (!scriptPath) {
          spinner.stop(`Worker script vanished mid-restart — a concurrent ${styleText('cyan', 'install')}/${styleText('cyan', 'update')} is likely replacing it ${styleText('yellow', '!')}`);
          restartNote = `Run ${styleText('cyan', 'npx claude-mem start')} once that finishes.`;
        } else {
          const startResult = await ensureWorkerStarted(port, scriptPath);
          switch (startResult) {
            case 'ready':
              spinner.stop(`Worker restarted at http://localhost:${port} ${styleText('green', 'OK')}`);
              break;
            case 'warming':
              spinner.stop(`Worker restarting on port ${port} — finishing in background ${styleText('yellow', '⏳')}`);
              break;
            case 'dead':
              spinner.stop(`Worker did not come back — run ${styleText('cyan', 'npx claude-mem start')} manually ${styleText('yellow', '!')}`);
              break;
          }
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        spinner.stop(`Worker restart failed: ${message}`);
        restartNote = `Run ${styleText('cyan', 'npx claude-mem restart')} for the new settings to take effect.`;
      }
    }
  }

  await captureCliEvent('setup_completed', {
    provider: selectedProvider,
    cli_version: version,
  });

  if (isInteractive) {
    p.outro(styleText('green', 'Settings saved.') + (restartNote ? ` ${restartNote}` : ''));
  } else {
    console.log(`Settings saved.${restartNote ? ` ${restartNote}` : ''}`);
  }
}
