import { styleText } from 'node:util';
import { runWireGatewayCommand } from './runtime.js';

const WIRE_LIFECYCLE_COMMANDS = new Set(['start', 'stop', 'restart', 'status']);
const WIRE_SERVICE_ACTIONS = new Set(['install', 'uninstall']);
const WIRE_ROUTES_ACTIONS = new Set(['add', 'list', 'remove']);

function printWireUsage(): void {
  console.error(`Usage: ${styleText('bold', 'npx claude-mem wire <command>')}`);
  console.error('Commands: start [--foreground], stop, restart, status, service install|uninstall, routes add|list|remove');
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

  if (subCommand === 'routes') {
    const action = argv[1]?.toLowerCase();
    if (action && WIRE_ROUTES_ACTIONS.has(action)) {
      // Route ids and flags pass through untouched; the gateway script validates them.
      runWireGatewayCommand(['routes', action, ...argv.slice(2)]);
      return;
    }
    console.error(styleText('red', `Unknown wire routes action: ${action ?? '(none)'}`));
    console.error('Usage: npx claude-mem wire routes add <routeId> --agent <id> --upstream <url> [--capture wire|native] | list | remove <routeId>');
    process.exit(1);
  }

  console.error(styleText('red', `Unknown wire command: ${subCommand ?? '(none)'}`));
  printWireUsage();
  process.exit(1);
}
