import { parseArgs, styleText } from 'node:util';
import { readPluginVersion } from './utils/paths.js';
import type { InstallOptions } from './commands/install.js';

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

${pc.bold('Install Commands')} (no Bun required):
  ${pc.cyan('npx claude-mem')}                     Interactive install
  ${pc.cyan('npx claude-mem install')}              Interactive install
  ${pc.cyan('npx claude-mem install --ide <id>')}   Install for specific IDE
  ${pc.cyan('npx claude-mem install --provider claude|gemini|agy-cli|openrouter')}   Set LLM provider non-interactively
  ${pc.cyan('npx claude-mem install --model <id>')}   Set Claude model (when provider=claude)
  ${pc.cyan('npx claude-mem install --no-auto-start')}   Skip worker auto-start at the end
  ${pc.cyan('npx claude-mem install --keep-auto-memory')}   Keep Claude Code native auto-memory on (disabled by default; it conflicts with claude-mem)
  ${pc.cyan('npx claude-mem install --runtime worker|server')}   Select runtime non-interactively (server brings up Docker pg+redis, generates an API key, injects the IDE MCP config)
  ${pc.cyan('npx claude-mem install --runtime server --server-url <url>')}   Point the server runtime at a specific base URL
  ${pc.cyan('npx claude-mem repair')}                Repair runtime (re-runs Bun/uv setup and bun install in plugin cache)
  ${pc.cyan('npx claude-mem update')}               Update to latest version
  ${pc.cyan('npx claude-mem uninstall')}            Remove plugin and configs
  ${pc.cyan('npx claude-mem version')}              Print version

${pc.bold('Runtime Commands')} (requires Bun, delegates to installed plugin):
  ${pc.cyan('npx claude-mem start')}                Start worker service
  ${pc.cyan('npx claude-mem stop')}                 Stop worker service
  ${pc.cyan('npx claude-mem restart')}              Restart worker service
  ${pc.cyan('npx claude-mem status')}               Show worker status
  ${pc.cyan('npx claude-mem doctor')}               Diagnose install/runtime health (bun, uv, worker)
  ${pc.cyan('npx claude-mem server start')}         Start server service
  ${pc.cyan('npx claude-mem server stop')}          Stop server service
  ${pc.cyan('npx claude-mem server restart')}       Restart server service
  ${pc.cyan('npx claude-mem server status')}        Show server status
  ${pc.cyan('npx claude-mem server logs')}          Show recent server logs
  ${pc.cyan('npx claude-mem server doctor')}        Check server configuration (not yet implemented)
  ${pc.cyan('npx claude-mem server migrate')}       Run server migrations (not yet implemented)
  ${pc.cyan('npx claude-mem server export')}        Export server data (not yet implemented)
  ${pc.cyan('npx claude-mem server import')}        Import server data (not yet implemented)
  ${pc.cyan('npx claude-mem server api-key create|list|revoke')}   Manage API keys (not yet implemented)
  ${pc.cyan('npx claude-mem worker start|stop|restart|status')}    Worker compatibility aliases
  ${pc.cyan('npx claude-mem search <query>')}       Search observations
  ${pc.cyan('npx claude-mem migrate-memory [--dry-run] [--project <name>] [--keep-source]')}    Import Claude Code native auto-memory into claude-mem, then archive the originals (--keep-source to skip)
  ${pc.cyan('npx claude-mem adopt [--dry-run] [--branch <name>]')}    Stamp merged worktrees into parent project
  ${pc.cyan('npx claude-mem cleanup [--dry-run]')}    Run one-time v12.4.3 pollution cleanup (or preview counts)
  ${pc.cyan('npx claude-mem merge-environment --name=<env> --from=<proj1,proj2,...>')}    Migrate project data to an environment name
  ${pc.cyan('npx claude-mem transcript watch')}     Start transcript watcher

${pc.bold('IDE Identifiers')}:
  claude-code, cursor, gemini-cli, kimi-code, opencode, openclaw,
  windsurf, codex-cli, copilot-cli, antigravity, goose,
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
      'no-auto-start': { type: 'boolean' },
      'disable-auto-memory': { type: 'boolean' },
    },
    strict: false,
    allowPositionals: true,
  });
  const flag = (name: string): string | undefined =>
    typeof values[name] === 'string' ? (values[name] as string) : undefined;
  const provider = flag('provider');
  if (provider !== undefined && provider !== 'claude' && provider !== 'codex' && provider !== 'gemini' && provider !== 'openrouter' && provider !== 'kiro') {
    console.error(`Unknown --provider: ${provider}. Allowed: claude, codex, gemini, openrouter, kiro`);
    process.exit(1);
  }
  return next;
}

function parseInstallOptions(argv: string[]): InstallOptions {
  const provider = readFlag(argv, '--provider');
  if (provider !== undefined && provider !== 'claude' && provider !== 'gemini' && provider !== 'agy-cli' && provider !== 'openrouter') {
    console.error(`Unknown --provider: ${provider}. Allowed: claude, gemini, agy-cli, openrouter`);
    process.exit(1);
  }
  const runtime = readFlag(argv, '--runtime');
  if (runtime !== undefined && runtime !== 'worker' && runtime !== 'server' && runtime !== 'server-beta') {
    console.error(`Unknown --runtime: ${runtime}. Allowed: worker, server`);
    process.exit(1);
  }
  return {
    ide: flag('ide'),
    provider: provider as InstallOptions['provider'],
    model: readFlag(argv, '--model'),
    noAutoStart: argv.includes('--no-auto-start'),
    disableAutoMemory: argv.includes('--disable-auto-memory'),
    keepAutoMemory: argv.includes('--keep-auto-memory'),
    runtime: runtime as InstallOptions['runtime'],
    serverUrl: flag('server-url'),
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

    case 'migrate-to-helix': {
      const { runMigrateToHelixCommand } = await import('./commands/migrate-to-helix.js');
      await runMigrateToHelixCommand();
      break;
    }

    case 'adopt': {
      const { runAdoptCommand } = await import('./commands/runtime.js');
      runAdoptCommand(args.slice(1));
      break;
    }

    case 'cleanup': {
      const { runCleanupCommand } = await import('./commands/runtime.js');
      runCleanupCommand(args.slice(1));
      break;
    }

    case 'migrate-memory':
    case 'migrate-native-memory':
    case 'transfer-memory': {
      const { runMigrateNativeMemoryCommand } = await import('./commands/migrate-native-memory.js');
      await runMigrateNativeMemoryCommand(args.slice(1));
      break;
    }

    case 'transcript': {
      const subCommand = args[1]?.toLowerCase();
      if (subCommand === 'watch') {
        const { runTranscriptWatchCommand } = await import('./commands/runtime.js');
        runTranscriptWatchCommand();
      } else if (subCommand === 'ingest') {
        const { runTranscriptIngestCommand } = await import('./commands/runtime.js');
        runTranscriptIngestCommand(args.slice(2));
      } else {
        console.error(pc.red(`Unknown transcript subcommand: ${subCommand ?? '(none)'}`));
        console.error(`Usage: npx claude-mem transcript <watch|ingest>`);
        console.error(`  ingest --source <dir|file> [--dry-run] [--include-subagents]`);
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
        console.error(pc.red(`Unknown memory subcommand: ${subCommand ?? '(none)'}`));
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
