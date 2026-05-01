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

const CRUSH_SAMPLE_SCHEMA: TranscriptSchema = {
  name: 'crush',
  version: '0.1',
  description: 'Schema for Crush CLI session data in per-project SQLite databases under <project>/.crush/crush.db. Each row emitted by the SqliteTailer represents one entry in messages.parts.',
  events: [
    {
      name: 'user-text',
      match: {
        all: [
          { path: 'role', equals: 'user' },
          { path: 'part.type', equals: 'text' },
        ],
      },
      action: 'session_init',
      fields: {
        prompt: 'part.data.text',
        sessionId: 'session_id',
      },
    },
    {
      name: 'assistant-text',
      match: {
        all: [
          { path: 'role', equals: 'assistant' },
          { path: 'part.type', equals: 'text' },
        ],
      },
      action: 'assistant_message',
      fields: {
        message: 'part.data.text',
        sessionId: 'session_id',
      },
    },
    {
      name: 'tool-call',
      match: { path: 'part.type', equals: 'tool_call' },
      action: 'tool_use',
      fields: {
        sessionId: 'session_id',
        toolId: {
          coalesce: ['part.data.id', 'part.data.tool_call_id', 'part.data.call_id'],
        },
        toolName: {
          coalesce: ['part.data.name', 'part.data.tool_name'],
        },
        toolInput: {
          coalesce: ['part.data.input', 'part.data.arguments', 'part.data.params'],
        },
      },
    },
    {
      name: 'tool-result',
      match: { path: 'part.type', equals: 'tool_result' },
      action: 'tool_result',
      fields: {
        sessionId: 'session_id',
        toolId: {
          coalesce: ['part.data.tool_call_id', 'part.data.id', 'part.data.call_id'],
        },
        toolName: 'part.data.name',
        toolResponse: {
          coalesce: ['part.data.content', 'part.data.output', 'part.data.result'],
        },
      },
    },
    {
      name: 'turn-finish',
      match: { path: 'part.type', equals: 'finish' },
      action: 'session_end',
      fields: {
        sessionId: 'session_id',
      },
    },
  ],
};

export const SAMPLE_CONFIG: TranscriptWatchConfig = {
  version: 1,
  schemas: {
    codex: CODEX_SAMPLE_SCHEMA,
    crush: CRUSH_SAMPLE_SCHEMA,
  },
  watches: [
    {
      name: 'codex',
      path: '~/.codex/sessions/**/*.jsonl',
      schema: 'codex',
      startAtEnd: true,
      context: {
        mode: 'agents',
        updateOn: ['session_start', 'session_end']
      }
    },
    {
      name: 'crush',
      path: '<registry:crush-projects>',
      source: 'sqlite',
      schema: 'crush',
      registry: 'crush-projects',
      rescanIntervalMs: 30000,
      sqlite: {
        sql: [
          'SELECT',
          '  m.session_id AS session_id,',
          '  m.role       AS role,',
          '  m.created_at AS created_at,',
          '  m.rowid      AS rowid,',
          '  p.key        AS part_index,',
          '  p.value      AS part',
          'FROM messages m, json_each(m.parts) p',
          'WHERE m.rowid > :cursor',
          'ORDER BY m.rowid ASC, p.key ASC',
          'LIMIT 500',
        ].join(' '),
        cursorColumn: 'rowid',
        jsonColumns: ['part'],
        pollIntervalMs: 2000,
      },
    },
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
