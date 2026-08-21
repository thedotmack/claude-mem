import { findClaudeExecutable as defaultFindClaudeExecutable } from '../../shared/find-claude-executable.js';
import { logger } from '../../utils/logger.js';
import {
  clearDependencyStatus,
  recordClaudeCliSetupRequired,
  snapshotDependencyHealth,
  type DependencyHealthSnapshot,
} from '../../shared/dependency-health.js';

interface DependencyPreflightSettings {
  CLAUDE_MEM_PROVIDER?: string;
}

interface ClassifiedClaudeSetupError {
  kind: string;
  message: string;
}

export interface WorkerDependencyPreflightOptions {
  settings: DependencyPreflightSettings;
  classifyClaudeError: (error: unknown) => ClassifiedClaudeSetupError;
  findClaudeExecutable?: () => string;
}

export function runWorkerDependencyPreflight(options: WorkerDependencyPreflightOptions): DependencyHealthSnapshot {
  const provider = options.settings.CLAUDE_MEM_PROVIDER || 'claude';

  if (provider === 'claude') {
    const findClaudeExecutable = options.findClaudeExecutable ?? (() => defaultFindClaudeExecutable('WORKER'));
    try {
      findClaudeExecutable();
      clearDependencyStatus('claude_cli');
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const classified = options.classifyClaudeError(error);
      const message = classified.kind === 'setup_required'
        ? classified.message
        : `Claude CLI preflight failed: ${err.message}`;
      logger.warn('WORKER', 'Claude CLI dependency preflight failed', {
        kind: classified.kind,
      }, err);
      recordClaudeCliSetupRequired(message);
    }
  } else {
    clearDependencyStatus('claude_cli');
  }

  return snapshotDependencyHealth();
}
