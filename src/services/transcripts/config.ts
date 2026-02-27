import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import type { TranscriptSchema, TranscriptWatchConfig } from './types.js';

export const DEFAULT_CONFIG_PATH = join(homedir(), '.claude-mem', 'transcript-watch.json');
export const DEFAULT_STATE_PATH = join(homedir(), '.claude-mem', 'transcript-watch-state.json');

const CODEX_SAMPLE_SCHEMA: TranscriptSchema = {
  name: 'codex',
  version: '0.3',
  description: 'Schema for Codex session JSONL files under ~/.codex/sessions.',
  events: [
    {
      name: 'session-meta',
      match: { path: 'type', equals: 'session_meta' },
      action: 'session_context',
      fields: {
        sessionId: 'payload.id',
        cwd: 'payload.cwd'
      }
    },
    {
      name: 'turn-context',
      match: { path: 'type', equals: 'turn_context' },
      action: 'session_context',
      fields: {
        cwd: 'payload.cwd'
      }
    },
    {
      name: 'user-message',
      match: { path: 'payload.type', equals: 'user_message' },
      action: 'session_init',
      fields: {
        prompt: 'payload.message'
      }
    },
    {
      name: 'assistant-message',
      match: { path: 'payload.type', equals: 'agent_message' },
      action: 'assistant_message',
      fields: {
        message: 'payload.message'
      }
    },
    {
      name: 'tool-use',
      match: { path: 'payload.type', in: ['function_call', 'custom_tool_call', 'web_search_call', 'exec_command'] },
      action: 'tool_use',
      fields: {
        toolId: 'payload.call_id',
        toolName: {
          coalesce: [
            'payload.name',
            'payload.type',
            { value: 'web_search' }
          ]
        },
        toolInput: {
          coalesce: [
            'payload.arguments',
            'payload.input',
            'payload.command',
            'payload.action'
          ]
        }
      }
    },
    {
      name: 'tool-result',
      match: { path: 'payload.type', in: ['function_call_output', 'custom_tool_call_output', 'exec_command_output'] },
      action: 'tool_result',
      fields: {
        toolId: 'payload.call_id',
        toolResponse: 'payload.output'
      }
    },
    {
      name: 'session-end',
      match: { path: 'payload.type', in: ['turn_aborted', 'turn_completed'] },
      action: 'session_end'
    }
  ]
};

export const SAMPLE_CONFIG: TranscriptWatchConfig = {
  version: 1,
  schemas: {
    codex: CODEX_SAMPLE_SCHEMA
  },
  watches: [
    {
      name: 'codex',
      path: '~/.codex/sessions/**/*.jsonl',
      schema: 'codex',
      startAtEnd: true,
      context: {
        mode: 'agents',
        path: '~/.codex/AGENTS.md',
        updateOn: ['session_start', 'session_end']
      }
    }
  ],
  stateFile: DEFAULT_STATE_PATH
};

export function expandHomePath(inputPath: string): string {
  if (!inputPath) return inputPath;
  if (inputPath.startsWith('~')) {
    return join(homedir(), inputPath.slice(1));
  }
  return inputPath;
}

export function loadTranscriptWatchConfig(path = DEFAULT_CONFIG_PATH): TranscriptWatchConfig {
  const resolvedPath = expandHomePath(path);
  if (!existsSync(resolvedPath)) {
    throw new Error(`Transcript watch config not found: ${resolvedPath}`);
  }
  const raw = readFileSync(resolvedPath, 'utf-8');
  const parsed = JSON.parse(raw) as TranscriptWatchConfig;
  if (!parsed.version || !parsed.watches) {
    throw new Error(`Invalid transcript watch config: ${resolvedPath}`);
  }
  if (!parsed.stateFile) {
    parsed.stateFile = DEFAULT_STATE_PATH;
  }
  return parsed;
}

export function writeSampleConfig(path = DEFAULT_CONFIG_PATH): void {
  const resolvedPath = expandHomePath(path);
  const dir = dirname(resolvedPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(resolvedPath, JSON.stringify(SAMPLE_CONFIG, null, 2));
}
