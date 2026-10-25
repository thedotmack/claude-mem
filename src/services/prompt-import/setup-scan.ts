/**
 * The install funnel's Scan step: read every agent's transcripts for the last
 * 30 days, store the owner's typed prompts in claude-mem's DB, and report live
 * progress. Works the same for a new install (empty DB: everything comes from
 * transcripts) and an upgrade (hooks already recorded most prompts: those are
 * matched, never stored twice, and counted as `fromMemory`).
 *
 * One scan runs at a time; a second start returns the running scan's state.
 * There is no time limit: the scan reports `done` only after every file is read.
 */

import { logger } from '../../utils/logger.js';
import { stripMemoryTags } from '../../utils/tag-stripping.js';
import type { UsableAgent, UsableAgentId } from '../agent-runner/detect.js';
import { observationTokenEconomics, scanTokenUsage, summarizeTokenUsage, type SetupTokenUsage } from './token-usage.js';
import { scanOwnerPrompts, scanWindowStart, type MemoryPrompt, type OwnerPrompt, type PromptAgentId, type PromptScanOptions, type PromptScanProgress } from './index.js';

/** How far apart the hook's time and the transcript's time may be for one prompt (measured: under 7 s on the owner's Mac). */
export const HOOK_MATCH_WINDOW_MS = 10 * 60_000;

export type SetupScanPhase = 'idle' | 'reading' | 'checking' | 'saving' | 'uploading' | 'done' | 'failed';

export interface SetupScanAgent {
  id: PromptAgentId;
  label: string;
  detected: boolean;
  /** The owner's prompts in the window: fromMemory + fromTranscripts. */
  prompts: number;
  /** Already in claude-mem's memory, recorded by its hooks. */
  fromMemory: number;
  /** Only in the agent's transcripts; stored by this import (now or by an earlier scan). */
  fromTranscripts: number;
  /**
   * Whether this agent can run setup's extraction here (installed, logged in, account accepted), from the agent
   * runner's detection. `null` for an agent the runner does not use, or until the check finishes.
   */
  canRunSetup: boolean | null;
  /** Why it cannot, in the detection's words (e.g. "Gemini is installed, but this Google account can't use it: ..."). */
  cannotRunReason: string | null;
}

export interface SetupScanState {
  /** Optional improvement use only; false still runs the complete hosted extraction. */
  improveProduct: boolean;
  agents: SetupScanAgent[];
  percent: number;
  phase: SetupScanPhase;
  done: boolean;
  windowStart: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  /** Prompts newly stored by the last scan. */
  added: number;
  skippedSources: number;
  error: string | null;
  /** Token Savings: 30-day token totals per agent, read in the same pass. Set when the scan is done. */
  usage: SetupTokenUsage | null;
  /** Why the token totals could not be read; the prompt scan itself still finished. */
  usageError: string | null;
  /** The owner's newest typed prompts, newest first, quoted as typed (the Reveal shows them while no agent can extract). */
  recentPrompts: SetupRecentPrompt[];
}

export interface SetupRecentPrompt { agent: PromptAgentId; at: string; text: string }

const RECENT_PROMPTS = 5;
const RECENT_PROMPT_CHARACTERS = 280;

/** The SessionStore methods the scan uses. */
export interface SetupScanStore {
  listHookRecordedPrompts(sinceEpochMs: number): Array<MemoryPrompt & { project: string }>;
  importTranscriptUserPrompt(prompt: {
    platformSource: string; contentSessionId: string; project: string; nativePromptId: string; promptText: string;
    createdAtEpoch: number; hookTextVariants?: string[]; hookMatchWindowMs: number; claimedHookRowIds: Set<number>;
  }): { reason: 'new' | 'already-imported' | 'recorded-by-hook' | 'private'; hookRowId?: number };
  /** claude-mem's observation history, for the Token Savings efficiency percent. */
  streamObservationTokenFields(): Iterable<{ title: string | null; subtitle: string | null; narrative: string | null; facts: string | null; discovery_tokens: number | null }>;
}

