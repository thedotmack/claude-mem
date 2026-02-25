import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from '@opencode-ai/plugin';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_SERVICE_PATH = resolve(__dirname, '../../plugin/scripts/worker-service.cjs');

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
