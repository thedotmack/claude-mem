import { spawn } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { buildContinuationPrompt, buildInitPrompt, buildObservationPrompt, buildSummaryPrompt } from '../../sdk/prompts.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { OBSERVER_SESSIONS_DIR, paths } from '../../shared/paths.js';
import { estimateTokens } from '../../shared/timeline-formatting.js';
import { logger } from '../../utils/logger.js';
import { ModeManager } from '../domain/ModeManager.js';
import type { ModeConfig } from '../domain/types.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { isAbortError, processAgentResponse, type WorkerRef } from './agents/index.js';
import { ClassifiedProviderError } from './provider-errors.js';

type CodexEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

const DEFAULT_MAX_CONTEXT_MESSAGES = 20;
const DEFAULT_MAX_ESTIMATED_TOKENS = 100000;
const VALID_EFFORTS: CodexEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh'];

export function classifyCodexError(err: unknown): ClassifiedProviderError {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  if (
    lower.includes('codex executable not found') ||
    lower.includes('enoent') ||
    lower.includes('eperm') ||
    lower.startsWith('spawn ')
  ) {
    return new ClassifiedProviderError(message, { kind: 'unrecoverable', cause: err });
  }

  if (lower.includes('401') || lower.includes('403') || lower.includes('auth') || lower.includes('login')) {
    return new ClassifiedProviderError(message, { kind: 'auth_invalid', cause: err });
  }

  if (lower.includes('quota') || lower.includes('insufficient credits')) {
    return new ClassifiedProviderError(message, { kind: 'quota_exhausted', cause: err });
  }

  if (lower.includes('429') || lower.includes('rate limit')) {
    return new ClassifiedProviderError(message, { kind: 'rate_limit', cause: err });
  }

  if (lower.includes('context window') || lower.includes('prompt is too long')) {
    return new ClassifiedProviderError(message, { kind: 'unrecoverable', cause: err });
  }

  return new ClassifiedProviderError(message, { kind: 'transient', cause: err });
}

export class CodexProvider {
  constructor(
    private dbManager: DatabaseManager,
    private sessionManager: SessionManager,
  ) {}

  async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
    const config = this.getCodexConfig();

