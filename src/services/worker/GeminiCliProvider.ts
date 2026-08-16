import { spawn, SpawnOptions } from 'child_process';
import type { LlmProvider } from '../../shared/LlmProvider.js';
import { logger } from '../../utils/logger.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { paths } from '../../shared/paths.js';

export interface GeminiCliProviderOptions {
  binary?: string;       // default: 'gemini'
  model?: string;        // default: 'gemini-2.5-flash-lite'
}

export class GeminiCliProvider implements LlmProvider {
  name = 'gemini-cli';
  model: string;
  private binary: string;

  constructor(opts: GeminiCliProviderOptions = {}) {
    this.binary = opts.binary ?? 'gemini';
    this.model = opts.model ?? 'gemini-2.5-flash-lite';
  }

  async isAvailable(): Promise<boolean> {
    try {
      const result = spawn(this.binary, ['--version'], {
        timeout: 5000,
        stdio: 'pipe',
      });
      return true;
    } catch (err: any) {
      if (err.code === 'ENOENT') return false;
      return false;
    }
  }

  async extract(input: { prompt: string; maxTokens?: number; temperature?: number }): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let stdout = '';
      let stderr = '';

      try {
        // Use '-p -' to read prompt from stdin, and '-m' to set the model
        const proc = spawn(this.binary, ['-p', '-', '-m', this.model], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        proc.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
        });

        proc.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });

        proc.on('close', (code: number) => {
          if (code === 0) {
            // The output is typically JSON with a 'response' field
            try {
              const parsed = JSON.parse(stdout.trim());
              const response = parsed.response ?? stdout.trim();
              resolve(response);
            } catch {
              // If not valid JSON, return raw output
              resolve(stdout.trim());
            }
          } else {
            const error = stderr.trim() || `agy (Antigravity CLI) exited with code ${code}`;
            reject(new Error(error));
          }
        });

        proc.on('error', (err: any) => {
          if (err.code === 'ENOENT') {
            reject(new Error(`Antigravity CLI (agy) binary not found: ${this.binary}`));
          } else {
            reject(err);
          }
        });

        // Pipe the prompt via stdin
        proc.stdin.write(input.prompt);
        proc.stdin.end();
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          reject(new Error(`Antigravity CLI (agy) binary not found: ${this.binary}`));
        } else {
          reject(err);
        }
      }
    });
  }

  async extractStructured(input: {
    prompt: string;
    schema?: any;
    maxTokens?: number;
  }): Promise<any> {
    // For v1, extract text and parse as JSON
    const text = await this.extract(input);
    try {
      return JSON.parse(text);
    } catch {
      // If not JSON, return raw text in a wrapper
      return { raw: text };
    }
  }

  getSpeed(): 'fast' {
    return 'fast';
  }
}

export function isGeminiCliSelected(): boolean {
  const settingsPath = paths.settings();
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return settings.CLAUDE_MEM_PROVIDER === 'gemini-cli';
}

export async function isGeminiCliAvailable(): Promise<boolean> {
  try {
    const settingsPath = paths.settings();
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
    const binary = settings.CLAUDE_MEM_GEMINI_CLI_BINARY ?? 'gemini';

    return new Promise((resolve) => {
      try {
        const proc = spawn(binary, ['--version'], { stdio: 'pipe', timeout: 1000 });
        let completed = false;

        proc.on('close', () => {
          if (!completed) {
            completed = true;
            resolve(true);
          }
        });

        proc.on('error', () => {
          if (!completed) {
            completed = true;
            resolve(false);
          }
        });

        // Timeout fallback
        setTimeout(() => {
          if (!completed) {
            completed = true;
            try { proc.kill(); } catch { }
            resolve(false);
          }
        }, 1500);
      } catch {
        resolve(false);
      }
    });
  } catch {
    return false;
  }
}
