import pc from 'picocolors';
import { readPluginVersion } from './utils/paths.js';

const args = process.argv.slice(2);
const command = args[0]?.toLowerCase() ?? '';

function printHelp(): void {
  const version = readPluginVersion();

  console.log(`
${pc.bold('claude-mem')} v${version} — persistent memory for AI coding assistants

${pc.bold('Install Commands')} (no Bun required):
  ${pc.cyan('npx claude-mem')}                     Interactive install
  ${pc.cyan('npx claude-mem install')}              Interactive install
  ${pc.cyan('npx claude-mem install --ide <id>')}   Install for specific IDE
  ${pc.cyan('npx claude-mem update')}               Update to latest version
  ${pc.cyan('npx claude-mem uninstall')}            Remove plugin and configs
  ${pc.cyan('npx claude-mem version')}              Print version

${pc.bold('Runtime Commands')} (requires Bun, delegates to installed plugin):
  ${pc.cyan('npx claude-mem start')}                Start worker service
  ${pc.cyan('npx claude-mem stop')}                 Stop worker service
  ${pc.cyan('npx claude-mem restart')}              Restart worker service
  ${pc.cyan('npx claude-mem status')}               Show worker status
  ${pc.cyan('npx claude-mem search <query>')}       Search observations
  ${pc.cyan('npx claude-mem adopt [--dry-run] [--branch <name>]')}    Stamp merged worktrees into parent project
  ${pc.cyan('npx claude-mem cleanup [--dry-run]')}    Run one-time v12.4.3 pollution cleanup (or preview counts)
  ${pc.cyan('npx claude-mem transcript watch')}     Start transcript watcher

${pc.bold('IDE Identifiers')}:
  claude-code, cursor, gemini-cli, opencode, openclaw,
  windsurf, codex-cli, copilot-cli, antigravity, goose,
  crush, roo-code, warp
`);
}

async function main(): Promise<void> {
  switch (command) {
    case '': {
      const { runInstallCommand } = await import('./commands/install.js');
      await runInstallCommand();
      break;
    }

    case 'install': {
      const ideIndex = args.indexOf('--ide');
      const ideValue = ideIndex !== -1 ? args[ideIndex + 1] : undefined;

      const { runInstallCommand } = await import('./commands/install.js');
      await runInstallCommand({ ide: ideValue });
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

    case 'search': {
      const { runSearchCommand } = await import('./commands/runtime.js');
      await runSearchCommand(args.slice(1));
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

    case 'transcript': {
      const subCommand = args[1]?.toLowerCase();
      if (subCommand === 'watch') {
        const { runTranscriptWatchCommand } = await import('./commands/runtime.js');
        runTranscriptWatchCommand();
      } else {
        console.error(pc.red(`Unknown transcript subcommand: ${subCommand ?? '(none)'}`));
        console.error(`Usage: npx claude-mem transcript watch`);
        process.exit(1);
      }
      break;
    }

    default: {
      console.error(pc.red(`Unknown command: ${command}`));
      console.error(`Run ${pc.bold('npx claude-mem --help')} for usage information.`);
      process.exit(1);
    }
  }
}

main().catch((error) => {
  console.error(pc.red('Fatal error:'), error.message || error);
  process.exit(1);
});
