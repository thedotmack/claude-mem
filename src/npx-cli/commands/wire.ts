import { styleText } from 'node:util';
import { runWireGatewayCommand } from './runtime.js';

const WIRE_LIFECYCLE_COMMANDS = new Set(['start', 'stop', 'restart', 'status']);
const WIRE_SERVICE_ACTIONS = new Set(['install', 'uninstall']);

function printWireUsage(): void {
  console.error(`Usage: ${styleText('bold', 'npx claude-mem wire <command>')}`);
  console.error('Commands: start [--foreground], stop, restart, status, service install|uninstall');
}

// `claude-mem wire …` — the wire gateway daemon (src/services/wire-gateway/).
// Copies runServerCommand's shape: validate here, then delegate to the plugin.
export function runWireCommand(argv: string[] = []): void {
  const subCommand = argv[0]?.toLowerCase();

  if (subCommand && WIRE_LIFECYCLE_COMMANDS.has(subCommand)) {
    runWireGatewayCommand([subCommand, ...argv.slice(1)]);
    return;
  }

  if (subCommand === 'service') {
    const action = argv[1]?.toLowerCase();
    if (action && WIRE_SERVICE_ACTIONS.has(action)) {
      runWireGatewayCommand(['service', action]);
      return;
    }
    console.error(styleText('red', `Unknown wire service action: ${action ?? '(none)'}`));
    console.error('Usage: npx claude-mem wire service install|uninstall');
    process.exit(1);
  }

  console.error(styleText('red', `Unknown wire command: ${subCommand ?? '(none)'}`));
  printWireUsage();
  process.exit(1);
}
