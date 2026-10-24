/**
 * Reads the prompts the user typed into every coding agent on this machine,
 * minus the prompts an agent wrote (owner-goals filter, see owner-prompt-filter.ts).
 *
 * Two passes, both read-only:
 *   1. "reading": each agent's transcripts, for typed prompts (files changed
 *      since the window start, prompts inside the window).
 *   2. "checking": agent-authored text from files changed since 9 days before
 *      the window start, to find prompts an agent wrote first. Prompts the
 *      hooks already recorded in claude-mem's DB are checked the same way.
 * An unreadable file is skipped with a logged reason and reported.
 */

import { homedir } from 'os';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { isProjectExcluded } from '../../utils/project-filter.js';
import { stripMemoryTags } from '../../utils/tag-stripping.js';
import { getProjectName } from '../../utils/project-name.js';
import { logger } from '../../utils/logger.js';
import { AgentTextIndex, isAgentWritten, provenanceFingerprint } from './owner-prompt-filter.js';
import { createPromptReaders, type AgentPromptReader, type PromptAgentId, type TypedPrompt } from './readers.js';

export type { PromptAgentId, TypedPrompt } from './readers.js';

/** Claude Code keeps about 30 days of transcripts, so that is what the data holds; every agent uses the same window. */
export const PROMPT_SCAN_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;
/** Agent text written a little before the window can still be the source of a prompt inside it. */
const AGENT_TEXT_LOOKBACK_MS = 9 * DAY_MS;

export interface OwnerPrompt extends TypedPrompt {
  project: string;
  platformSource: string;
}

/** A prompt claude-mem's hooks recorded (SessionStore.listHookRecordedPrompts). */
export interface MemoryPrompt {
  id: number;
  platformSource: string;
  contentSessionId: string;
  promptText: string;
  project?: string;
  cwd?: string | null;
  createdAtEpoch: number;
}

export interface AgentScanSummary {
  id: PromptAgentId;
  label: string;
  platformSource: string;
  /** The agent keeps transcripts on this machine. */
  detected: boolean;
  /** Typed prompts found so far (before the agent-written check). */
  typed: number;
  /** Every session the agent's transcripts hold, typed prompts or not. */
  sessions: Set<string>;
}

export interface PromptScanProgress {
  phase: 'reading' | 'checking';
  agents: AgentScanSummary[];
  bytesDone: number;
  bytesTotal: number;
}

export interface PromptScanOptions {
  sinceEpochMs: number;
  homeDirectory?: string;
  /** Override the configured exclusion list (primarily for isolated scans/tests). */
  excludedProjects?: string;
  agents?: PromptAgentId[];
  resolveProject?: (cwd: string | null) => string;
  memoryPrompts?: MemoryPrompt[];
  onProgress?: (progress: PromptScanProgress) => void;
}

export interface PromptScanResult {
  agents: AgentScanSummary[];
  ownerPrompts: OwnerPrompt[];
  agentWritten: OwnerPrompt[];
  /** Ids of `memoryPrompts` that pass the agent-written check. */
  ownerMemoryPromptIds: Set<number>;
  skippedSources: Array<{ path: string; reason: string }>;
}

export function scanWindowStart(now = Date.now(), days = PROMPT_SCAN_WINDOW_DAYS): number {
  return now - days * DAY_MS;
}

function cachedProjectResolver(): (cwd: string | null) => string {
  const cache = new Map<string, string>();
  return cwd => {
    const key = cwd ?? '';
    if (!cache.has(key)) cache.set(key, getProjectName(cwd));
    return cache.get(key)!;
  };
}

