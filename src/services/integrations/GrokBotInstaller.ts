import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { DEFAULT_CONFIG_PATH, DEFAULT_STATE_PATH, expandHomePath, SAMPLE_CONFIG } from '../transcripts/config.js';
import type { TranscriptSchema, TranscriptWatchConfig, WatchTarget } from '../transcripts/types.js';
import { getProjectContext } from '../../utils/project-name.js';

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

export function buildGrokBotWatch(workspaceRoot = process.cwd()): WatchTarget {
  const project = getProjectContext(workspaceRoot).primary;
  return {
    name: 'grok-bot',
    path: path.join(workspaceRoot, 'agent-transcripts', '*', '*.jsonl'),
    schema: 'grok-bot',
    workspace: workspaceRoot,
    project,
    startAtEnd: true,
  };
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

export function installGrokBotIntegration(configPath = DEFAULT_CONFIG_PATH, workspaceRoot = process.cwd()): number {
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

  const watch = buildGrokBotWatch(workspaceRoot);
  const existingIndex = config.watches.findIndex((candidate) =>
    candidate.name === watch.name && candidate.path === watch.path,
  );
  if (existingIndex >= 0) {
    config.watches[existingIndex] = { ...config.watches[existingIndex], ...watch };
  } else {
    config.watches.push(watch);
  }

  writeFileSync(resolvedConfigPath, JSON.stringify(config, null, 2) + '\n');
  console.log(`  Configured Grok Bot transcript watcher: ${resolvedConfigPath}`);
  console.log(`  Watching: ${watch.path}`);
  return 0;
}
