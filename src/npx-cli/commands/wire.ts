import { runWireGatewayCommand } from './runtime.js';

// `claude-mem wire …` — the wire gateway's own script (src/services/wire-gateway/
// WireGatewayService.ts) validates every subcommand and flag; this only forwards.

/** The gateway script's argv. `run <agent>` gets `--cwd`: the script runs from the plugin folder, the agent from this one. */
export function wireGatewayServiceArguments(argv: string[], cwd: string): string[] {
  if (argv[0] !== 'run' || !argv[1]) return argv;
  const rest = argv.slice(2);
  const separatorIndex = rest.indexOf('--');
  const ownFlags = separatorIndex === -1 ? [] : rest.slice(0, separatorIndex);
  const agentArguments = separatorIndex === -1 ? rest : rest.slice(separatorIndex + 1);
  return ['run', argv[1], ...ownFlags, '--cwd', cwd, '--', ...agentArguments];
}

export function runWireCommand(argv: string[] = []): void {
  // `wire run` hosts the user's agent, which owns the terminal (see shared/interactive-child-signals.ts).
  runWireGatewayCommand(wireGatewayServiceArguments(argv, process.cwd()), argv[0] === 'run');
}
