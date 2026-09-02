import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { DEFAULT_CONFIG_PATH, DEFAULT_STATE_PATH, expandHomePath, SAMPLE_CONFIG } from '../transcripts/config.js';
import type { TranscriptSchema, TranscriptWatchConfig, WatchTarget } from '../transcripts/types.js';

export const GROK_BOT_SCHEMA: TranscriptSchema = {
  name: 'grok-bot',
  version: '1',
  description: 'Grok Bot transcript schema for agent-transcripts/*.jsonl exports',
  events: [
    {
      name: 'grok-user-message',
      match: { path: 'role', equals: 'user' },
      action: 'user_message',
      fields: {
        prompt: { coalesce: ['message.content[0].text', 'message.content[0].content'] },
      },
    },
    {
      name: 'grok-assistant-text',
      match: { path: 'role', equals: 'assistant' },
      action: 'assistant_message',
      fields: {
        message: { coalesce: ['message.content[0].text', 'message.content[0].content'] },
      },
    },
    {
      name: 'grok-tool-use',
      match: { path: 'message.content[0].type', equals: 'tool_use' },
      action: 'tool_use',
      fields: {
        toolId: { coalesce: ['message.content[0].toolUseId', 'message.content[0].tool_use_id', 'message.content[0].id'] },
        toolName: 'message.content[0].name',
        toolInput: { coalesce: ['message.content[0].input', 'message.content[0].arguments'] },
      },
    },
    {
      name: 'grok-tool-result',
      match: { path: 'role', equals: 'tool' },
      action: 'tool_result',
      fields: {
        toolId: { coalesce: ['message.content[0].toolUseId', 'message.content[0].tool_use_id', 'message.content[0].toolId', 'message.content[0].tool_id', 'message.content[0].id'] },
        toolUseId: { coalesce: ['message.content[0].toolUseId', 'message.content[0].tool_use_id', 'message.content[0].toolId', 'message.content[0].tool_id', 'message.content[0].id'] },
        toolName: 'message.content[0].name',
        toolResponse: { coalesce: ['message.content[0].content', 'message.content[0].output', 'message.content[0].text'] },
      },
    },
  ],
};

/** Cowork-style project prefix, plus `box` (Grok Bot host home is /home/box). */
const GENERIC_DIRS = new Set([
  '',
  '/',
  'root',
  'claude',
  'user',
  'home',
  'work',
  'workspace',
  'tmp',
  'uploads',
  'outputs',
  'box',
]);

export function resolveGrokBotProject(name: string): string {
  const base = String(name ?? '').replace(/\/+$/, '').split('/').pop() || '';
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return 'cmem_work_' + (GENERIC_DIRS.has(slug) ? 'root' : slug);
}

function hasAgentsAndTranscripts(dir: string): boolean {
  return existsSync(path.join(dir, 'agents')) && existsSync(path.join(dir, 'agent-transcripts'));
}

export function wellKnownGrokBotAgentDataDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
  const xdgDataHome = env.XDG_DATA_HOME?.trim() || path.join(home, '.local', 'share');
  const candidates = [
    path.join(home, '.grok-bot'),
    path.join(xdgDataHome, 'grok-bot'),
    path.join(home, 'Library', 'Application Support', 'Grok Bot'),
    path.join(home, 'Library', 'Application Support', 'GrokBot'),
    path.join(home, 'Library', 'Application Support', 'xAI', 'Grok Bot'),
    '/home/box',
  ];
  return [...new Set(candidates.filter((dir) => dir && dir !== '/'))];
}

/**
 * Discover the Grok Bot agent-data root used by the no-argument installer.
 * GROK_BOT_AGENT_DATA wins, then well-known dirs that already contain both
 * `agents/` and `agent-transcripts/`, then cwd/agent-data, then cwd.
 */
export function discoverGrokBotAgentDataRoot(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const override = env.GROK_BOT_AGENT_DATA?.trim();
  if (override) {
    return path.resolve(cwd, override);
  }

  for (const dir of wellKnownGrokBotAgentDataDirs(env)) {
    if (hasAgentsAndTranscripts(dir)) {
      return dir;
    }
  }

  const nested = path.join(cwd, 'agent-data');
  if (hasAgentsAndTranscripts(nested)) {
    return nested;
  }
  if (hasAgentsAndTranscripts(cwd)) {
    return cwd;
  }
  return cwd;
}

function resolveGrokBotAgentDataRoot(workspaceRoot: string): string {
  if (hasAgentsAndTranscripts(workspaceRoot)) {
    return workspaceRoot;
  }
  const nested = path.join(workspaceRoot, 'agent-data');
  if (hasAgentsAndTranscripts(nested)) {
    return nested;
  }
  return workspaceRoot;
}

function grokBotProjectWorkspace(agentDataRoot: string, project: string): string {
  return path.join(agentDataRoot, '.cmem-projects', project);
}

