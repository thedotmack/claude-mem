// SPDX-License-Identifier: Apache-2.0
//
// Phase 7 — Runtime selector for hook subcommands.
//
// Reads `CLAUDE_MEM_RUNTIME` from `~/.claude-mem/settings.json` (via
// `loadFromFileOnce`) and decides whether the hook should call the
// server-beta /v1 endpoints or fall through to the worker compat path.
//
// This module deliberately does not import worker code so that hooks
// running in server-beta mode can reach the runtime even when no worker
// is installed.

import { loadFromFileOnce } from '../../shared/hook-settings.js';
import { logger } from '../../utils/logger.js';
import { ServerBetaClient, type ServerBetaClientConfig } from './server-beta-client.js';

export type SelectedRuntime = 'worker' | 'server-beta';

export interface ServerBetaRuntimeContext {
  runtime: 'server-beta';
  client: ServerBetaClient;
  projectId: string;
  serverBaseUrl: string;
}

export interface WorkerRuntimeContext {
  runtime: 'worker';
}

export type RuntimeContext = ServerBetaRuntimeContext | WorkerRuntimeContext;

export function selectRuntime(): SelectedRuntime {
  const settings = loadFromFileOnce();
  const raw = (settings.CLAUDE_MEM_RUNTIME ?? 'worker').trim().toLowerCase();
  if (raw === 'server-beta') return 'server-beta';
  return 'worker';
}

export function buildServerBetaContext(): ServerBetaRuntimeContext | null {
  const settings = loadFromFileOnce();
  const serverBaseUrl = (settings.CLAUDE_MEM_SERVER_BETA_URL ?? '').trim();
  const apiKey = (settings.CLAUDE_MEM_SERVER_BETA_API_KEY ?? '').trim();
  const projectId = (settings.CLAUDE_MEM_SERVER_BETA_PROJECT_ID ?? '').trim();

  if (!serverBaseUrl) {
    logger.warn('HOOK', '[server-beta-fallback] reason=missing_base_url');
    return null;
  }
  if (!apiKey) {
    logger.warn('HOOK', '[server-beta-fallback] reason=missing_api_key');
    return null;
  }
  if (!projectId) {
    logger.warn('HOOK', '[server-beta-fallback] reason=missing_project_id');
    return null;
  }

  const config: ServerBetaClientConfig = {
    serverBaseUrl,
    apiKey,
  };
  return {
    runtime: 'server-beta',
    client: new ServerBetaClient(config),
    projectId,
    serverBaseUrl,
  };
}

export function resolveRuntimeContext(): RuntimeContext {
  if (selectRuntime() !== 'server-beta') {
    return { runtime: 'worker' };
  }
  const ctx = buildServerBetaContext();
  if (!ctx) {
    return { runtime: 'worker' };
  }
  return ctx;
}

export function logServerBetaFallback(reason: string, details?: Record<string, unknown>): void {
  logger.warn('HOOK', `[server-beta-fallback] reason=${reason}`, details ?? {});
}
