// SPDX-License-Identifier: Apache-2.0
//
// The Library as the installers run it: the real environment, the default
// library.json, and the double-context guard (plan Phase 14 task 5).

import { homedir } from 'os';
import { SettingsDefaultsManager } from '../../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH, paths } from '../../../shared/paths.js';
import { logger } from '../../../utils/logger.js';
import { getBunAbsolutePath, getMcpServerAbsolutePath, getNodeAbsolutePath, getWorkerServiceAbsolutePath } from '../../integrations/install-paths.js';
import { memoryInjectionEnabledFor } from '../memory/memory-injection-stage.js';
import { readWireGatewayRoutesFile } from '../routes.js';
import { findLibraryAgentTarget, type LibraryInstallEnvironment } from './agent-library-targets.js';
import { applyLibrary, removeLibrary, type LibraryRemoveRequest } from './library-engine.js';
import { defaultLibraryDirectory, readLibraryRecords } from './library-record.js';
import { LIBRARY_RECOVERY_NOTE_PREFIX, type LibraryApplyRequest, type LibraryApplyResult, type LibraryContext, type LibraryItem } from './types.js';

export function defaultLibraryContext(): LibraryContext {
  return { libraryDirectory: defaultLibraryDirectory() };
}

/** The installing process's environment, with claude-mem's runtime paths resolved (install-paths.ts). */
export function currentLibraryInstallEnvironment(): LibraryInstallEnvironment {
  return {
    home: homedir(),
    env: process.env,
    platform: process.platform,
    cwd: process.cwd(),
    bunPath: getBunAbsolutePath(),
    workerServicePath: getWorkerServiceAbsolutePath(),
    mcpServerPath: getMcpServerAbsolutePath(),
    nodePath: getNodeAbsolutePath(),
  };
}

export interface InstructionsDecision {
  /** True when a wire route already injects memory into this agent's requests. */
  memoryInjectedByWire: boolean;
  /** The routes that do, or why it could not be decided. */
  note?: string;
}

/**
 * Task 5: an agent whose wire route injects memory (Phase 12) gets no
 * instruction-file context block, or it would see its memory twice. A
 * routes.json that cannot be read decides nothing (unknown ≠ empty): the
 * block is written as before and the note says why.
 */
export function wireMemoryInjectionReplacesInstructions(
  libraryAgentId: string,
  options: { routesFilePath?: string; settings?: Readonly<Record<string, string>> } = {},
): InstructionsDecision {
  const target = findLibraryAgentTarget(libraryAgentId);
  if (!target || target.wireAgentIds.length === 0) return { memoryInjectedByWire: false };
  let routes;
  try {
    routes = readWireGatewayRoutesFile(options.routesFilePath ?? paths.wireGatewayRoutes()).routes;
  } catch (error) {
    const note = `could not read the wire routes (${error instanceof Error ? error.message : String(error)}); writing the context block as before`;
    logger.warn('LIBRARY', note, { agent: libraryAgentId });
    return { memoryInjectedByWire: false, note };
  }
  const settings = options.settings ?? (SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH) as unknown as Record<string, string>);
  const injecting = Object.entries(routes)
    .filter(([, route]) => target.wireAgentIds.includes(route.agentId) && memoryInjectionEnabledFor(route, settings))
    .map(([routeId]) => routeId);
  if (injecting.length === 0) return { memoryInjectedByWire: false };
  return { memoryInjectedByWire: true, note: `wire route ${injecting.join(', ')} injects memory; no context block is written` };
}

/** Drop instruction items when the wire injects memory for the agent; the apply still owns their groups, so recorded blocks go. */
export function withoutInstructionsWhenWireInjects(agentId: string, items: LibraryItem[], decision: InstructionsDecision = wireMemoryInjectionReplacesInstructions(agentId)): LibraryItem[] {
  return decision.memoryInjectedByWire ? items.filter((item) => item.kind !== 'instructions') : items;
}

/**
 * Print what rolling back an earlier interrupted change did, one prefixed
 * line per note on stderr (the installers' own output channel), so the user
 * sees it on install, uninstall and `library` commands alike, never only in
 * the log (library-record.ts withLibraryRecords).
 */
export function printLibraryRecoveryNotes(result: LibraryApplyResult, writeError: (line: string) => void = (line) => console.error(line)): LibraryApplyResult {
  for (const note of result.recoveryNotes ?? []) writeError(`${LIBRARY_RECOVERY_NOTE_PREFIX}${note}`);
  return result;
}

export function applyLibraryForInstaller(request: LibraryApplyRequest, context: LibraryContext = defaultLibraryContext()): LibraryApplyResult {
  return printLibraryRecoveryNotes(applyLibrary(request, context));
}

export function removeLibraryForInstaller(request: LibraryRemoveRequest, context: LibraryContext = defaultLibraryContext()): LibraryApplyResult {
  return printLibraryRecoveryNotes(removeLibrary(request, context));
}

/** Whether library.json holds anything for the agent (an install from before the Library leaves no record). */
export function hasLibraryRecord(agentId: string, context: LibraryContext = defaultLibraryContext()): boolean {
  return readLibraryRecords(context.libraryDirectory)[agentId] !== undefined;
}
