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

${styleText('bold', 'Install Commands')} (from this reviewed fork checkout):
  ${styleText('cyan', 'bun dist/npx-cli/index.js')}                     Interactive install
  ${styleText('cyan', 'bun dist/npx-cli/index.js install')}              Interactive install (also puts the claude-mem hook launcher on PATH)
  ${styleText('cyan', 'bun dist/npx-cli/index.js install --ide <id>')}   Install for specific IDE
  ${styleText('cyan', 'bun dist/npx-cli/index.js install --ide dsh --dsh-profile <name>')}   Install DeepSeek Harness (default profile: web)
  ${styleText('cyan', 'bun dist/npx-cli/index.js install --provider claude|codex|gemini|openrouter|host')}   Set LLM provider (optional non-interactively; a fresh install defaults to claude)
  ${styleText('cyan', 'bun dist/npx-cli/index.js install --model <id>')}   Set Claude or Codex model (when provider=claude|codex)
  ${styleText('cyan', 'bun dist/npx-cli/index.js install --no-auto-start')}   Skip worker auto-start at the end
  ${styleText('cyan', 'bun dist/npx-cli/index.js install --disable-auto-memory')}   Explicitly disable Claude Code native auto-memory
  ${styleText('cyan', 'bun dist/npx-cli/index.js install --runtime worker|server')}   Select runtime non-interactively (server prints the docker compose command for pg+redis without running it, and provisions a hook API key only when CLAUDE_MEM_SERVER_DATABASE_URL is set; otherwise set CLAUDE_MEM_SERVER_DATABASE_URL before running bun dist/npx-cli/index.js server keys rotate once Postgres is up)
  ${styleText('cyan', 'bun dist/npx-cli/index.js install --runtime server --server-url <url>')}   Point the server runtime at a specific base URL
  ${styleText('cyan', 'bun dist/npx-cli/index.js repair')}                Repair runtime (re-runs Bun/uv setup and bun install in plugin cache)
  ${styleText('cyan', 'bun dist/npx-cli/index.js prune [--dry-run] [--keep <n>]')}   Remove superseded plugin cache versions (keeps newest 2 + live worker + registered install)
  ${styleText('cyan', 'bun dist/npx-cli/index.js update')}               Reinstall this fork build (no download of newer versions)
  ${styleText('cyan', 'bun dist/npx-cli/index.js uninstall')}            Remove plugin, configs and the hook launcher
  ${styleText('cyan', 'bun dist/npx-cli/index.js version')}              Print version

${styleText('bold', 'Runtime Commands')} (requires Bun, delegates to installed plugin):
  ${styleText('cyan', 'bun dist/npx-cli/index.js start')}                Start worker service
  ${styleText('cyan', 'bun dist/npx-cli/index.js stop')}                 Stop worker service
  ${styleText('cyan', 'bun dist/npx-cli/index.js restart')}              Restart worker service
  ${styleText('cyan', 'bun dist/npx-cli/index.js status')}               Show worker status
  ${styleText('cyan', 'bun dist/npx-cli/index.js doctor')}               Diagnose install/runtime health (bun, uv, hook launcher, worker)
  ${styleText('cyan', 'bun dist/npx-cli/index.js telemetry status|enable|disable')}   Manage anonymous telemetry (on by default, opt-out)
  ${styleText('cyan', 'bun dist/npx-cli/index.js server start')}         Start server service
  ${styleText('cyan', 'bun dist/npx-cli/index.js server stop')}          Stop server service
  ${styleText('cyan', 'bun dist/npx-cli/index.js server restart')}       Restart server service
  ${styleText('cyan', 'bun dist/npx-cli/index.js server status')}        Show server status
  ${styleText('cyan', 'bun dist/npx-cli/index.js server api-key create|list|revoke')}   Manage API keys
  ${styleText('cyan', 'bun dist/npx-cli/index.js worker start|stop|restart|status')}    Worker compatibility aliases
  ${styleText('cyan', 'bun dist/npx-cli/index.js search <query>')}       Search observations
  ${styleText('cyan', 'bun dist/npx-cli/index.js mcp')}                    Start the stdio MCP server
  ${styleText('cyan', 'bun dist/npx-cli/index.js hook cursor <event>')}    Run Cursor hook forwarding
  ${styleText('cyan', 'bun dist/npx-cli/index.js adopt [--dry-run] [--branch <name>]')}    Stamp merged worktrees into parent project
  ${styleText('cyan', 'bun dist/npx-cli/index.js cleanup [--dry-run]')}    Run one-time v12.4.3 pollution cleanup (or preview counts)
  ${styleText('cyan', 'bun dist/npx-cli/index.js project merge <from> <into> [--dry-run]')}    Fold one project's memory into another (non-destructive, syncs)
  ${styleText('cyan', 'bun dist/npx-cli/index.js transcript watch')}     Start transcript watcher
  ${styleText('cyan', 'bun dist/npx-cli/index.js antigravity-cli install|status|uninstall')}   Manage Antigravity CLI hooks + MCP config
  ${styleText('cyan', 'bun dist/npx-cli/index.js kimi install|status|uninstall')}   Manage Kimi Code CLI hooks + MCP config
  ${styleText('cyan', 'bun dist/npx-cli/index.js t3code status|uninstall [--settings <path>]')}   Inspect or disable T3 Code provider plugins
  ${styleText('cyan', 'bun dist/npx-cli/index.js pi install|status|uninstall')}   Manage the native Pi extension

${styleText('bold', 'TeamBrain')} (one shared brain for your team; your own memory stays private):
  ${styleText('cyan', 'bun dist/npx-cli/index.js teambrain start')}                Create a team on cmem.ai
  ${styleText('cyan', 'bun dist/npx-cli/index.js teambrain join <invite-link>')}   Join a team, then choose which projects to share
  ${styleText('cyan', 'bun dist/npx-cli/index.js teambrain status|share|leave')}   Check your teams, change what you share, or leave

${styleText('bold', 'Claude Code Hooks')}:
  Each hook runs ${styleText('cyan', 'claude-mem hook claude-code <event>')} directly, with no shell.
  That ${styleText('cyan', 'claude-mem')} is a small launcher the installer places on PATH:
  ~/.local/bin (macOS/Linux) or %LOCALAPPDATA%\\claude-mem\\bin (Windows).
  Hook error 'Executable not found in $PATH: "claude-mem"'? Run ${styleText('cyan', 'bun dist/npx-cli/index.js install')},
  restart your terminal or IDE, then check ${styleText('cyan', 'bun dist/npx-cli/index.js doctor')}.

${styleText('bold', 'IDE Identifiers')}:
  claude-code, cursor, grok-bot, opencode, openclaw, omp, hermes, pi, dsh,
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

// Commands that change the install or the worker and would otherwise ignore -h/--help
const HELP_AWARE_COMMANDS = new Set([
  '', 'install', 'update', 'upgrade', 'uninstall', 'remove', 'repair', 'prune', 'start', 'stop', 'restart',
]);

async function main(): Promise<void> {
  // `uninstall --help` must show help, not run the uninstall.
  if (HELP_AWARE_COMMANDS.has(command) && args.slice(1).some((arg) => arg === '--help' || arg === '-h')) {
    printHelp();
    return;
  }

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

    case 'teambrain': {
      const { runTeamBrainCommand } = await import('./commands/teambrain.js');
      process.exitCode = await runTeamBrainCommand(args.slice(1));
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
