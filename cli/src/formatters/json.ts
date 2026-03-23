/**
 * JSON output formatter for agent mode.
 * Stable schema — fields may be added but never removed.
 */

import type { CLIResponse } from '../types.js';

export function jsonOutput<T>(data: T, meta?: CLIResponse<T>['meta']): string {
  const response: CLIResponse<T> = { ok: true, data };
  if (meta) response.meta = meta;
  return JSON.stringify(response);
}

export function jsonError(error: string, code: number): string {
  const response: CLIResponse<null> = {
    ok: false,
    data: null,
    error,
    code,
  };
  return JSON.stringify(response);
}
