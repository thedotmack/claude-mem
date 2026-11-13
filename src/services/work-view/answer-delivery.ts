/**
 * Sends the owner's answer from My Work into the request's own agent session, as one headless turn that resumes it.
 * The owner clicked, so this is the one run that click starts: no queue, no retry, and a failure is reported and left.
 *
 *   - Claude Code: `claude --resume <session uuid> -p`, the answer on stdin (Claude Code 2.1.317 `--help`:
 *     `-r, --resume [value]  Resume a conversation by session ID`, `-p, --print`).
 *   - Codex: `codex exec resume <session uuid> -`, the answer on stdin (codex-cli 0.166.0 `exec resume --help`:
 *     `[PROMPT] ... If - is used, read from stdin`).
 *
 * The answer is never an argument, so text that starts with a dash is never read as a flag, and no shell is involved.
 * Both run in the session's own folder with the tool's default permissions and the owner's own login and hooks: the
 * turn is the owner's, so claude-mem captures it and the session's reply like any other.
 */
import type { spawn } from 'child_process';
import { statSync } from 'fs';
import { runCommand, type UsableAgent, type UsableAgentId } from '../agent-runner/detect.js';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';

const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The tools an answer can be sent to, by the platform a conversation key records. */
const ANSWER_TOOLS: Record<string, { agent: UsableAgentId; name: string; args: (sessionId: string) => string[] }> = {
  claude: { agent: 'claude-code', name: 'Claude Code', args: sessionId => ['--resume', sessionId, '-p'] },
  codex: { agent: 'codex', name: 'Codex', args: sessionId => ['exec', 'resume', sessionId, '-'] },
};

export interface AnswerTarget { platform: string; sessionId: string; cwd: string; executable: string; args: string[] }

export interface AnswerDeliveryDependencies {
  /** The folder the session ran in, from the worker's own session row. */
  sessionCwd: (platform: string, sessionId: string) => string | null;
  detectAgents: () => Promise<UsableAgent[]>;
  spawnImpl: typeof spawn;
  environment?: () => NodeJS.ProcessEnv;
}

/**
 * Where an answer to this request goes: its latest conversation, as the snapshot names it (`latestConversationKey`, the
 * same one My Work opens as the request's chat). A refusal says why in words My Work can show beside its copy-and-open fallback.
 */
export async function resolveAnswerTarget(request: { conversationKeys?: readonly string[]; latestConversationKey?: string | null }, dependencies: Pick<AnswerDeliveryDependencies, 'sessionCwd' | 'detectAgents'>): Promise<AnswerTarget | { refusal: string }> {
  const key = request.latestConversationKey;
  if (!key && (request.conversationKeys?.length ?? 0) > 1) return { refusal: 'This request has several chats and no recorded time says which is the latest. Open the chat to answer it.' };
  let parsed: unknown = null;
  try { parsed = key ? JSON.parse(key) : null; } catch { /* Not a conversation key: refused below. */ }
  const [, platform, sessionId] = Array.isArray(parsed) ? parsed as unknown[] : [];
  if (typeof platform !== 'string' || typeof sessionId !== 'string') return { refusal: 'This request has no recorded conversation to answer.' };
  const tool = Object.hasOwn(ANSWER_TOOLS, platform) ? ANSWER_TOOLS[platform] : null;
  if (!tool) return { refusal: 'Answers can be sent to Claude Code and Codex sessions only. Open the chat to answer this one.' };
  if (!SESSION_UUID.test(sessionId)) return { refusal: `This ${tool.name} session has no id that can be resumed. Open the chat to answer it.` };
  const cwd = dependencies.sessionCwd(platform, sessionId);
  let cwdIsFolder = false;
  try { cwdIsFolder = !!cwd && statSync(cwd).isDirectory(); } catch { /* A folder that is gone: refused below. */ }
  if (!cwd || !cwdIsFolder) return { refusal: `The folder this ${tool.name} session ran in is not on this computer any more. Open the chat to answer it.` };
  const agent = (await dependencies.detectAgents()).find(candidate => candidate.id === tool.agent);
  if (!agent?.path) return { refusal: `${tool.name} is not installed on this computer. Open the chat to answer it.` };
  if (!agent.authenticated) return { refusal: `${tool.name} is not logged in on this computer (${agent.reason}). Open the chat to answer it.` };
  return { platform, sessionId, cwd, executable: agent.path, args: tool.args(sessionId) };
}

/** Runs the one turn and waits for the tool to exit. Resolves null when it took the turn, else why it did not. */
export async function deliverAnswer(target: AnswerTarget, text: string, dependencies: Pick<AnswerDeliveryDependencies, 'spawnImpl' | 'environment'>): Promise<string | null> {
  // The worker's own Claude Code session variables and its "internal run" mark must not reach the owner's session.
  const { CLAUDE_MEM_INTERNAL: _internal, ...env } = sanitizeEnv(dependencies.environment?.() ?? process.env);
  const result = await runCommand(dependencies.spawnImpl, target.executable, target.args, { cwd: target.cwd, env, input: text });
  if (result.spawnError) return `The tool could not start: ${result.spawnError.message}`.slice(0, 500);
  if (result.exitCode === 0) return null;
  const detail = `${result.stderr}\n${result.stdout}`.trim().split('\n').filter(Boolean).slice(-3).join(' ');
  return `The tool exited ${result.exitCode}${detail ? `: ${detail}` : ''}`.slice(0, 500);
}
