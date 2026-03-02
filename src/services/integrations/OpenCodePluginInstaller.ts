import path from 'path';
import { homedir } from 'os';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { MARKETPLACE_ROOT } from '../../shared/paths.js';

type OpenCodeInstallTarget = 'project' | 'global';

function getTargetPluginPath(target: OpenCodeInstallTarget): string {
  if (target === 'global') {
    return path.join(homedir(), '.config', 'opencode', 'plugins', 'claude-mem.ts');
  }
  return path.join(process.cwd(), '.opencode', 'plugins', 'claude-mem.ts');
}

function getTargetConfigPath(target: OpenCodeInstallTarget): string {
  if (target === 'global') {
    return path.join(homedir(), '.config', 'opencode', 'opencode.json');
  }
  return path.join(process.cwd(), 'opencode.json');
}

function findWorkerServicePath(): string | null {
  const candidates = [
    path.join(MARKETPLACE_ROOT, 'plugin', 'scripts', 'worker-service.cjs'),
    path.join(process.cwd(), 'plugin', 'scripts', 'worker-service.cjs'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function findMcpServerPath(): string | null {
  const candidates = [
    path.join(MARKETPLACE_ROOT, 'plugin', 'scripts', 'mcp-server.cjs'),
    path.join(process.cwd(), 'plugin', 'scripts', 'mcp-server.cjs'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function readJsonObject(filePath: string): Record<string, any> {
  if (!existsSync(filePath)) return {};
  const content = readFileSync(filePath, 'utf-8').trim();
  if (!content) return {};
  return JSON.parse(content) as Record<string, any>;
}

function writeJsonObject(filePath: string, value: Record<string, any>): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf-8');
}

function createPluginSource(workerServicePath: string): string {
  const escapedWorkerPath = workerServicePath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `import { spawnSync } from 'node:child_process';
import type { Plugin } from '@opencode-ai/plugin';

const WORKER_SERVICE_PATH = '${escapedWorkerPath}';

function pick(obj: any, keys: string[]): any {
  for (const key of keys) {
    if (obj && obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return undefined;
}

function getSessionId(event: any): string | undefined {
  const eventData = event?.properties ?? {};
  const infoId = eventData?.info?.id;
  const raw = infoId ?? pick(eventData, ['sessionID', 'sessionId', 'session_id', 'id']);
  if (raw === undefined || raw === null) return undefined;
  return String(raw);
}

function getBunCommand(): string {
  const execPath = String(process.execPath || '');
  if (execPath.toLowerCase().includes('bun')) return execPath;
  return 'bun';
}

async function logMessage(client: any, level: 'debug' | 'info' | 'warn' | 'error', message: string, extra: Record<string, unknown>): Promise<void> {
  try {
    await client?.app?.log?.({
      body: {
        service: 'claude-mem-opencode',
        level,
        message,
        extra,
      }
    });
  } catch {
  }
}

async function runHook(client: any, eventName: string, payload: Record<string, unknown>): Promise<boolean> {
  const bunCommand = getBunCommand();
  const result = spawnSync(bunCommand, [WORKER_SERVICE_PATH, 'hook', 'opencode', eventName], {
    input: JSON.stringify(payload),
    encoding: 'utf-8'
  });

  const stderr = (result.stderr || '').toString().trim();
  const stdout = (result.stdout || '').toString().trim();

  if (result.error) {
    await logMessage(client, 'error', 'Failed to execute claude-mem hook', {
      eventName,
      payload,
      error: String(result.error?.message || result.error),
      bunCommand,
    });
    return false;
  }

  if ((result.status ?? 1) !== 0) {
    await logMessage(client, 'warn', 'claude-mem hook exited non-zero', {
      eventName,
      payload,
      status: result.status,
      stderr,
      stdout,
      bunCommand,
    });
    return false;
  }

  return true;
}

function resolveCwd(baseDirectory: string, eventData: any): string | undefined {
  const fromEvent = pick(eventData, ['cwd', 'directory', 'worktree']) ?? eventData?.info?.directory;
  const resolved = fromEvent || baseDirectory;
  if (!resolved || typeof resolved !== 'string') return undefined;
  return resolved;
}

function getTranscriptPath(eventData: any): string | undefined {
  const raw = pick(eventData, ['transcriptPath', 'transcript_path']);
  if (!raw) return undefined;
  return String(raw);
}

export const ClaudeMemPlugin: Plugin = async ({ directory, worktree, client }) => {
  const baseDirectory = worktree || directory || '';

  return {
    event: async ({ event }) => {
      const type = event?.type;
      const eventData = event?.properties ?? {};
      const sessionId = getSessionId(event);
      const cwd = resolveCwd(baseDirectory, eventData);

      if (!cwd) {
        await logMessage(client, 'warn', 'Skipping claude-mem hook due to missing workspace directory', {
          type,
          hasDirectory: !!directory,
          hasWorktree: !!worktree,
        });
        return;
      }

      const callHook = async (eventName: string, payload: Record<string, unknown>): Promise<boolean> => {
        const ok = await runHook(client, eventName, payload);
        if (!ok) {
          await logMessage(client, 'warn', 'claude-mem hook failed', { type, eventName });
        }
        return ok;
      };

      if (type === 'session.created' && sessionId) {
        const prompt = pick(eventData, ['prompt', 'message', 'input', 'query']) ?? '';
        await callHook('context', { sessionId, cwd, prompt });
        await callHook('session-init', { sessionId, cwd, prompt });
        return;
      }

      if (type === 'tool.execute.after' && sessionId) {
        const toolName = pick(eventData, ['tool', 'toolName', 'tool_name']) ?? '';
        if (!toolName) return;
        const toolInput = pick(eventData, ['args', 'toolInput', 'tool_input']) ?? {};
        const toolResponse = pick(eventData, ['output', 'result', 'toolResponse', 'tool_response']) ?? {};
        await callHook('observation', { sessionId, cwd, toolName, toolInput, toolResponse });
        return;
      }

      if (type === 'session.status') {
        const statusType = eventData?.status?.type;
        const statusSessionId = pick(eventData, ['sessionID', 'sessionId', 'session_id']);
        if (statusType === 'idle' && statusSessionId) {
          const normalizedSessionId = String(statusSessionId);
          await callHook('summarize', {
            sessionId: normalizedSessionId,
            cwd,
            transcriptPath: getTranscriptPath(eventData),
          });
          await callHook('session-complete', { sessionId: normalizedSessionId, cwd });
          return;
        }
      }

      if ((type === 'session.idle' || type === 'session.deleted') && sessionId) {
        await callHook('summarize', {
          sessionId,
          cwd,
          transcriptPath: getTranscriptPath(eventData),
        });
        await callHook('session-complete', { sessionId, cwd });
      }
    }
  };
};

export default ClaudeMemPlugin;
`;
}

function printInvalidConfigPath(configPath: string): number {
  console.error(`Failed to parse existing config at: ${configPath}`);
  console.error('Please convert it to valid JSON or manually add the claude-mem MCP entry.');
  return 1;
}

function upsertMcpConfig(configPath: string, mcpServerPath: string): number {
  let config: Record<string, any>;
  try {
    config = readJsonObject(configPath);
  } catch {
    return printInvalidConfigPath(configPath);
  }

  const next = { ...config };
  next.mcp = typeof next.mcp === 'object' && next.mcp !== null ? next.mcp : {};
  next.mcp['claude-mem'] = {
    type: 'local',
    command: ['node', mcpServerPath],
    enabled: true,
  };

  try {
    writeJsonObject(configPath, next);
  } catch (error) {
    console.error(`Failed to write OpenCode config: ${(error as Error).message}`);
    return 1;
  }
  return 0;
}

function removeMcpConfig(configPath: string): void {
  if (!existsSync(configPath)) return;
  let config: Record<string, any>;
  try {
    config = readJsonObject(configPath);
  } catch {
    return;
  }

  if (!config.mcp || typeof config.mcp !== 'object') return;
  if (!config.mcp['claude-mem']) return;

  delete config.mcp['claude-mem'];
  writeJsonObject(configPath, config);
}

export function installOpenCodePlugin(target: OpenCodeInstallTarget): number {
  const workerServicePath = findWorkerServicePath();
  const mcpServerPath = findMcpServerPath();
  if (!workerServicePath) {
    console.error('Could not find worker-service.cjs. Build the project first.');
    return 1;
  }
  if (!mcpServerPath) {
    console.error('Could not find mcp-server.cjs. Build the project first.');
    return 1;
  }

  const configPath = getTargetConfigPath(target);
  const hadConfigFile = existsSync(configPath);
  const previousConfigContent = hadConfigFile ? readFileSync(configPath, 'utf-8') : '';

  const configResult = upsertMcpConfig(configPath, mcpServerPath);
  if (configResult !== 0) return configResult;

  const pluginPath = getTargetPluginPath(target);
  try {
    mkdirSync(path.dirname(pluginPath), { recursive: true });
    writeFileSync(pluginPath, createPluginSource(workerServicePath), 'utf-8');
  } catch (error) {
    if (hadConfigFile) {
      try {
        writeFileSync(configPath, previousConfigContent, 'utf-8');
      } catch {
      }
    } else if (existsSync(configPath)) {
      try {
        unlinkSync(configPath);
      } catch {
      }
    }

    console.error(`Failed to install OpenCode plugin file: ${(error as Error).message}`);
    return 1;
  }

  console.log(`Installed OpenCode plugin at ${pluginPath}`);
  console.log(`Updated OpenCode config at ${configPath}`);
  console.log('Restart OpenCode to load the plugin and MCP server.');
  return 0;
}

export function uninstallOpenCodePlugin(target: OpenCodeInstallTarget): number {
  const pluginPath = getTargetPluginPath(target);
  if (existsSync(pluginPath)) {
    unlinkSync(pluginPath);
    console.log(`Removed OpenCode plugin at ${pluginPath}`);
  } else {
    console.log(`Plugin not found at ${pluginPath}`);
  }

  removeMcpConfig(getTargetConfigPath(target));
  console.log('Removed claude-mem MCP config entry if present.');
  console.log('Restart OpenCode to apply changes.');
  return 0;
}

export function checkOpenCodePluginStatus(): number {
  const locations = [
    {
      name: 'Project',
      pluginPath: getTargetPluginPath('project'),
      configPath: getTargetConfigPath('project')
    },
    {
      name: 'Global',
      pluginPath: getTargetPluginPath('global'),
      configPath: getTargetConfigPath('global')
    }
  ];

  let installed = false;

  for (const location of locations) {
    const pluginInstalled = existsSync(location.pluginPath);
    let mcpEnabled = false;

    if (existsSync(location.configPath)) {
      try {
        const config = readJsonObject(location.configPath);
        mcpEnabled = !!config?.mcp?.['claude-mem'];
      } catch {
        mcpEnabled = false;
      }
    }

    if (pluginInstalled || mcpEnabled) installed = true;

    console.log(`${location.name}:`);
    console.log(`  Plugin: ${pluginInstalled ? 'Installed' : 'Not installed'}`);
    console.log(`  MCP: ${mcpEnabled ? 'Configured' : 'Not configured'}`);
    if (pluginInstalled) console.log(`  Path: ${location.pluginPath}`);
    if (existsSync(location.configPath)) console.log(`  Config: ${location.configPath}`);
    console.log('');
  }

  if (!installed) {
    console.log('No OpenCode integration found. Run: claude-mem opencode install');
  }

  return 0;
}

export async function handleOpenCodeCommand(subcommand: string, args: string[]): Promise<number> {
  switch (subcommand) {
    case 'install': {
      const target = (args[0] || 'project') as OpenCodeInstallTarget;
      if (target !== 'project' && target !== 'global') {
        console.error('Invalid target. Use: project or global');
        return 1;
      }
      return installOpenCodePlugin(target);
    }
    case 'uninstall': {
      const target = (args[0] || 'project') as OpenCodeInstallTarget;
      if (target !== 'project' && target !== 'global') {
        console.error('Invalid target. Use: project or global');
        return 1;
      }
      return uninstallOpenCodePlugin(target);
    }
    case 'status': {
      return checkOpenCodePluginStatus();
    }
    default: {
      console.log(`
Claude-Mem OpenCode Integration

Usage: claude-mem opencode <command> [options]

Commands:
  install [target]    Install OpenCode plugin + MCP config
                      target: project (default) or global

  uninstall [target]  Remove OpenCode plugin + MCP config
                      target: project (default) or global

  status              Check installation status

Examples:
  npm run opencode:install
  npm run opencode:install:global
  npm run opencode:status
`);
      return 0;
    }
  }
}
