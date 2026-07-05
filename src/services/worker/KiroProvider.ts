import { spawn, execSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import { homedir } from 'os';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { OpenAICompatibleProvider, type ProviderQueryResult } from './OpenAICompatibleProvider.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH, DATA_DIR } from '../../shared/paths.js';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';
import { logger } from '../../utils/logger.js';

/**
 * Compression provider backed by the user's Kiro subscription: spawns
 * `kiro-cli chat --no-interactive` with the prompt piped over stdin (argv has
 * size limits; piping was verified on kiro-cli 2.11.0).
 *
 * Two hard constraints shape this provider:
 * - RECURSION GUARD: the spawned chat runs as the `claude-mem-observer` agent
 *   (installed by KiroCliInstaller) which carries NO hooks and NO tools — a
 *   default-agent spawn would fire claude-mem's own hooks and observe its own
 *   compression forever. The agent name is not optional.
 * - OUTPUT HYGIENE: headless output is a TTY-styled stream (ANSI codes, "> "
 *   prompt prefix, spinner frames, "▸ Credits" footer), not structured JSON.
 *   cleanKiroChatOutput() reduces it to the model text before the response
 *   processor parses it.
 *
 * Each headless invocation is a fresh Kiro conversation (no --resume: resumed
 * headless sessions were observed to mint new session ids anyway), so the
 * whole conversation history is flattened into a single prompt per query —
 * the base class already truncates history growth.
 */

const KIRO_CHAT_TIMEOUT_MS = 240000;

interface KiroConfig {
  apiKey: string;
  model: string;
  agentName: string;
  cliPath: string;
}

/** Strip ANSI/OSC codes, spinner frames, the credits footer, and the "> " prompt prefix. */
export function cleanKiroChatOutput(raw: string): string {
  const stripped = raw
    // CSI sequences (colours, cursor visibility like ESC[?25l, line clears)
    .replace(/\u001b\[[0-9;?]*[0-9A-Za-z]/g, '')
    // OSC sequences, BEL- or ST-terminated
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, '')
    // Stray ESC bytes and carriage returns from spinner redraws
    .replace(/[\u001b\r]/g, '');
  const lines = stripped.split('\n').filter(line =>
    !/^\s*▸\s*Credits:/.test(line)
    && !/\d+\s+of\s+\d+\s+hooks finished/.test(line)
    && !/^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⢀⡀⠄⠂⠁]+\s*$/.test(line)
  );
  let text = lines.join('\n').trim();
  if (text.startsWith('> ')) {
    text = text.slice(2);
  }
  return text.trim();
}

/**
 * Flatten the multi-turn conversation into one self-contained prompt: each
 * headless kiro-cli invocation is stateless, so prior turns are replayed as a
 * labelled transcript ahead of the newest user message.
 */
export function flattenConversation(history: ConversationMessage[]): string {
  if (history.length <= 1) {
    return history[0]?.content ?? '';
  }
  const prior = history.slice(0, -1)
    .map(m => `[${m.role === 'assistant' ? 'YOUR PREVIOUS RESPONSE' : 'PREVIOUS INSTRUCTION'}]\n${m.content}`)
    .join('\n\n');
  const latest = history[history.length - 1];
  return `You are continuing a prior conversation. Transcript of earlier turns:\n\n${prior}\n\n[CURRENT INSTRUCTION — respond to this]\n${latest.content}`;
}

/** Absolute path to kiro-cli, or null. Settings override wins, then PATH, then known install locations. */
export function findKiroCliExecutable(): string | null {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  const candidates = [
    settings.CLAUDE_MEM_KIRO_CLI_PATH,
    '/opt/homebrew/bin/kiro-cli',
    '/usr/local/bin/kiro-cli',
    path.join(homedir(), '.local', 'bin', 'kiro-cli'),
    '/Applications/Kiro CLI.app/Contents/MacOS/kiro-cli',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  try {
    const resolved = execSync('which kiro-cli', { stdio: 'pipe' }).toString().trim();
    if (resolved) return resolved;
  } catch {
    // not on PATH
  }
  return null;
}

export function isKiroAvailable(): boolean {
  return findKiroCliExecutable() !== null;
}

export function isKiroSelected(): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  return settings.CLAUDE_MEM_PROVIDER === 'kiro';
}

