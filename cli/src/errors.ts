/**
 * Exit codes and error types for cmem CLI.
 * Semantic exit codes following gws pattern.
 */

import { homedir } from 'os';

export enum ExitCode {
  SUCCESS = 0,
  WORKER_ERROR = 1,
  CONNECTION_ERROR = 2,
  VALIDATION_ERROR = 3,
  NOT_FOUND = 4,
  INTERNAL_ERROR = 5,
}

export class CLIError extends Error {
  constructor(
    message: string,
    public code: ExitCode,
    public hint?: string,
    public data?: unknown,
  ) {
    super(message);
    this.name = 'CLIError';
  }
}

export function workerNotRunning(baseUrl: string): CLIError {
  return new CLIError(
    `Worker not running at ${baseUrl}`,
    ExitCode.CONNECTION_ERROR,
    "A context memory worker must be running on this port. Check 'cmem worker status' for details.",
  );
}

export function validationError(message: string): CLIError {
  return new CLIError(message, ExitCode.VALIDATION_ERROR);
}

export function notFoundError(message: string): CLIError {
  return new CLIError(message, ExitCode.NOT_FOUND);
}

export function workerError(message: string, data?: unknown): CLIError {
  return new CLIError(message, ExitCode.WORKER_ERROR, undefined, data);
}

export function internalError(message: string): CLIError {
  return new CLIError(message, ExitCode.INTERNAL_ERROR);
}

/**
 * Replace the home directory prefix in a path with `~`.
 * Defense-in-depth: avoids leaking absolute paths in error output.
 */
export function maskPath(path: string): string {
  return path.replace(homedir(), '~');
}
