import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, parse, relative, sep } from 'node:path';
import { localWorkspaceRoot } from '../../utils/project-name.js';
import { AppError } from '../server/ErrorHandler.js';
import type { SessionStore } from '../sqlite/SessionStore.js';
import type { CloudSync } from '../sync/CloudSync.js';
import { scanOwnerPrompts, scanWindowStart } from './index.js';
import { HOOK_MATCH_WINDOW_MS } from './setup-scan.js';

/** Filesystem identity scopes consent. Display names and remote URLs can be shared by unrelated checkouts. */
export function workspacePromptMatcher(requested: string): (candidate: string | null) => boolean {
  let cwd: string;
  try {
    if (!isAbsolute(requested) || !statSync(requested).isDirectory()) throw new Error();
    cwd = realpathSync(requested);
  } catch {
    throw new AppError('Run sync setup inside an existing project directory.', 400);
  }
  const root = localWorkspaceRoot(cwd) ?? cwd;
  if (root === parse(root).root || root === realpathSync(homedir())) {
    throw new AppError('Open a specific project directory before importing its prompt history.', 400);
  }
  const matches = new Map<string, boolean>();
  return candidate => {
    if (!candidate || !isAbsolute(candidate)) return false;
    const cached = matches.get(candidate);
    if (cached !== undefined) return cached;
    let allowed = false;
    try {
      const dir = realpathSync(candidate);
      const diff = relative(root, dir);
      if (diff !== '..' && !diff.startsWith('..' + sep) && !isAbsolute(diff)) {
        // A nested worktree, submodule, or independent repository has a different toplevel.
        const repo = localWorkspaceRoot(dir);
        allowed = !repo || repo === root;
      }
    } catch { /* A missing checkout cannot establish workspace identity. */ }
    matches.set(candidate, allowed);
    return allowed;
  };
}

export async function importWorkspacePrompts(
  workspace: string, expectedAccount: string,
  store: Pick<SessionStore, 'importWorkspaceSyncPrompt' | 'workspacePromptSyncCounts'>,
  sync: Pick<CloudSync, 'workspaceSyncAccount' | 'statusWithHubProbe' | 'flush'>,
  scan = scanOwnerPrompts, now = Date.now(),
) {
  if (sync.workspaceSyncAccount() !== expectedAccount) {
    throw new AppError('The worker is paired with a different account. Approve this device for the account that completed checkout.', 409);
  }
  const inWorkspace = workspacePromptMatcher(workspace);
  const status = await sync.statusWithHubProbe();
  if (!status.hub.reachable || status.authError) {
    throw new AppError('The worker could not verify its Cloud Sync connection. Check the device pairing and retry.', 503);
  }
  const since = scanWindowStart(now);
  const result = await scan({
    sinceEpochMs: since,
    acceptTypedPrompt: prompt => prompt.at >= since && prompt.at <= now && inWorkspace(prompt.cwd),
    requireReadableAgentText: true,
  });
  const ids = new Set<number>();
  const claimedHookRowIds = new Set<number>();
  try {
    for (const prompt of result.ownerPrompts) {
      const id = store.importWorkspaceSyncPrompt({
        platformSource: prompt.platformSource, contentSessionId: prompt.sessionId, project: prompt.project,
        nativePromptId: prompt.nativePromptId, promptText: prompt.text, createdAtEpoch: prompt.at,
        hookTextVariants: prompt.hookTextVariants, hookMatchWindowMs: HOOK_MATCH_WINDOW_MS, claimedHookRowIds,
      }, expectedAccount);
      if (id !== null) ids.add(id);
    }
  } finally {
    // A partial failure still drains the exact rows already approved. Re-running preserves their IDs.
    if (ids.size) await sync.flush();
  }
  return {
    eligible: ids.size, ...store.workspacePromptSyncCounts(ids),
    detectedAgents: result.agents.filter(agent => agent.detected).map(agent => agent.label),
    skippedSources: result.skippedSources.length,
  };
}