function ensureGrokBotProjectWorkspace(agentDataRoot: string, project: string): string {
  const workspace = grokBotProjectWorkspace(agentDataRoot, project);
  mkdirSync(workspace, { recursive: true });
  return workspace;
}

function ensureGrokBotTranscriptDir(agentDataRoot: string, agentId: string): string {
  const transcriptDir = agentId === '*'
    ? path.join(agentDataRoot, 'agent-transcripts')
    : path.join(agentDataRoot, 'agent-transcripts', agentId);
  mkdirSync(transcriptDir, { recursive: true });
  return transcriptDir;
}

function buildGrokBotAgentWatch(
  agentDataRoot: string,
  agentId: string,
  project: string,
  workspace: string,
): WatchTarget {
  ensureGrokBotTranscriptDir(agentDataRoot, agentId);
  return {
    name: 'grok-bot',
    schema: 'grok-bot',
    path: path.join(agentDataRoot, 'agent-transcripts', agentId, '*.jsonl'),
    workspace,
    project,
    startAtEnd: true,
  };
}

interface GrokBotAgent {
  id: string;
  name: string;
}

function listGrokBotAgents(agentDataRoot: string): GrokBotAgent[] {
  const agentsDir = path.join(agentDataRoot, 'agents');
  if (!existsSync(agentsDir)) {
    return [];
  }

  const agents: GrokBotAgent[] = [];
  for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('sand-subagent-')) continue;
    const profilePath = path.join(agentsDir, entry.name, 'profile.json');
    if (!existsSync(profilePath)) continue;
    try {
      const profile = JSON.parse(readFileSync(profilePath, 'utf-8')) as { name?: unknown };
      const name = typeof profile.name === 'string' ? profile.name : '';
      agents.push({ id: entry.name, name });
    } catch {
      continue;
    }
  }
  return agents;
}

function buildGrokBotCatchAllWatch(agentDataRoot: string, ensureWorkspace = false): WatchTarget {
  const project = resolveGrokBotProject('');
  const workspace = ensureWorkspace
    ? ensureGrokBotProjectWorkspace(agentDataRoot, project)
    : grokBotProjectWorkspace(agentDataRoot, project);
  return buildGrokBotAgentWatch(agentDataRoot, '*', project, workspace);
}

/** Catch-all watch covering every agent-transcripts jsonl file, including agents created after install. */
export function buildGrokBotWatch(workspaceRoot = process.cwd()): WatchTarget {
  return buildGrokBotCatchAllWatch(resolveGrokBotAgentDataRoot(workspaceRoot));
}

function buildGrokBotWatches(workspaceRoot: string): WatchTarget[] {
  const agentDataRoot = resolveGrokBotAgentDataRoot(workspaceRoot);
  const perAgent = listGrokBotAgents(agentDataRoot).map((agent) => {
    const project = resolveGrokBotProject(agent.name);
    const workspace = ensureGrokBotProjectWorkspace(agentDataRoot, project);
    return buildGrokBotAgentWatch(agentDataRoot, agent.id, project, workspace);
  });
  return [...perAgent, buildGrokBotCatchAllWatch(agentDataRoot, true)];
}

function loadOrCreateConfig(configPath: string): TranscriptWatchConfig {
  const resolvedPath = expandHomePath(configPath);
  if (!existsSync(resolvedPath)) {
    return {
      ...SAMPLE_CONFIG,
      schemas: { ...(SAMPLE_CONFIG.schemas ?? {}) },
      watches: [...SAMPLE_CONFIG.watches],
      stateFile: DEFAULT_STATE_PATH,
    };
  }

  const parsed = JSON.parse(readFileSync(resolvedPath, 'utf-8')) as TranscriptWatchConfig;
  return {
    version: 1,
    schemas: { ...(parsed.schemas ?? {}) },
    watches: Array.isArray(parsed.watches) ? parsed.watches : [],
    stateFile: parsed.stateFile ?? DEFAULT_STATE_PATH,
  };
}

export function installGrokBotIntegration(configPath = DEFAULT_CONFIG_PATH, workspaceRoot?: string): number {
  const resolvedWorkspaceRoot = workspaceRoot?.trim()
    ? workspaceRoot.trim()
    : discoverGrokBotAgentDataRoot();
  const resolvedConfigPath = expandHomePath(configPath);
  const configDir = path.dirname(resolvedConfigPath);
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  const config = loadOrCreateConfig(resolvedConfigPath);
  config.schemas = {
    ...(config.schemas ?? {}),
    'grok-bot': GROK_BOT_SCHEMA,
  };

  const grokWatches = buildGrokBotWatches(resolvedWorkspaceRoot);
  config.watches = [
    ...config.watches.filter((watch) => watch.name !== 'grok-bot'),
    ...grokWatches,
  ];

  writeFileSync(resolvedConfigPath, JSON.stringify(config, null, 2) + '\n');
  console.log(`  Configured Grok Bot transcript watcher: ${resolvedConfigPath}`);
  for (const watch of grokWatches) {
    console.log(`  Watching: ${watch.path}`);
  }
  return 0;
}