export interface SetupScanOptions {
  getStore: () => SetupScanStore;
  scan?: typeof scanOwnerPrompts;
  scanOptions?: Omit<PromptScanOptions, 'sinceEpochMs' | 'memoryPrompts' | 'onProgress'>;
  readTokenUsage?: typeof scanTokenUsage;
  now?: () => number;
  /**
   * Receives the hook-recorded prompts in the window that the owner did not type (an agent wrote them, or the
   * transcripts hold that session without them), so extraction leaves them out.
   */
  saveAgentWrittenPromptIds?: (promptIds: number[]) => void;
  /** The agent runner's detection (installed, logged in, account usable). Waited for, however long it takes. */
  detectAgents?: () => Promise<UsableAgent[]>;
  /** Minimum gap between progress notifications while a phase runs. */
  progressIntervalMs?: number;
}

/** The agent runner's ids as the scan names those agents. */
const RUNNER_AGENT_IDS: Record<UsableAgentId, PromptAgentId> = { 'claude-code': 'claude-code', codex: 'codex', gemini: 'gemini-cli' };

const AGENT_LABELS: Array<[PromptAgentId, string]> = [
  ['claude-code', 'Claude Code'], ['codex', 'Codex'], ['gemini-cli', 'Gemini CLI'], ['antigravity-cli', 'Antigravity CLI'], ['opencode', 'OpenCode'],
];

function idleState(): SetupScanState {
  return {
    improveProduct: true,
    agents: AGENT_LABELS.map(([id, label]) => ({ id, label, detected: false, prompts: 0, fromMemory: 0, fromTranscripts: 0, canRunSetup: null, cannotRunReason: null })),
    percent: 0, phase: 'idle', done: false, windowStart: null, startedAt: null, finishedAt: null, durationMs: null,
    added: 0, skippedSources: 0, error: null, usage: null, usageError: null, recentPrompts: [],
  };
}

export class SetupScan {
  private current: SetupScanState = idleState();
  private running: Promise<void> | null = null;
  private listeners = new Set<(state: SetupScanState) => void>();
  private lastNotified = 0;
  private now: () => number;
  private extract: ((prompts: OwnerPrompt[], improveProduct: boolean) => Promise<void>) | null = null;

  constructor(private options: SetupScanOptions) {
    this.now = options.now ?? Date.now;
  }

  state(): SetupScanState {
    return structuredClone(this.current);
  }

