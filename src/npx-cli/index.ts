import { parseArgs, styleText } from 'node:util';
import { readPluginVersion } from './utils/paths.js';
import type { InstallOptions } from './commands/install.js';
import { resolveInstallerProviderChoice } from './installer-provider-choice.js';

const args = process.argv.slice(2);
const firstArg = args[0]?.toLowerCase() ?? '';
// If the first token is a flag (e.g. `npx claude-mem --provider claude`),
// treat the invocation as `install` with those flags. Help/version flags are
// handled directly so they don't get swallowed by the install path.
const HELP_OR_VERSION_FLAGS = new Set(['-h', '--help', '-v', '--version']);
const command =
  firstArg.startsWith('-') && !HELP_OR_VERSION_FLAGS.has(firstArg)
    ? 'install'
    : firstArg;

function printHelp(): void {
  const version = readPluginVersion();

  console.log(`
${styleText('bold', 'claude-mem')} v${version} — persistent memory for AI coding assistants

${styleText('bold', 'Install Commands')} (no Bun required):
  ${styleText('cyan', 'npx claude-mem')}                     Interactive install
  ${styleText('cyan', 'npx claude-mem install')}              Interactive install
  ${styleText('cyan', 'npx claude-mem install --ide <id>')}   Install for specific IDE
  ${styleText('cyan', 'npx claude-mem install --ide dsh --dsh-profile <name>')}   Install DeepSeek Harness (default profile: web)
  ${styleText('cyan', 'npx claude-mem install --provider claude|codex|gemini|openrouter|host')}   Set LLM provider (optional non-interactively; a fresh install defaults to claude). claude and host need no account; codex, gemini, openrouter and an interactive install without --provider first sign in to cmem.ai in the browser, unless a non-interactive run keeps the provider already in settings
  ${styleText('cyan', 'npx claude-mem install --model <id>')}   Set Claude or Codex model (when provider=claude|codex)
  ${styleText('cyan', 'npx claude-mem install --no-auto-start')}   Skip worker auto-start at the end
  ${styleText('cyan', 'npx claude-mem install --disable-auto-memory')}   Explicitly disable Claude Code native auto-memory
  ${styleText('cyan', 'npx claude-mem install --runtime worker|server')}   Select runtime non-interactively (server prints the docker compose command for pg+redis without running it, and provisions a hook API key only when CLAUDE_MEM_SERVER_DATABASE_URL is set; otherwise set CLAUDE_MEM_SERVER_DATABASE_URL before running npx claude-mem server keys rotate once Postgres is up)
  ${styleText('cyan', 'npx claude-mem install --runtime server --server-url <url>')}   Point the server runtime at a specific base URL
  ${styleText('cyan', 'npx claude-mem repair')}                Repair runtime (re-runs Bun/uv setup and bun install in plugin cache)
  ${styleText('cyan', 'npx claude-mem prune [--dry-run] [--keep <n>]')}   Remove superseded plugin cache versions (keeps newest 2 + live worker + registered install)
  ${styleText('cyan', 'npx claude-mem update')}               Update to latest version
  ${styleText('cyan', 'npx claude-mem uninstall')}            Remove plugin and configs
  ${styleText('cyan', 'npx claude-mem version')}              Print version

${styleText('bold', 'Runtime Commands')} (requires Bun, delegates to installed plugin):
  ${styleText('cyan', 'npx claude-mem start')}                Start worker service
  ${styleText('cyan', 'npx claude-mem stop')}                 Stop worker service
  ${styleText('cyan', 'npx claude-mem restart')}              Restart worker service
  ${styleText('cyan', 'npx claude-mem status')}               Show worker status
  ${styleText('cyan', 'npx claude-mem doctor')}               Diagnose install/runtime health (bun, uv, worker)
  ${styleText('cyan', 'npx claude-mem telemetry status|enable|disable')}   Manage anonymous telemetry (on by default, opt-out)
  ${styleText('cyan', 'npx claude-mem server start')}         Start server service
  ${styleText('cyan', 'npx claude-mem server stop')}          Stop server service
  ${styleText('cyan', 'npx claude-mem server restart')}       Restart server service
  ${styleText('cyan', 'npx claude-mem server status')}        Show server status
  ${styleText('cyan', 'npx claude-mem server api-key create|list|revoke')}   Manage API keys
  ${styleText('cyan', 'npx claude-mem worker start|stop|restart|status')}    Worker compatibility aliases
  ${styleText('cyan', 'npx claude-mem search <query>')}       Search observations
  ${styleText('cyan', 'npx claude-mem mcp')}                    Start the stdio MCP server
  ${styleText('cyan', 'npx claude-mem hook cursor <event>')}    Run Cursor hook forwarding
  ${styleText('cyan', 'npx claude-mem adopt [--dry-run] [--branch <name>]')}    Stamp merged worktrees into parent project
  ${styleText('cyan', 'npx claude-mem cleanup [--dry-run]')}    Run one-time v12.4.3 pollution cleanup (or preview counts)
  ${styleText('cyan', 'npx claude-mem project merge <from> <into> [--dry-run]')}    Fold one project's memory into another (non-destructive, syncs)
  ${styleText('cyan', 'npx claude-mem transcript watch')}     Start transcript watcher
  ${styleText('cyan', 'npx claude-mem antigravity-cli install|status|uninstall')}   Manage Antigravity CLI hooks + MCP config
  ${styleText('cyan', 'npx claude-mem kimi install|status|uninstall')}   Manage Kimi Code CLI hooks + MCP config
  ${styleText('cyan', 'npx claude-mem t3code status|uninstall [--settings <path>]')}   Inspect or disable T3 Code provider plugins
  ${styleText('cyan', 'npx claude-mem pi install|status|uninstall')}   Manage the native Pi extension

${styleText('bold', 'IDE Identifiers')}:
  claude-code, cursor, grok-bot, opencode, openclaw, omp, pi, dsh,
  windsurf, codex-cli, t3code (aliases: t3, t3-code), kimi, copilot-cli, antigravity, goose,
  roo-code, warp
`);
}

