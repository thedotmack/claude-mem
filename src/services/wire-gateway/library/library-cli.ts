// SPDX-License-Identifier: Apache-2.0
//
// `claude-mem library status [<agent>] [--json] | sync <agent> | remove <agent>`
// (plan Phase 14 task 6). `sync` writes what claude-mem installs into the
// agent, through the same installer `claude-mem install --ide <agent>` runs
// (both go through the Library engine); `remove` takes out only what the
// record (or a pre-Library install's signature) says claude-mem wrote;
// `status` shows each recorded item against its file and never writes.
// Runs under Bun (worker-service.cjs), like `claude-mem wire`.

import { MARKETPLACE_ROOT } from '../../../shared/paths.js';
import { LIBRARY_AGENT_TARGETS, findLibraryAgentTarget } from './agent-library-targets.js';
import { libraryStatus } from './library-engine.js';
import { defaultLibraryContext } from './library-runtime.js';
import { LIBRARY_INSTALL_MCP_STEP_FAILED_EXIT_CODE, type LibraryContext } from './types.js';

export interface LibraryCliRuntime {
  writeLine(line: string): void;
  writeError(line: string): void;
  context?: LibraryContext;
}

interface LibraryAgentActions {
  install(options: { dshProfile?: string }): Promise<number>;
  uninstall(): Promise<number>;
}

/** Each agent's installer, loaded only when used. Cursor is its user-level install, as `install --ide cursor` does. */
const AGENT_ACTIONS: Record<string, LibraryAgentActions> = {
  windsurf: {
    install: async () => (await import('../../integrations/WindsurfHooksInstaller.js')).installWindsurfHooks(),
    uninstall: async () => (await import('../../integrations/WindsurfHooksInstaller.js')).uninstallWindsurfHooks(),
  },
  kimi: {
    install: async () => {
      const kimi = await import('../../integrations/KimiHooksInstaller.js');
      const hooks = kimi.installKimiHooks();
      if (hooks !== 0) return hooks;
      return kimi.configureKimiMcp() === 0 ? 0 : LIBRARY_INSTALL_MCP_STEP_FAILED_EXIT_CODE;
    },
    uninstall: async () => (await import('../../integrations/KimiHooksInstaller.js')).uninstallKimiHooks(),
  },
  antigravity: {
    install: async () => (await import('../../integrations/AntigravityCliHooksInstaller.js')).installAntigravityCliHooks(),
    uninstall: async () => (await import('../../integrations/AntigravityCliHooksInstaller.js')).uninstallAntigravityCliHooks(),
  },
  cursor: {
    install: async () => {
      const cursor = await import('../../integrations/CursorHooksInstaller.js');
      const hooks = await cursor.installCursorHooks('user');
      if (hooks !== 0) return hooks;
      return cursor.configureCursorMcp('user') === 0 ? 0 : LIBRARY_INSTALL_MCP_STEP_FAILED_EXIT_CODE;
    },
    uninstall: async () => (await import('../../integrations/CursorHooksInstaller.js')).uninstallCursorHooks('user'),
  },
  opencode: {
    install: async () => (await import('../../integrations/OpenCodeInstaller.js')).installOpenCodeIntegration(),
    uninstall: async () => (await import('../../integrations/OpenCodeInstaller.js')).uninstallOpenCodePlugin(),
  },
  openclaw: {
    install: async () => (await import('../../integrations/OpenClawInstaller.js')).installOpenClawIntegration(),
    uninstall: async () => (await import('../../integrations/OpenClawInstaller.js')).uninstallOpenClawPlugin(),
  },
  pi: {
    install: async () => (await import('../../integrations/PiInstaller.js')).installPiExtension(),
    uninstall: async () => (await import('../../integrations/PiInstaller.js')).uninstallPiExtension(),
  },
  omp: {
    install: async () => (await import('../../integrations/OmpHooksInstaller.js')).installOmpHooks(),
    uninstall: async () => (await import('../../integrations/OmpHooksInstaller.js')).uninstallOmpHooks(),
  },
  t3code: {
    install: async () => (await import('../../integrations/T3CodeInstaller.js')).installT3Code(MARKETPLACE_ROOT),
    uninstall: async () => (await import('../../integrations/T3CodeInstaller.js')).uninstallT3Code(),
  },
  'grok-bot': {
    install: async () => (await import('../../integrations/GrokBotInstaller.js')).installGrokBotIntegration(),
    uninstall: async () => removeRecordedItemsOnly('grok-bot'),
  },
  dsh: {
    install: async ({ dshProfile }) => (await import('../../integrations/DeepSeekHarnessInstaller.js')).installDeepSeekHarness(dshProfile),
    uninstall: async () => (await import('../../integrations/DeepSeekHarnessInstaller.js')).uninstallDeepSeekHarness(),
  },
  'codex-cli': {
    install: async () => (await import('../../integrations/CodexCliInstaller.js')).installCodexCli(MARKETPLACE_ROOT),
    uninstall: async () => (await import('../../integrations/CodexCliInstaller.js')).uninstallCodexCli(),
  },
  'copilot-cli': mcpOnlyActions('copilot-cli'),
  'roo-code': mcpOnlyActions('roo-code'),
  warp: mcpOnlyActions('warp'),
  goose: {
    install: async () => (await import('../../integrations/McpIntegrations.js')).installGooseMcpIntegration(),
    uninstall: async () => {
      (await import('../../integrations/McpIntegrations.js')).uninstallGooseMcpIntegration();
      return 0;
    },
  },
};

