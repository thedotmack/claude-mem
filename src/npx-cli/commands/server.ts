import pc from 'picocolors';
import {
  runServerBetaRestartCommand,
  runServerBetaStartCommand,
  runServerBetaStatusCommand,
  runServerBetaStopCommand,
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
  console.error('Commands: start, stop, restart, status, logs, doctor, migrate, export, import, api-key create|list|revoke');
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

  console.error(pc.red(`Unknown server command: ${subCommand}`));
  printServerUsage();
  process.exit(1);
}

export function runWorkerAliasCommand(argv: string[] = []): void {
  const subCommand = argv[0]?.toLowerCase();

  if (!subCommand || !runWorkerLifecycleCommand(subCommand)) {
    console.error(pc.red(`Unknown worker command: ${subCommand ?? '(none)'}`));
    console.error('Usage: npx claude-mem worker start|stop|restart|status');
    process.exit(1);
  }
}