function parseInstallOptions(argv: string[]): InstallOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      ide: { type: 'string' },
      provider: { type: 'string' },
      model: { type: 'string' },
      runtime: { type: 'string' },
      'server-url': { type: 'string' },
      'dsh-profile': { type: 'string' },
      'no-auto-start': { type: 'boolean' },
      'disable-auto-memory': { type: 'boolean' },
    },
    strict: false,
    allowPositionals: true,
  });
  const flag = (name: string): string | undefined =>
    typeof values[name] === 'string' ? (values[name] as string) : undefined;
  const provider = flag('provider');
  if (provider !== undefined && provider !== 'claude' && provider !== 'codex' && provider !== 'gemini' && provider !== 'openrouter' && provider !== 'host') {
    console.error(`Unknown --provider: ${provider}. Allowed: claude, codex, gemini, openrouter, host`);
    process.exit(1);
  }
  const runtime = flag('runtime');
  if (runtime !== undefined && runtime !== 'worker' && runtime !== 'server' && runtime !== 'server-beta') {
    console.error(`Unknown --runtime: ${runtime}. Allowed: worker, server`);
    process.exit(1);
  }
  const ide = flag('ide');
  let resolvedProvider = provider as InstallOptions['provider'];
  // Non-TTY grok-bot: CMEM Pro is the user default. The 'cmem' sentinel is
  // prompt-only (install.ts maps it to openrouter + cmem-observer + OAuth).
  // Interactive installs still get the CMEM/Claude prompt. `--provider host`
  // stays an explicit loopback-shim opt-in.
  if (!resolvedProvider && process.stdin.isTTY !== true) {
    const implicit = resolveInstallerProviderChoice({ ide });
    if (implicit) {
      resolvedProvider = implicit as InstallOptions['provider'];
    }
  }
  return {
    ide,
    provider: resolvedProvider,
    // Both the explicit flag and the grok-bot implicit cmem default are
    // explicit product choices; install.ts only defaults when this is unset.
    providerSource: resolvedProvider ? 'flag' : undefined,
    model: flag('model'),
    noAutoStart: values['no-auto-start'] === true,
    disableAutoMemory: values['disable-auto-memory'] === true,
    runtime: runtime as InstallOptions['runtime'],
    serverUrl: flag('server-url'),
    dshProfile: flag('dsh-profile'),
  };
}