function mcpOnlyActions(agentId: string): LibraryAgentActions {
  return {
    install: async () => (await import('../../integrations/McpIntegrations.js')).MCP_IDE_INSTALLERS[agentId](),
    uninstall: async () => removeRecordedItemsOnly(agentId),
  };
}

/**
 * Remove for an agent without an uninstaller of its own: only what
 * library.json records. Prints what happened (as the installers do, on the
 * console) and returns 1 when the remove failed.
 */
export async function removeRecordedItemsOnly(agentId: string, context: LibraryContext = defaultLibraryContext()): Promise<number> {
  const name = findLibraryAgentTarget(agentId)?.name ?? agentId;
  const { removeLibraryForInstaller } = await import('./library-runtime.js');
  let result;
  try {
    result = removeLibraryForInstaller({ agentId, items: [] }, context);
  } catch (error) {
    console.error(`${name}: removing claude-mem failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  if (result.items.length === 0) {
    console.log(`${name}: nothing recorded; claude-mem has nothing to remove here`);
    return 0;
  }
  for (const item of result.items) console.log(`  ${item.outcome.padEnd(10)} ${item.id}${item.detail ? ` (${item.detail})` : ''}`);
  console.log(`${name}: claude-mem removed${result.filesWritten.length > 0 ? `; files changed: ${result.filesWritten.join(', ')}` : ''}`);
  return 0;
}

export function libraryUsage(): string {
  return [
    'Usage: claude-mem library <command>',
    '  status [<agent>] [--json]   What claude-mem wrote into each agent (or one), checked against the files',
    '  sync <agent>                 Write claude-mem\'s hooks, MCP server, instructions and bundles into the agent',
    '  remove <agent>               Take out only what claude-mem wrote; every other entry stays',
    `Agents: ${LIBRARY_AGENT_TARGETS.map((target) => target.id).join(', ')}`,
  ].join('\n');
}

function requireAgent(agentId: string | undefined, runtime: LibraryCliRuntime): string | null {
  if (!agentId) {
    runtime.writeError(libraryUsage());
    return null;
  }
  if (!findLibraryAgentTarget(agentId) || !AGENT_ACTIONS[agentId]) {
    runtime.writeError(`Unknown agent: ${agentId}`);
    runtime.writeError(libraryUsage());
    return null;
  }
  return agentId;
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index !== -1) return args[index + 1];
  const inline = args.find((arg) => arg.startsWith(`${flag}=`));
  return inline?.slice(flag.length + 1);
}

function printStatus(agentIds: string[], json: boolean, runtime: LibraryCliRuntime): number {
  const context = runtime.context ?? defaultLibraryContext();
  const report = agentIds.map((agentId) => ({ agent: agentId, ...libraryStatus(agentId, context) }));
  if (json) {
    runtime.writeLine(JSON.stringify(report, null, 2));
    return 0;
  }
  for (const entry of report) {
    const target = findLibraryAgentTarget(entry.agent);
    if (entry.items.length === 0) {
      if (agentIds.length === 1) runtime.writeLine(`${target?.name ?? entry.agent}: nothing recorded`);
      continue;
    }
    runtime.writeLine(`${target?.name ?? entry.agent} (${entry.agent}), recorded ${entry.recordedAt}`);
    for (const item of entry.items) runtime.writeLine(`  ${item.state.padEnd(16)} ${item.kind.padEnd(12)} ${item.id.split(':').slice(-1)[0].padEnd(22)} ${item.path}`);
  }
  if (report.every((entry) => entry.items.length === 0) && agentIds.length > 1) runtime.writeLine('Nothing recorded: claude-mem has not installed into any agent through the Library yet.');
  return 0;
}

export async function runLibraryCli(args: string[], runtime: LibraryCliRuntime): Promise<number> {
  const [subCommand, ...rest] = args;
  const positional = rest.filter((arg, index) => !arg.startsWith('--') && !(index > 0 && rest[index - 1] === '--dsh-profile'));
  switch (subCommand) {
    case 'status': {
      const json = rest.includes('--json');
      if (positional[0]) {
        const agentId = requireAgent(positional[0], runtime);
        return agentId ? printStatus([agentId], json, runtime) : 1;
      }
      return printStatus(LIBRARY_AGENT_TARGETS.map((target) => target.id), json, runtime);
    }
    case 'sync':
    case 'install': {
      const agentId = requireAgent(positional[0], runtime);
      if (!agentId) return 1;
      return AGENT_ACTIONS[agentId].install({ dshProfile: flagValue(rest, '--dsh-profile') });
    }
    case 'remove':
    case 'uninstall': {
      const agentId = requireAgent(positional[0], runtime);
      if (!agentId) return 1;
      return AGENT_ACTIONS[agentId].uninstall();
    }
    default:
      runtime.writeError(libraryUsage());
      return subCommand === undefined || subCommand === 'help' ? 0 : 1;
  }
}
