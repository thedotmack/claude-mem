// SPDX-License-Identifier: Apache-2.0
//
// Phase 7 — Runtime selector for hook subcommands.
//
// Reads `CLAUDE_MEM_RUNTIME` from `~/.claude-mem/settings.json` (via
// `loadFromFileOnce`) and decides whether the hook should call the
// server /v1 endpoints or fall through to the worker compat path.
//
// This module deliberately does not import worker code so that hooks
// running in server mode can reach the runtime even when no worker
// is installed.
//
// Phase 1a (cmem-sdk rename): the canonical runtime value is `'server'`.
// The legacy literal `'server-beta'` is still accepted for back-compat so
// existing settings.json files and `CLAUDE_MEM_RUNTIME` values keep
// working. Likewise, new settings keys `CLAUDE_MEM_SERVER_{URL,API_KEY,
// PROJECT_ID}` are read first and fall back to the legacy
// `CLAUDE_MEM_SERVER_BETA_*` keys when unset.

import { loadFromFileOnce } from '../../shared/hook-settings.js';
import { logger } from '../../utils/logger.js';
import { ServerClient, type ServerClientConfig } from './server-client.js';

export type SelectedRuntime = 'worker' | 'server';

export interface ServerRuntimeContext {
  runtime: 'server';
  client: ServerClient;
  projectId: string;
  serverBaseUrl: string;
}

export interface WorkerRuntimeContext {
  runtime: 'worker';
}

export type RuntimeContext = ServerRuntimeContext | WorkerRuntimeContext;

export function selectRuntime(): SelectedRuntime {
  const settings = loadFromFileOnce();
  const raw = (settings.CLAUDE_MEM_RUNTIME ?? 'worker').trim().toLowerCase();
  // Accept both the canonical `'server'` (Phase 1a) and the legacy
  // `'server-beta'` literal for back-compat with installed settings.json.
  if (raw === 'server' || raw === 'server-beta') return 'server';
  return 'worker';
}

export function buildServerContext(): ServerRuntimeContext | null {
  const settings = loadFromFileOnce();
  // Phase 1a: read new keys first, fall back to legacy `*_BETA_*` keys so
  // existing settings.json files keep resolving the server runtime.
  // Treat empty string the same as missing — `settings.json` populated from
  // `SettingsDefaults` will write `""` for unset keys, and we want those to
  // fall through to the legacy keys (not short-circuit to empty).
  const pickFirstNonEmpty = (...candidates: Array<string | undefined>): string => {
    for (const c of candidates) {
      const trimmed = (c ?? '').trim();
      if (trimmed.length > 0) return trimmed;
    }
    return '';
  };
  const serverBaseUrl = pickFirstNonEmpty(
    settings.CLAUDE_MEM_SERVER_URL,
    settings.CLAUDE_MEM_SERVER_BETA_URL,
  );
  const apiKey = pickFirstNonEmpty(
    settings.CLAUDE_MEM_SERVER_API_KEY,
    settings.CLAUDE_MEM_SERVER_BETA_API_KEY,
  );
  const projectId = pickFirstNonEmpty(
    settings.CLAUDE_MEM_SERVER_PROJECT_ID,
    settings.CLAUDE_MEM_SERVER_BETA_PROJECT_ID,
  );

  if (!serverBaseUrl) {
    logger.warn('HOOK', '[server-fallback] reason=missing_base_url');
    return null;
  }
  if (!apiKey) {
    logger.warn('HOOK', '[server-fallback] reason=missing_api_key');
    return null;
  }
  if (!projectId) {
    logger.warn('HOOK', '[server-fallback] reason=missing_project_id');
    return null;
  }

  const config: ServerClientConfig = {
    serverBaseUrl,
    apiKey,
  };
  return {
    runtime: 'server',
    client: new ServerClient(config),
    projectId,
    serverBaseUrl,
  };
}

export function resolveRuntimeContext(): RuntimeContext {
  if (selectRuntime() !== 'server') {
    return { runtime: 'worker' };
  }
  const ctx = buildServerContext();
  if (!ctx) {
    return { runtime: 'worker' };
  }
  return ctx;
}

export function logServerFallback(reason: string, details?: Record<string, unknown>): void {
  logger.warn('HOOK', `[server-fallback] reason=${reason}`, details ?? {});
}