export async function scanOwnerPrompts(options: PromptScanOptions): Promise<PromptScanResult> {
  const homeDirectory = options.homeDirectory ?? homedir();
  const resolveProject = options.resolveProject ?? cachedProjectResolver();
  const excluded = options.excludedProjects ?? process.env.CLAUDE_MEM_EXCLUDED_PROJECTS
    ?? SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH).CLAUDE_MEM_EXCLUDED_PROJECTS;
  const readers = createPromptReaders().filter(reader => !options.agents || options.agents.includes(reader.id));
  const agentTextSince = options.sinceEpochMs - AGENT_TEXT_LOOKBACK_MS;
  const located = readers.map(reader => ({ reader, ...reader.locate(homeDirectory) }));
  const summaries: AgentScanSummary[] = located.map(({ reader, detected }) => ({
    id: reader.id, label: reader.label, platformSource: reader.platformSource, detected, typed: 0, sessions: new Set<string>(),
  }));
  const skippedSources: PromptScanResult['skippedSources'] = [];

  const promptSources = located.map(({ sources }) => sources.filter(source => source.holdsPrompts && source.mtimeMs >= options.sinceEpochMs));
  const agentTextSources = located.map(({ sources }) => sources.filter(source => source.mtimeMs >= agentTextSince));

  async function eachSource(
    phase: PromptScanProgress['phase'],
    sourcesByAgent: typeof promptSources,
    read: (reader: AgentPromptReader, summary: AgentScanSummary, path: Parameters<AgentPromptReader['readPrompts']>[0]) => Promise<void>,
  ): Promise<void> {
    const bytesTotal = sourcesByAgent.flat().reduce((sum, source) => sum + source.bytes, 0);
    let bytesDone = 0;
    options.onProgress?.({ phase, agents: summaries, bytesDone, bytesTotal });
    for (let index = 0; index < located.length; index++) {
      for (const source of sourcesByAgent[index]) {
        try {
          await read(located[index].reader, summaries[index], source);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          if (phase === 'reading') skippedSources.push({ path: source.path, reason });
          logger.warn('IMPORT', 'Skipped an unreadable transcript', { path: source.path, phase, reason });
        }
        bytesDone += source.bytes;
        options.onProgress?.({ phase, agents: summaries, bytesDone, bytesTotal });
      }
    }
  }

  const typedPrompts: TypedPrompt[] = [];
  await eachSource('reading', promptSources, (reader, summary, source) => reader.readPrompts(source, {
    prompt(prompt) {
      if (isProjectExcluded(prompt.cwd ?? resolveProject(null), excluded)) return;
      typedPrompts.push(prompt); summary.typed++;
    },
    session(sessionId) { summary.sessions.add(sessionId); },
  }, options.sinceEpochMs));

  const memoryPrompts = (options.memoryPrompts ?? []).filter(prompt => !isProjectExcluded(prompt.cwd ?? prompt.project ?? '', excluded));
  const fingerprints = [...typedPrompts.map(prompt => prompt.text), ...memoryPrompts.map(prompt => prompt.promptText)]
    .map(provenanceFingerprint)
    .filter((fingerprint): fingerprint is string => fingerprint !== null);
  const agentText = new AgentTextIndex(fingerprints);
  if (agentText.empty) options.onProgress?.({ phase: 'checking', agents: summaries, bytesDone: 1, bytesTotal: 1 });
  else await eachSource('checking', agentTextSources, (reader, _summary, source) => reader.readAgentText(source, (epochSeconds, text) => agentText.add(epochSeconds, text)));

  const ownerPrompts: OwnerPrompt[] = [];
  const agentWritten: OwnerPrompt[] = [];
  const platformOf = new Map(readers.map(reader => [reader.id, reader.platformSource]));
  for (const prompt of typedPrompts.sort((left, right) => left.at - right.at)) {
    // Classify the original text, then apply the shared privacy gate before any consumer sees it.
    const text = stripMemoryTags(prompt.text).trim();
    if (!text) continue;
    const owned: OwnerPrompt = { ...prompt, text,
      ...(prompt.hookTextVariants ? { hookTextVariants: prompt.hookTextVariants.map(value => stripMemoryTags(value).trim()).filter(Boolean) } : {}),
      project: resolveProject(prompt.cwd), platformSource: platformOf.get(prompt.agent)! };
    (isAgentWritten(Math.floor(prompt.at / 1000), prompt.text, agentText) ? agentWritten : ownerPrompts).push(owned);
  }
  const ownerMemoryPromptIds = new Set(memoryPrompts
    .filter(prompt => !isAgentWritten(Math.floor(prompt.createdAtEpoch / 1000), prompt.promptText, agentText))
    .map(prompt => prompt.id));
  return { agents: summaries, ownerPrompts, agentWritten, ownerMemoryPromptIds, skippedSources };
}

/** `readOwnerPrompts({since})`: the owner's typed prompts, oldest first. */
export async function* readOwnerPrompts(options: Omit<PromptScanOptions, 'sinceEpochMs'> & { since?: number } = {}): AsyncIterable<OwnerPrompt> {
  const result = await scanOwnerPrompts({ ...options, sinceEpochMs: options.since ?? scanWindowStart() });
  yield* result.ownerPrompts;
}