export class KiroProvider extends OpenAICompatibleProvider<KiroConfig> {
  protected readonly providerName = 'Kiro';
  protected readonly syntheticIdPrefix = 'kiro';
  protected readonly forwardEmptyMessageResponse = true;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    super(dbManager, sessionManager);
  }

  protected getConfig(): KiroConfig {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const cliPath = findKiroCliExecutable();
    if (!cliPath) {
      throw this.missingApiKeyError();
    }
    return {
      // The base class treats an empty apiKey as unconfigured; Kiro auth is
      // the CLI's own login session, so a non-empty sentinel satisfies it.
      apiKey: 'kiro-cli-login',
      model: settings.CLAUDE_MEM_KIRO_MODEL || 'kiro-default',
      agentName: settings.CLAUDE_MEM_KIRO_AGENT || 'claude-mem-observer',
      cliPath,
    };
  }

  protected missingApiKeyError(): Error {
    return new Error('kiro-cli not found. Install Kiro CLI (https://kiro.dev/docs/cli/installation/) and run `kiro-cli login`, or set CLAUDE_MEM_KIRO_CLI_PATH.');
  }

  protected estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  protected buildLastUsage(_result: ProviderQueryResult): ActiveSession['lastUsage'] {
    // kiro-cli reports credits, not token counts — no half-real usage events.
    return null;
  }

  protected async query(history: ConversationMessage[], config: KiroConfig): Promise<ProviderQueryResult> {
    const prompt = flattenConversation(history);
    // Neutral cwd: Kiro keys conversation history by directory; running in the
    // user's project would pollute their Kiro session list.
    const observerCwd = path.join(DATA_DIR, 'kiro-observer');
    mkdirSync(observerCwd, { recursive: true });

    logger.debug('SDK', `Querying Kiro CLI (agent=${config.agentName})`, {
      turns: history.length,
      promptChars: prompt.length,
    });

    const rawOutput = await this.runKiroChat(config, prompt, observerCwd);
    const content = cleanKiroChatOutput(rawOutput);
    return {
      content,
      tokensUsed: this.estimateTokens(prompt + content),
    };
  }

  private runKiroChat(config: KiroConfig, prompt: string, cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      // Drop the hook-delivered session id so the observer chat never inherits
      // the user session's identity.
      const env = sanitizeEnv(process.env);
      delete env.KIRO_SESSION_ID;

      const child = spawn(config.cliPath, ['chat', '--no-interactive', '--agent', config.agentName], {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          child.kill('SIGKILL');
          reject(new Error(`kiro-cli chat timed out after ${KIRO_CHAT_TIMEOUT_MS / 1000}s`));
        }
      }, KIRO_CHAT_TIMEOUT_MS);

      child.stdout.on('data', chunk => { stdout += chunk.toString(); });
      child.stderr.on('data', chunk => { stderr += chunk.toString(); });

      child.on('error', error => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`Failed to spawn kiro-cli: ${error.message}`));
      });

      child.on('close', code => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (code === 0) {
          resolve(stdout);
          return;
        }
        const detail = cleanKiroChatOutput(stderr || stdout).slice(0, 400);
        if (/not logged in/i.test(detail)) {
          reject(new Error('Kiro CLI is not logged in — run `kiro-cli login` to enable the Kiro provider.'));
          return;
        }
        reject(new Error(`kiro-cli chat exited with code ${code}: ${detail}`));
      });

      child.stdin.on('error', () => { /* EPIPE on early exit — close handler reports the real error */ });
      child.stdin.write(prompt);
      child.stdin.end();
    });
  }
}