  subscribe(listener: (state: SetupScanState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Setup has one extraction path, supplied by the worker's hosted service. */
  setExtractor(extract: (prompts: OwnerPrompt[], improveProduct: boolean) => Promise<void>): void {
    this.extract = extract;
  }

  setImproveProduct(improveProduct: boolean): SetupScanState {
    if (this.current.phase === 'uploading') throw new Error('The setup upload has already started.');
    this.update({ improveProduct }, true);
    return this.state();
  }

  /** Starts a scan unless one is running. Resolves with the state at start. */
  start(improveProduct?: boolean): SetupScanState {
    if (!this.running) {
      if (improveProduct !== undefined) this.setImproveProduct(improveProduct);
      this.running = this.run().finally(() => { this.running = null; });
    }
    return this.state();
  }

  /** Waits for the running scan, if any (tests and the CLI). */
  async finished(): Promise<SetupScanState> {
    await this.running;
    return this.state();
  }

  private update(changes: Partial<SetupScanState>, force = false): void {
    this.current = { ...this.current, ...changes };
    const now = this.now();
    if (!force && now - this.lastNotified < (this.options.progressIntervalMs ?? 200)) return;
    this.lastNotified = now;
    const snapshot = this.state();
    for (const listener of this.listeners) listener(snapshot);
  }

  private async tokenSavings(
    store: SetupScanStore,
    tokenUsage: ReturnType<typeof scanTokenUsage>,
  ): Promise<{ usage: SetupTokenUsage | null; usageError: string | null }> {
    try {
      return { usage: summarizeTokenUsage(await tokenUsage, observationTokenEconomics(store.streamObservationTokenFields())), usageError: null };
    } catch (error) {
      logger.error('IMPORT', 'Setup token usage could not be read', {}, error as Error);
      return { usage: null, usageError: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Marks each agent the runner uses as able or unable to run setup here. Detection never throws. */
  private async checkRunners(): Promise<void> {
    if (!this.options.detectAgents) return;
    const runners = await this.options.detectAgents();
    this.update({
      agents: this.current.agents.map(agent => {
        const runner = runners.find(entry => RUNNER_AGENT_IDS[entry.id] === agent.id);
        if (!runner) return agent;
        const canRunSetup = runner.authenticated && runner.path !== null;
        return { ...agent, canRunSetup, cannotRunReason: canRunSetup ? null : runner.reason };
      }),
    }, true);
  }

  private async run(): Promise<void> {
    const startedAt = this.now();
    const windowStart = scanWindowStart(startedAt);
    this.current = { ...idleState(), improveProduct: this.current.improveProduct, phase: 'reading', windowStart: new Date(windowStart).toISOString(), startedAt: new Date(startedAt).toISOString() };
    this.update({}, true);
    try {
      const runnerCheck = this.checkRunners();
      const store = this.options.getStore();
      const memoryPrompts = store.listHookRecordedPrompts(windowStart);
      // Token totals are read alongside the prompts, from the same transcripts and window.
      const tokenUsage = (this.options.readTokenUsage ?? scanTokenUsage)({
        sinceEpochMs: windowStart, homeDirectory: this.options.scanOptions?.homeDirectory, agents: this.options.scanOptions?.agents,
      });
      tokenUsage.catch(() => {}); // Awaited (and reported) in tokenSavings, after the prompts.
      let lastPhase: PromptScanProgress['phase'] = 'reading';
      const result = await (this.options.scan ?? scanOwnerPrompts)({
        ...this.options.scanOptions,
        sinceEpochMs: windowStart,
        memoryPrompts,
        onProgress: progress => {
          const share = progress.bytesTotal ? progress.bytesDone / progress.bytesTotal : 1;
          const percent = Math.floor(progress.phase === 'reading' ? share * 50 : 50 + share * 45);
          const agents = this.current.agents.map(agent => {
            const summary = progress.agents.find(entry => entry.id === agent.id);
            return summary ? { ...agent, detected: summary.detected, prompts: summary.typed } : agent;
          });
          this.update({ phase: progress.phase, percent, agents }, progress.phase !== lastPhase);
          lastPhase = progress.phase;
        },
      });

      this.update({ phase: 'saving', percent: 95 }, true);
      const claimedHookRowIds = new Set<number>();
      const fromTranscripts = new Map<string, number>();
      let added = 0;
      result.ownerPrompts.forEach((prompt: OwnerPrompt, index) => {
        let outcome: ReturnType<SetupScanStore['importTranscriptUserPrompt']>;
        try {
          outcome = store.importTranscriptUserPrompt({
            platformSource: prompt.platformSource, contentSessionId: prompt.sessionId, project: prompt.project,
            nativePromptId: prompt.nativePromptId, promptText: prompt.text, createdAtEpoch: prompt.at,
            hookTextVariants: prompt.hookTextVariants, hookMatchWindowMs: HOOK_MATCH_WINDOW_MS, claimedHookRowIds,
          });
        } catch (error) {
          logger.warn('IMPORT', 'Could not store an imported prompt', { agent: prompt.agent, sessionId: prompt.sessionId, error: String(error) });
          return;
        }
        if (outcome.reason === 'new') added++;
        if (outcome.reason === 'new' || outcome.reason === 'already-imported') {
          fromTranscripts.set(prompt.agent, (fromTranscripts.get(prompt.agent) ?? 0) + 1);
        }
        this.update({ percent: 95 + Math.floor((index / Math.max(1, result.ownerPrompts.length)) * 5) });
      });

      await runnerCheck;
      // Hook-recorded prompts count once: matched to a transcript copy, or, when
      // the transcripts no longer hold that session, on their own. A hook row in
      // a session the transcripts hold but did not match was not typed by the owner.
      const agents = this.current.agents.map(agent => {
        const summary = result.agents.find(entry => entry.id === agent.id);
        if (!summary) return { ...agent, prompts: 0, fromMemory: 0, fromTranscripts: 0 };
        const fromMemory = memoryPrompts.filter(prompt => prompt.platformSource === summary.platformSource
          && result.ownerMemoryPromptIds.has(prompt.id)
          && (claimedHookRowIds.has(prompt.id) || !summary.sessions.has(prompt.contentSessionId))).length;
        const transcriptOnly = fromTranscripts.get(agent.id) ?? 0;
        return { ...agent, detected: summary.detected, fromMemory, fromTranscripts: transcriptOnly, prompts: fromMemory + transcriptOnly };
      });
      const sessionsByPlatform = new Map(result.agents.map(summary => [summary.platformSource, summary.sessions]));
      // Prompts the owner typed whose transcripts are gone exist only in memory; extraction reads them too.
      // They get the same tag stripping and current redaction as transcript prompts: they may predate both.
      const memoryOnly: OwnerPrompt[] = memoryPrompts.flatMap(prompt => {
        const summary = result.agents.find(entry => entry.platformSource === prompt.platformSource);
        if (!summary || !result.ownerMemoryPromptIds.has(prompt.id) || claimedHookRowIds.has(prompt.id) || summary.sessions.has(prompt.contentSessionId)) return [];
        const text = stripMemoryTags(prompt.promptText).trim();
        if (!text) return [];
        return [{ agent: summary.id, platformSource: prompt.platformSource, sessionId: prompt.contentSessionId, nativePromptId: `memory-${prompt.id}`,
          at: prompt.createdAtEpoch, cwd: prompt.cwd ?? null, text, project: prompt.project ?? '' }];
      });
      const ownerPrompts = [...result.ownerPrompts, ...memoryOnly];
      const notTyped = memoryPrompts.filter(prompt => !result.ownerMemoryPromptIds.has(prompt.id)
        || (!claimedHookRowIds.has(prompt.id) && Boolean(sessionsByPlatform.get(prompt.platformSource)?.has(prompt.contentSessionId))));
      this.options.saveAgentWrittenPromptIds?.(notTyped.map(prompt => prompt.id));
      const { usage, usageError } = await this.tokenSavings(store, tokenUsage);
      const recentPrompts = [...ownerPrompts].sort((left, right) => right.at - left.at).slice(0, RECENT_PROMPTS)
        .map(prompt => ({ agent: prompt.agent, at: new Date(prompt.at).toISOString(), text: prompt.text.trim().slice(0, RECENT_PROMPT_CHARACTERS) }));
      if (this.extract) {
        // Keep the scan screen open until results are saved; its existing error slot shows Cloud failures.
        this.update({ phase: 'uploading', percent: 99, agents, added, skippedSources: result.skippedSources.length, usage, usageError, recentPrompts }, true);
        await this.extract(ownerPrompts, this.current.improveProduct);
      }
      const finishedAt = this.now();
      this.update({
        phase: 'done', done: true, percent: 100, agents, added, skippedSources: result.skippedSources.length, usage, usageError, recentPrompts,
        finishedAt: new Date(finishedAt).toISOString(), durationMs: finishedAt - startedAt,
      }, true);
      logger.info('IMPORT', 'Setup prompt scan finished', { added, durationMs: finishedAt - startedAt });
    } catch (error) {
      const finishedAt = this.now();
      logger.error('IMPORT', 'Setup prompt scan failed', {}, error as Error);
      this.update({ phase: 'failed', done: true, error: error instanceof Error ? error.message : String(error), finishedAt: new Date(finishedAt).toISOString(), durationMs: finishedAt - startedAt }, true);
    }
  }
}