    if (!session.memorySessionId) {
      const syntheticMemorySessionId = `codex-${session.contentSessionId}-${Date.now()}`;
      session.memorySessionId = syntheticMemorySessionId;
      this.dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, syntheticMemorySessionId);
      logger.info('SESSION', `MEMORY_ID_GENERATED | sessionDbId=${session.sessionDbId} | provider=Codex`);
    }

    const mode = ModeManager.getInstance().getActiveMode();
    const initPrompt = session.lastPromptNumber === 1
      ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
      : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);

    session.conversationHistory.push({ role: 'user', content: initPrompt });

    try {
      const initResponse = await this.queryCodexMultiTurn(session.conversationHistory, config, session.abortController.signal);
      await this.handleProviderResponse(initResponse, session, worker, null, undefined, config.model);
    } catch (error: unknown) {
      return this.handleCodexError(error, session);
    }

    try {
      await this.processMessageLoop(session, worker, config, mode);
    } catch (error: unknown) {
      return this.handleCodexError(error, session);
    }

    const sessionDuration = Date.now() - session.startTime;
    logger.success('SDK', 'Codex agent completed', {
      sessionId: session.sessionDbId,
      duration: `${(sessionDuration / 1000).toFixed(1)}s`,
      historyLength: session.conversationHistory.length,
      model: config.model,
      effort: config.effort,
    });
  }

  private async processMessageLoop(
    session: ActiveSession,
    worker: WorkerRef | undefined,
    config: CodexConfig,
    mode: ModeConfig,
  ): Promise<void> {
    let lastCwd: string | undefined;

    for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
      session.pendingAgentId = message.agentId ?? null;
      session.pendingAgentType = message.agentType ?? null;

      if (message.cwd) {
        lastCwd = message.cwd;
      }

      const originalTimestamp = session.earliestPendingTimestamp;

      if (message.type === 'observation') {
        if (message.prompt_number !== undefined) {
          session.lastPromptNumber = message.prompt_number;
        }
        const obsPrompt = buildObservationPrompt({
          id: 0,
          tool_name: message.tool_name!,
          tool_input: JSON.stringify(message.tool_input),
          tool_output: JSON.stringify(message.tool_response),
          created_at_epoch: originalTimestamp ?? Date.now(),
          cwd: message.cwd,
        });
        session.conversationHistory.push({ role: 'user', content: obsPrompt });
        const obsResponse = await this.queryCodexMultiTurn(session.conversationHistory, config, session.abortController.signal);
        await this.handleProviderResponse(obsResponse, session, worker, originalTimestamp, lastCwd, config.model);
      } else if (message.type === 'summarize') {
        if (!session.memorySessionId) {
          throw new Error('Cannot process summary: memorySessionId not yet captured. This session may need to be reinitialized.');
        }
        const summaryPrompt = buildSummaryPrompt({
          id: session.sessionDbId,
          memory_session_id: session.memorySessionId,
          project: session.project,
          user_prompt: session.userPrompt,
          last_assistant_message: message.last_assistant_message || '',
        }, mode);
        session.conversationHistory.push({ role: 'user', content: summaryPrompt });
        const summaryResponse = await this.queryCodexMultiTurn(session.conversationHistory, config, session.abortController.signal);
        await this.handleProviderResponse(summaryResponse, session, worker, originalTimestamp, lastCwd, config.model);
      }
    }
  }

  private async handleProviderResponse(
    response: { content: string; tokensUsed?: number },
    session: ActiveSession,
    worker: WorkerRef | undefined,
    originalTimestamp: number | null,
    lastCwd: string | undefined,
    model: string,
  ): Promise<void> {
    if (!response.content) {
      logger.warn('SDK', 'Empty Codex response, leaving queue intact', { sessionId: session.sessionDbId });
      return;
    }

    session.conversationHistory.push({ role: 'assistant', content: response.content });
    const tokensUsed = response.tokensUsed || 0;
    session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
    session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
    await processAgentResponse(response.content, session, this.dbManager, this.sessionManager, worker, tokensUsed, originalTimestamp, 'Codex', lastCwd, model);
  }

  private handleCodexError(error: unknown, session: ActiveSession): never {
    if (isAbortError(error)) {
      logger.warn('SDK', 'Codex agent aborted', { sessionId: session.sessionDbId });
      throw error;
    }
    const classified = classifyCodexError(error);
    logger.failure('SDK', 'Codex agent error', { sessionDbId: session.sessionDbId, kind: classified.kind }, error instanceof Error ? error : new Error(String(error)));
    throw classified;
  }

  private truncateHistory(history: ConversationMessage[]): ConversationMessage[] {
    const settings = SettingsDefaultsManager.loadFromFile(paths.settings());
    const maxContextMessages = parseInt(settings.CLAUDE_MEM_CODEX_MAX_CONTEXT_MESSAGES, 10) || DEFAULT_MAX_CONTEXT_MESSAGES;
    const maxEstimatedTokens = parseInt(settings.CLAUDE_MEM_CODEX_MAX_TOKENS, 10) || DEFAULT_MAX_ESTIMATED_TOKENS;

    if (history.length <= maxContextMessages) {
      const totalTokens = history.reduce((sum, message) => sum + estimateTokens(message.content), 0);
      if (totalTokens <= maxEstimatedTokens) return history;
    }

    const truncated: ConversationMessage[] = [];
    let tokenCount = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      const message = history[i];
      const messageTokens = estimateTokens(message.content);
      if (truncated.length > 0 && (truncated.length >= maxContextMessages || tokenCount + messageTokens > maxEstimatedTokens)) {
        logger.warn('SDK', 'Codex context window truncated to prevent runaway costs', {
          originalMessages: history.length,
          keptMessages: truncated.length,
          droppedMessages: i + 1,
          estimatedTokens: tokenCount,
          tokenLimit: maxEstimatedTokens,
        });
        break;
      }
      truncated.unshift(message);
      tokenCount += messageTokens;
    }
    return truncated;
  }

  private buildCodexPrompt(history: ConversationMessage[]): string {
    const truncatedHistory = this.truncateHistory(history);
    return [
      'You are claude-mem memory extraction provider. Continue this extraction conversation.',
      'Return only the XML or structured response requested by the latest user message. Do not inspect files, run tools, or ask questions.',
      '',
      ...truncatedHistory.map((message, index) => `<${message.role} index="${index + 1}">\n${message.content}\n</${message.role}>`),
    ].join('\n');
  }

  private async queryCodexMultiTurn(
    history: ConversationMessage[],
    config: CodexConfig,
    abortSignal: AbortSignal,
  ): Promise<{ content: string; tokensUsed?: number }> {
    const prompt = this.buildCodexPrompt(history);
    const promptTokens = estimateTokens(prompt);
    logger.debug('SDK', `Querying Codex (${config.model})`, {
      turns: history.length,
      promptTokens,
      effort: config.effort,
    });

    const outputDir = mkdtempSync(path.join(os.tmpdir(), 'claude-mem-codex-'));
    const outputFile = path.join(outputDir, 'last-message.txt');
    const args = [
      'exec',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--skip-git-repo-check',
      '--color',
      'never',
      '-C',
      OBSERVER_SESSIONS_DIR,
      '-m',
      config.model,
      '-c',
      `model_reasoning_effort="${config.effort}"`,
      '-o',
      outputFile,
      '-',
    ];

    try {
      const { stdout, stderr, exitCode } = await runCodex(config.executable, args, prompt, abortSignal);
      if (exitCode !== 0) {
        throw new Error(`Codex exec failed with exit code ${exitCode}: ${(stderr || stdout).slice(0, 1000)}`);
      }

      const content = existsSync(outputFile) ? readFileSync(outputFile, 'utf-8').trim() : stdout.trim();
      return {
        content,
        tokensUsed: promptTokens + estimateTokens(content),
      };
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  }

  private getCodexConfig(): CodexConfig {
    const settings = SettingsDefaultsManager.loadFromFile(paths.settings());
    const model = settings.CLAUDE_MEM_CODEX_MODEL || 'gpt-5.4-mini';
    const configuredEffort = (settings.CLAUDE_MEM_CODEX_REASONING_EFFORT || 'medium').toLowerCase();
    const effort = VALID_EFFORTS.includes(configuredEffort as CodexEffort)
      ? configuredEffort as CodexEffort
      : 'medium';
    return {
      executable: resolveCodexExecutable(settings.CLAUDE_MEM_CODEX_PATH),
      model,
      effort,
    };
  }
}

interface CodexConfig {
  executable: string;
  model: string;
  effort: CodexEffort;
}

function runCodex(
  executable: string,
  args: string[],
  stdin: string,
  abortSignal: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    const onAbort = () => {
      child.kill();
      reject(new Error('Codex exec aborted'));
    };

    abortSignal.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', error => {
      abortSignal.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', exitCode => {
      abortSignal.removeEventListener('abort', onAbort);
      resolve({ stdout, stderr, exitCode });
    });
    child.stdin?.end(stdin);
  });
}

export function isCodexSelected(): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(paths.settings());
  return settings.CLAUDE_MEM_PROVIDER === 'codex';
}

export function isCodexAvailable(): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(paths.settings());
  const executable = resolveCodexExecutable(settings.CLAUDE_MEM_CODEX_PATH);
  return executable === 'codex' || existsSync(executable);
}

function resolveCodexExecutable(configuredPath: string): string {
  const trimmed = configuredPath?.trim();
  if (trimmed && trimmed !== 'codex') {
    return trimmed;
  }

  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const bundled = path.join(localAppData, 'OpenAI', 'Codex', 'bin', 'codex.exe');
    if (existsSync(bundled)) return bundled;
  }

  return trimmed || 'codex';
}