async function main(): Promise<void> {
  switch (command) {
    case '':
    case 'install': {
      const { runInstallCommand } = await import('./commands/install.js');
      await runInstallCommand(parseInstallOptions(args));
      break;
    }

    case 'repair': {
      const { runRepairCommand } = await import('./commands/install.js');
      await runRepairCommand();
      break;
    }

    case 'update':
    case 'upgrade': {
      const { runInstallCommand } = await import('./commands/install.js');
      await runInstallCommand();
      break;
    }

    case 'uninstall':
    case 'remove': {
      const { runUninstallCommand } = await import('./commands/uninstall.js');
      await runUninstallCommand();
      break;
    }

    case 'version':
    case '--version':
    case '-v': {
      console.log(readPluginVersion());
      break;
    }

    case 'help':
    case '--help':
    case '-h': {
      printHelp();
      break;
    }

    case 'start': {
      const { runStartCommand } = await import('./commands/runtime.js');
      runStartCommand();
      break;
    }
    case 'stop': {
      const { runStopCommand } = await import('./commands/runtime.js');
      runStopCommand();
      break;
    }
    case 'restart': {
      const { runRestartCommand } = await import('./commands/runtime.js');
      runRestartCommand();
      break;
    }
    case 'status': {
      const { runStatusCommand } = await import('./commands/runtime.js');
      runStatusCommand();
      break;
    }

    case 'doctor': {
      const { runDoctorCommand } = await import('./commands/doctor.js');
      await runDoctorCommand();
      break;
    }

    case 'prune': {
      const { runPruneCommand } = await import('./commands/prune.js');
      await runPruneCommand(args.slice(1));
      break;
    }

    case 'telemetry': {
      const { runTelemetryCommand } = await import('./commands/telemetry.js');
      await runTelemetryCommand(args.slice(1));
      break;
    }

    case 'server': {
      const { runServerCommand } = await import('./commands/server.js');
      await runServerCommand(args.slice(1));
      break;
    }

    case 'antigravity-cli': {
      const { handleAntigravityCliCommand } = await import('../services/integrations/AntigravityCliHooksInstaller.js');
      const exitCode = await handleAntigravityCliCommand(args[1]?.toLowerCase(), args.slice(2));
      if (typeof exitCode === 'number') {
        process.exit(exitCode);
      }
      break;
    }

    case 't3':
    case 't3-code':
    case 't3code': {
      const { t3CodeStatus, uninstallT3Code } = await import('../services/integrations/T3CodeInstaller.js');
      const { values } = parseArgs({ args: args.slice(2), options: { settings: { type: 'string' } } });
      const options = { settingsPath: values.settings };
      if (args[1] === 'status') process.exit(t3CodeStatus(options));
      if (args[1] === 'uninstall') process.exit(uninstallT3Code(options));
      console.error('Usage: npx claude-mem t3code status|uninstall [--settings <path>]');
      console.error('Install with: npx claude-mem install --ide t3code');
      process.exit(1);
      break;
    }

    case 'pi': {
      const { installPiExtension, uninstallPiExtension, piExtensionStatus } = await import('../services/integrations/PiInstaller.js');
      const action = args[1]?.toLowerCase();
      const code = action === 'install' ? installPiExtension()
        : action === 'uninstall' ? uninstallPiExtension()
        : action === 'status' ? piExtensionStatus() : 1;
      if (!['install', 'uninstall', 'status'].includes(action ?? '')) console.error('Usage: npx claude-mem pi install|status|uninstall');
      process.exitCode = code;
      break;
    }
    case 'kimi': {
      const { handleKimiCommand } = await import('../services/integrations/KimiHooksInstaller.js');
      const exitCode = await handleKimiCommand(args[1]?.toLowerCase(), args.slice(2));
      if (typeof exitCode === 'number') {
        process.exit(exitCode);
      }
      break;
    }

    case 'worker': {
      const { runWorkerAliasCommand } = await import('./commands/server.js');
      runWorkerAliasCommand(args.slice(1));
      break;
    }

    case 'search': {
      const { runSearchCommand } = await import('./commands/runtime.js');
      await runSearchCommand(args.slice(1));
      break;
    }

    case 'mcp': {
      const { runMcpCommand } = await import('./commands/runtime.js');
      runMcpCommand();
      break;
    }

    case 'hook': {
      const { runHookCommand } = await import('./commands/runtime.js');
      runHookCommand(args.slice(1));
      break;
    }

    case 'adopt': {
      const { runAdoptCommand } = await import('./commands/runtime.js');
      runAdoptCommand(args.slice(1));
      break;
    }

    case 'project': {
      const { runProjectCommand } = await import('./commands/runtime.js');
      runProjectCommand(args.slice(1));
      break;
    }

    case 'cleanup': {
      const { runCleanupCommand } = await import('./commands/runtime.js');
      runCleanupCommand(args.slice(1));
      break;
    }

    case 'transcript': {
      const subCommand = args[1]?.toLowerCase();
      if (subCommand === 'watch') {
        const { runTranscriptWatchCommand } = await import('./commands/runtime.js');
        runTranscriptWatchCommand();
      } else {
        console.error(styleText('red', `Unknown transcript subcommand: ${subCommand ?? '(none)'}`));
        console.error(`Usage: npx claude-mem transcript watch`);
        process.exit(1);
      }
      break;
    }

    case 'memory': {
      const subCommand = args[1]?.toLowerCase();
      if (subCommand === 'ingest') {
        const { runMemoryIngestCommand } = await import('./commands/runtime.js');
        runMemoryIngestCommand(args.slice(2));
      } else {
        console.error(styleText('red', `Unknown memory subcommand: ${subCommand ?? '(none)'}`));
        console.error(`Usage: npx claude-mem memory ingest [--source <dir> | --all] [--dry-run] [--require-cwd]`);
        process.exit(1);
      }
      break;
    }

    default: {
      console.error(styleText('red', `Unknown command: ${command}`));
      console.error(`Run ${styleText('bold', 'npx claude-mem --help')} for usage information.`);
      process.exit(1);
    }
  }
}

main().catch((error) => {
  console.error(styleText('red', 'Fatal error:'), error.message || error);
  process.exit(1);
});
