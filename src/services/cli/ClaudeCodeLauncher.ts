/**
 * ClaudeCodeLauncher - Spawns Claude Code processes to continue sessions
 *
 * Uses the Claude Code CLI to resume sessions with user responses.
 * Key command: `claude --resume <session-id> --print "<response>"`
 */

import { spawn, ChildProcess } from 'child_process';
import { logger } from '../../utils/logger.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';

export interface LaunchResult {
  success: boolean;
  exitCode: number | null;
  error?: string;
}

export class ClaudeCodeLauncher {
  private claudePath: string;

  constructor() {
    // Get Claude Code path from settings or auto-detect
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    this.claudePath = settings.CLAUDE_CODE_PATH || 'claude';
  }

  /**
   * Continue a Claude Code session with a user response
   *
   * @param sessionId The Claude Code session ID to resume
   * @param response The user's response text
   * @param cwd The working directory for the session
   */
  async continueSession(
    sessionId: string,
    response: string,
    cwd: string
  ): Promise<LaunchResult> {
    logger.info('LAUNCHER', 'Continuing Claude Code session', {
      sessionId: sessionId.substring(0, 8) + '...',
      cwd,
      responseLength: response.length,
    });

    // Build the prompt that explains this is a Slack response
    const prompt = this.buildContinuationPrompt(response);

    return this.spawnClaude([
      '--resume', sessionId,
      '--print', prompt,
    ], cwd);
  }

  /**
   * Start a new Claude Code session with a prompt
   */
  async startSession(
    prompt: string,
    cwd: string
  ): Promise<LaunchResult> {
    logger.info('LAUNCHER', 'Starting new Claude Code session', {
      cwd,
      promptLength: prompt.length,
    });

    return this.spawnClaude([
      '--print', prompt,
    ], cwd);
  }

  /**
   * Continue the most recent session in a directory
   */
  async continueLastSession(
    response: string,
    cwd: string
  ): Promise<LaunchResult> {
    logger.info('LAUNCHER', 'Continuing last Claude Code session', {
      cwd,
      responseLength: response.length,
    });

    const prompt = this.buildContinuationPrompt(response);

    return this.spawnClaude([
      '--continue',
      '--print', prompt,
    ], cwd);
  }

  /**
   * Build the continuation prompt
   */
  private buildContinuationPrompt(response: string): string {
    // Simple continuation - just pass the user's response
    // Claude Code will understand this is continuing the conversation
    return response;
  }

  /**
   * Spawn a Claude Code process
   */
  private spawnClaude(args: string[], cwd: string): Promise<LaunchResult> {
    return new Promise((resolve) => {
      logger.debug('LAUNCHER', 'Spawning Claude Code', {
        path: this.claudePath,
        args: args.map(a => a.length > 50 ? a.substring(0, 50) + '...' : a),
        cwd,
      });

      let stderr = '';
      let stdout = '';

      const child: ChildProcess = spawn(this.claudePath, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // Ensure Claude Code doesn't try to open interactive prompts
          CI: 'true',
          TERM: 'dumb',
        },
      });

      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('error', (error) => {
        logger.error('LAUNCHER', 'Failed to spawn Claude Code', {
          path: this.claudePath,
        }, error);

        resolve({
          success: false,
          exitCode: null,
          error: error.message,
        });
      });

      child.on('close', (code) => {
        const success = code === 0;

        if (success) {
          logger.success('LAUNCHER', 'Claude Code session completed', {
            exitCode: code,
            stdoutLength: stdout.length,
          });
        } else {
          logger.warn('LAUNCHER', 'Claude Code session exited with error', {
            exitCode: code,
            stderr: stderr.substring(0, 500),
          });
        }

        resolve({
          success,
          exitCode: code,
          error: success ? undefined : stderr || `Exit code: ${code}`,
        });
      });

      // Set a reasonable timeout (30 minutes for long-running tasks)
      const timeout = setTimeout(() => {
        logger.warn('LAUNCHER', 'Claude Code session timed out, killing process');
        child.kill('SIGTERM');
      }, 30 * 60 * 1000);

      child.on('close', () => {
        clearTimeout(timeout);
      });
    });
  }

  /**
   * Check if Claude Code is available
   */
  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(this.claudePath, ['--version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.on('error', () => {
        resolve(false);
      });

      child.on('close', (code) => {
        resolve(code === 0);
      });
    });
  }
}
