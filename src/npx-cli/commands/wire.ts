import { styleText } from 'node:util';
import { runWireGatewayCommand } from './runtime.js';

const WIRE_LIFECYCLE_COMMANDS = new Set(['start', 'stop', 'restart', 'status']);
const WIRE_SERVICE_ACTIONS = new Set(['install', 'uninstall']);
const WIRE_ROUTES_ACTIONS = new Set(['add', 'list', 'remove', 'endless', 'memory', 'search']);
const WIRE_AGENT_COMMANDS = new Set(['connect', 'disconnect', 'preview', 'run']);

function printWireUsage(): void {
  console.error(`Usage: ${styleText('bold', 'npx claude-mem wire <command>')}`);
  console.error('Commands: start [--foreground], stop, restart, status [--endless], service install|uninstall, routes add|list|remove|endless|memory|search, consent [--record|--off], clear, magpie enable|disable,');
  console.error('          connect <agent> [--capture wire|native], disconnect <agent>, preview <agent> [--disconnect], run <agent> -- <args>');
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
    console.error('Usage: npx claude-mem wire routes add <routeId> --agent <id> --upstream <url> [--capture wire|native] | list | remove <routeId> | endless|memory|search <routeId> on|off|default');
    process.exit(1);
  }

  if (subCommand === 'consent') {
    const flags = argv.slice(1);
    if (flags.every(flag => flag === '--record' || flag === '--off') && flags.length <= 1) {
      // The gateway script asks for a terminal itself; stdio is inherited all the way down.
      runWireGatewayCommand(['consent', ...flags]);
      return;
    }
    console.error(styleText('red', `Unknown wire consent option: ${flags.join(' ')}`));
    console.error('Usage: npx claude-mem wire consent [--record|--off]');
    process.exit(1);
  }

  if (subCommand && WIRE_AGENT_COMMANDS.has(subCommand)) {
    if (!argv[1]) {
      console.error(styleText('red', `wire ${subCommand} needs an agent`));
      console.error(`Usage: npx claude-mem wire ${subCommand} <agent>${subCommand === 'run' ? ' -- <args>' : ''}`);
      process.exit(1);
    }
    if (subCommand === 'run') {
      // The plugin runs from its own folder, so the agent's folder (this one) goes along as --cwd.
      const rest = argv.slice(2);
      const separatorIndex = rest.indexOf('--');
      const ownFlags = separatorIndex === -1 ? [] : rest.slice(0, separatorIndex);
      const agentArguments = separatorIndex === -1 ? rest : rest.slice(separatorIndex + 1);
      runWireGatewayCommand(['run', argv[1], ...ownFlags, '--cwd', process.cwd(), '--', ...agentArguments], true);
      return;
    }
    // The agent name and flags pass through untouched.
    runWireGatewayCommand([subCommand, ...argv.slice(1)]);
    return;
  }

  if (subCommand === 'clear') {
    runWireGatewayCommand(['clear']);
    return;
  }

  if (subCommand === 'magpie') {
    const action = argv[1]?.toLowerCase();
    if (action === 'enable' || action === 'disable') {
      // Flags (--backfill, --dir <path>) pass through; the gateway script validates them.
      runWireGatewayCommand(['magpie', action, ...argv.slice(2)]);
      return;
    }
    console.error(styleText('red', `Unknown wire magpie action: ${action ?? '(none)'}`));
    console.error('Usage: npx claude-mem wire magpie enable [--backfill] [--dir <path>] | disable');
    process.exit(1);
  }

  console.error(styleText('red', `Unknown wire command: ${subCommand ?? '(none)'}`));
  printWireUsage();
  process.exit(1);
}
