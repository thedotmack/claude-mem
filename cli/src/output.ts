/**
 * Dual-mode output system.
 * Human mode: colored tables and formatted text.
 * Agent mode: structured JSON with stable schema.
 */

import type { CLIResponse } from './types.js';
import { CLIError, ExitCode } from './errors.js';

export type OutputMode = 'human' | 'agent';

export function detectOutputMode(options: { json?: boolean }): OutputMode {
  if (options.json) return 'agent';
  if (!process.stdout.isTTY) return 'agent';
  return 'human';
}

export function outputJSON<T>(data: T, meta?: CLIResponse<T>['meta']): void {
  const response: CLIResponse<T> = { ok: true, data };
  if (meta) response.meta = meta;
  process.stdout.write(JSON.stringify(response) + '\n');
}

export function outputError(err: CLIError | Error, mode: OutputMode): void {
  const code = err instanceof CLIError ? err.code : ExitCode.INTERNAL_ERROR;
  const hint = err instanceof CLIError ? err.hint : undefined;

  if (mode === 'agent') {
    const response: CLIResponse<null> = {
      ok: false,
      data: null,
      error: err.message,
      code,
    };
    process.stdout.write(JSON.stringify(response) + '\n');
  } else {
    process.stderr.write(`Error: ${err.message}\n`);
    if (hint) {
      process.stderr.write(`Hint: ${hint}\n`);
    }
  }
}

export function outputText(text: string): void {
  process.stdout.write(text + '\n');
}

export function outputSuccess(message: string, mode: OutputMode): void {
  if (mode === 'agent') {
    outputJSON({ message });
  } else {
    process.stdout.write(message + '\n');
  }
}
