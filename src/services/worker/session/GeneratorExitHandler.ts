import type { ActiveSession } from '../../worker-types.js';
import type { SessionManager } from '../SessionManager.js';
import type { SessionCompletionHandler } from './SessionCompletionHandler.js';
import { getSdkProcessForSession, ensureSdkProcessExit } from '../../../supervisor/process-registry.js';

export interface GeneratorExitDependencies {
  sessionManager: SessionManager;
  completionHandler: SessionCompletionHandler;
}

export async function handleGeneratorExit(
  session: ActiveSession,
  deps: GeneratorExitDependencies
): Promise<void> {
  const tracked = getSdkProcessForSession(session.sessionDbId);
  if (tracked && !tracked.process.killed && tracked.process.exitCode === null) {
    await ensureSdkProcessExit(tracked, 5000);
  }

  session.generatorPromise = null;
  session.currentProvider = null;

  deps.completionHandler.finalizeSession(session.sessionDbId);
  deps.sessionManager.removeSessionImmediate(session.sessionDbId);
}
