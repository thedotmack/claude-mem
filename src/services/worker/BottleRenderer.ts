import path from 'path';
import { existsSync, readFileSync } from 'fs';
import { DatabaseManager } from './DatabaseManager.js';
import { logger } from '../../utils/logger.js';
import { BOTTLES_DIR, CLAUDE_CONFIG_DIR, ensureDir } from '../../shared/paths.js';
import { writeTextFileAtomic } from '../../shared/atomic-json.js';
import {
  stripMemoryTags,
  isInjectedUserEnvelope,
  isInternalProtocolPayload,
} from '../../utils/tag-stripping.js';
import { cwdToDashed } from '../context/ObservationCompiler.js';
import { MAX_STORED_PROMPT_CHARS } from '../sqlite/prompt-storage.js';
import { USER_PROMPT_DEDUPE_WINDOW_MS } from '../../shared/user-prompts.js';
import type { SessionStore } from '../sqlite/SessionStore.js';

export interface BottleRenderResult {
  bottlePath: string;
  mode: 'full' | 'reconstructed';
  currentTask: string;
}

interface TranscriptTurn {
  role: 'user' | 'assistant';
  // Render-ready: already stripped of memory tags / extracted from wrappers.
  text: string;
  timestamp?: string;
}

type BottleObservation = ReturnType<SessionStore['getObservationsForBottle']>[number];
type BottleSummary = ReturnType<SessionStore['getSummariesForSession']>[number];

// Mirrors session-init.ts's placeholder for prompts with no text content.
const MEDIA_PROMPT_PLACEHOLDER = '[media prompt]';

// The id becomes a filename and a transcript path segment; anything outside
// this conservative set (or a dot-only name) is refused outright.
const SAFE_CONTENT_SESSION_ID_REGEX = /^[A-Za-z0-9._-]+$/;

const COMMAND_NAME_REGEX = /<command-name\b[^>]*>([\s\S]*?)<\/command-name>/;
const COMMAND_ARGS_REGEX = /<command-args\b[^>]*>([\s\S]*?)<\/command-args>/;

export class BottleRenderer {
  constructor(private dbManager: DatabaseManager) {}

  async renderBottle(
    contentSessionId: string,
    transcriptPath?: string,
    cwd?: string
  ): Promise<BottleRenderResult | null> {
    if (
      !SAFE_CONTENT_SESSION_ID_REGEX.test(contentSessionId) ||
      contentSessionId === '.' ||
      contentSessionId === '..'
    ) {
      logger.warn('WORKER', 'BottleRenderer: refusing unsafe contentSessionId for path use', {
        contentSessionId: contentSessionId.slice(0, 80),
      });
      return null;
    }

    const store = this.dbManager.getSessionStore();

    const sessionDbId = store.createSDKSession(contentSessionId, cwd ?? '', '');
    const dbSession = store.getSessionById(sessionDbId);
    const memorySessionId = dbSession?.memory_session_id ?? null;

    const resolvedTranscriptPath = this.resolveTranscriptPath(contentSessionId, transcriptPath, cwd);
    const transcriptTurns = resolvedTranscriptPath
      ? this.parseTranscriptTurns(readFileSync(resolvedTranscriptPath, 'utf-8'))
      : null;

    const observations = memorySessionId ? store.getObservationsForBottle(memorySessionId) : [];
    const storedPrompts = store.getUserPromptsForSession(contentSessionId);
    const summaries = memorySessionId ? store.getSummariesForSession(memorySessionId) : [];

    // An existing-but-pruned transcript can parse to zero renderable turns;
    // treat it like a missing transcript so stored prompts/summaries still
    // make it into the bottle via reconstructed mode.
    const hasRenderableTranscript = transcriptTurns !== null && transcriptTurns.length > 0;

    if (!hasRenderableTranscript && storedPrompts.length === 0 && observations.length === 0) {
      logger.debug('WORKER', 'BottleRenderer: nothing to render', {
        contentSessionId,
        transcriptPath: transcriptPath ?? null,
        cwd: cwd ?? null,
      });
      return null;
    }

    const mode: BottleRenderResult['mode'] = hasRenderableTranscript ? 'full' : 'reconstructed';
    const project = cwd || dbSession?.project || 'unknown';

    logger.debug('WORKER', 'BottleRenderer: rendering bottle', {
      contentSessionId,
      mode,
      transcriptTurnCount: transcriptTurns?.length ?? 0,
      storedPromptCount: storedPrompts.length,
      observationCount: observations.length,
      summaryCount: summaries.length,
    });

    const markdown = hasRenderableTranscript
      ? this.renderFullBottle(contentSessionId, project, transcriptTurns, observations)
      : this.renderReconstructedBottle(contentSessionId, project, storedPrompts, observations, summaries);

    ensureDir(BOTTLES_DIR);
    const bottlePath = path.join(BOTTLES_DIR, `${contentSessionId}.md`);
    writeTextFileAtomic(bottlePath, markdown);

    logger.debug('WORKER', 'BottleRenderer: bottle written', {
      contentSessionId,
      bottlePath,
      mode,
      bytes: markdown.length,
    });

    return {
      bottlePath,
      mode,
      currentTask: this.resolveCurrentTask(store, contentSessionId, memorySessionId),
    };
  }

  private resolveTranscriptPath(
    contentSessionId: string,
    transcriptPath?: string,
    cwd?: string
  ): string | null {
    if (transcriptPath && existsSync(transcriptPath)) {
      return transcriptPath;
    }
    if (cwd) {
      const dashedCwd = cwdToDashed(cwd);
      const conventionPath = path.join(CLAUDE_CONFIG_DIR, 'projects', dashedCwd, `${contentSessionId}.jsonl`);
      if (existsSync(conventionPath)) {
        return conventionPath;
      }
    }
    return null;
  }

  // Forward parse producing render-ready turns. User-entry keep/skip rules
  // mirror the save-time pipeline (session-init.ts + the SessionRoutes
  // session-init path) so transcript turn numbers align with stored
  // prompt_numbers.
  private parseTranscriptTurns(content: string): TranscriptTurn[] {
    const turns: TranscriptTurn[] = [];
    let lastKeptUserTurn: { text: string; timestampEpoch: number | null } | null = null;

    for (const rawLine of content.split('\n')) {
      if (!rawLine.trim()) continue;
      // Tolerate truncated/malformed JSONL lines (crash mid-write, partial
      // flush, live append) — skip and move on; a torn tail line reappears
      // complete on the next render.
      let line: any;
      try {
        line = JSON.parse(rawLine);
      } catch {
        continue;
      }

      const lineRole = line.type ?? line.role;
      if (lineRole !== 'user' && lineRole !== 'assistant') continue;
      // Subagent traffic never renders.
      if (line.isSidechain === true) continue;
      // Host-generated user records (post-compact summary, local-command
      // caveat notes) are not prompts — save-time never stores them.
      if (lineRole === 'user' && (line.isCompactSummary === true || line.isMeta === true)) continue;

      const timestamp = typeof line.timestamp === 'string' ? line.timestamp : undefined;

      const msgContent = line.message?.content;
      let text = '';
      let mediaOnly = false;
      if (typeof msgContent === 'string') {
        text = msgContent;
      } else if (Array.isArray(msgContent)) {
        const textBlocks = msgContent.filter(
          (c: any): c is { type: 'text'; text: string } =>
            !!c && typeof c === 'object' && c.type === 'text' && typeof c.text === 'string'
        );
        if (textBlocks.length === 0) {
          const hasToolResult = msgContent.some(
            (c: any) => !!c && typeof c === 'object' && c.type === 'tool_result'
          );
          if (lineRole !== 'user' || hasToolResult) continue;
          // Media-only genuine user entry: session-init.ts saves the
          // '[media prompt]' placeholder, consuming a prompt number.
          mediaOnly = true;
        } else {
          text = textBlocks.map((c) => c.text).join('\n');
        }
      } else {
        continue;
      }

      if (lineRole === 'assistant') {
        if (!text.trim()) continue;
        const renderedText = stripMemoryTags(text);
        if (!renderedText) continue;
        turns.push({ role: 'assistant', text: renderedText, timestamp });
        continue;
      }

      let renderedText: string;
      if (mediaOnly) {
        renderedText = MEDIA_PROMPT_PLACEHOLDER;
      } else {
        if (!text.trim()) continue;
        // Mirror session-init.ts: internal protocol payloads are never saved.
        if (isInternalProtocolPayload(text)) continue;
        const commandText = this.extractCommandPromptText(text);
        if (commandText !== null) {
          // Slash-command prompts ARE saved with a prompt_number
          // (SessionRoutes saves cleanedPrompt before its startsWith('/')
          // handling) — the wrapper consumes a turn and renders the command.
          renderedText = commandText;
        } else if (isInjectedUserEnvelope(text)) {
          continue;
        } else {
          renderedText = stripMemoryTags(text);
          // Entirely-private prompts are skipped at save time without
          // consuming a prompt number.
          if (!renderedText) continue;
        }
      }

      // Mirror the save-time duplicate-prompt skip (identical text within the
      // dedupe window is not saved again and consumes no number).
      const timestampEpoch = this.parseTimestampEpoch(timestamp);
      if (
        lastKeptUserTurn !== null &&
        lastKeptUserTurn.text === renderedText &&
        lastKeptUserTurn.timestampEpoch !== null &&
        timestampEpoch !== null &&
        timestampEpoch - lastKeptUserTurn.timestampEpoch <= USER_PROMPT_DEDUPE_WINDOW_MS
      ) {
        continue;
      }

      lastKeptUserTurn = { text: renderedText, timestampEpoch };
      turns.push({ role: 'user', text: renderedText, timestamp });
    }

    return turns;
  }

  // A user entry whose whole text is a command wrapper containing
  // <command-name> corresponds to a saved slash-command prompt. Wrapper
  // entries without <command-name> (e.g. lone local-command-stdout) are
  // command OUTPUT, not prompts.
  private extractCommandPromptText(text: string): string | null {
    if (!isInjectedUserEnvelope(text)) return null;
    const nameMatch = text.match(COMMAND_NAME_REGEX);
    if (!nameMatch) return null;
    const commandName = nameMatch[1].trim();
    if (!commandName) return null;
    const argsMatch = text.match(COMMAND_ARGS_REGEX);
    const commandArgs = argsMatch ? stripMemoryTags(argsMatch[1]).trim() : '';
    return commandArgs ? `${commandName} ${commandArgs}` : commandName;
  }

  private parseTimestampEpoch(timestamp: string | undefined): number | null {
    if (!timestamp) return null;
    const parsed = new Date(timestamp).getTime();
    return Number.isNaN(parsed) ? null : parsed;
  }

  private renderFullBottle(
    contentSessionId: string,
    project: string,
    transcriptTurns: TranscriptTurn[],
    observations: BottleObservation[]
  ): string {
    const observationsByPrompt = this.groupObservationsByPromptNumber(observations);
    const renderedPromptNumbers = new Set<number>();

    // Turns are render-ready and non-empty, so the first user turn is the
    // first prompt with surviving public text.
    const firstUserTurn = transcriptTurns.find((turn) => turn.role === 'user');
    const originalRequest = firstUserTurn?.text ?? '';
    const startedAt = transcriptTurns.find((turn) => turn.timestamp)?.timestamp ?? 'unknown';

    const bodySections: string[] = [];
    let userTurnNumber = 0;

    for (const turn of transcriptTurns) {
      if (turn.role === 'user') {
        userTurnNumber += 1;
        bodySections.push(`**User**${this.formatClockTime(turn.timestamp)}\n${turn.text}`);
        const promptObservations = observationsByPrompt.get(userTurnNumber);
        if (promptObservations) {
          renderedPromptNumbers.add(userTurnNumber);
          bodySections.push(this.renderObservationList(promptObservations));
        }
      } else {
        bodySections.push(`**Assistant**${this.formatClockTime(turn.timestamp)}\n${turn.text}`);
      }
    }

    const unrenderedObservations = observations.filter(
      (observation) => observation.prompt_number === null || !renderedPromptNumbers.has(observation.prompt_number)
    );
    if (unrenderedObservations.length > 0) {
      bodySections.push(this.renderObservationList(unrenderedObservations));
    }

    return this.assembleBottle(contentSessionId, project, startedAt, 'mode: full', originalRequest, bodySections);
  }

  private renderReconstructedBottle(
    contentSessionId: string,
    project: string,
    storedPrompts: ReturnType<SessionStore['getUserPromptsForSession']>,
    observations: BottleObservation[],
    summaries: BottleSummary[]
  ): string {
    const observationsByPrompt = this.groupObservationsByPromptNumber(observations);
    const summariesByPrompt = new Map<number, BottleSummary[]>();
    for (const summary of summaries) {
      if (summary.prompt_number === null) continue;
      const group = summariesByPrompt.get(summary.prompt_number) ?? [];
      group.push(summary);
      summariesByPrompt.set(summary.prompt_number, group);
    }

    const firstRenderablePrompt = storedPrompts.find((prompt) => stripMemoryTags(prompt.prompt_text) !== '');
    const originalRequest = firstRenderablePrompt ? stripMemoryTags(firstRenderablePrompt.prompt_text) : '';
    const startedAt = storedPrompts.length > 0
      ? new Date(storedPrompts[0].created_at_epoch).toISOString()
      : observations.length > 0
        ? new Date(observations[0].created_at_epoch).toISOString()
        : 'unknown';

    const renderedPromptNumbers = new Set<number>();
    const bodySections: string[] = [];

    for (const prompt of storedPrompts) {
      let renderedText = stripMemoryTags(prompt.prompt_text);
      if (prompt.prompt_text.length >= MAX_STORED_PROMPT_CHARS) {
        renderedText += `\n[truncated at ${MAX_STORED_PROMPT_CHARS} chars]`;
      }
      bodySections.push(
        `**User**${this.formatClockTime(new Date(prompt.created_at_epoch).toISOString())}\n${renderedText}`
      );
      renderedPromptNumbers.add(prompt.prompt_number);

      const promptObservations = observationsByPrompt.get(prompt.prompt_number);
      if (promptObservations) {
        bodySections.push(this.renderObservationList(promptObservations));
      }
      for (const summary of summariesByPrompt.get(prompt.prompt_number) ?? []) {
        bodySections.push(this.renderSummaryQuoteBlock(summary));
      }
    }

    const unrenderedObservations = observations.filter(
      (observation) => observation.prompt_number === null || !renderedPromptNumbers.has(observation.prompt_number)
    );
    if (unrenderedObservations.length > 0) {
      bodySections.push(this.renderObservationList(unrenderedObservations));
    }
    for (const summary of summaries) {
      if (summary.prompt_number !== null && renderedPromptNumbers.has(summary.prompt_number)) continue;
      bodySections.push(this.renderSummaryQuoteBlock(summary));
    }

    return this.assembleBottle(
      contentSessionId,
      project,
      startedAt,
      'mode: reconstructed — assistant messages not preserved',
      originalRequest,
      bodySections
    );
  }

  private assembleBottle(
    contentSessionId: string,
    project: string,
    startedAt: string,
    modeLine: string,
    originalRequest: string,
    bodySections: string[]
  ): string {
    const headerBlock = [
      `# Session bottle — ${contentSessionId}`,
      `project: ${project} · started: ${startedAt} · rendered: ${new Date().toISOString()}`,
      modeLine,
      '',
      '## Original request',
      originalRequest,
    ].join('\n');

    const bodyBlock = bodySections.length > 0 ? `\n${bodySections.join('\n\n')}\n` : '\n';
    return `${headerBlock}\n\n---${bodyBlock}---\n`;
  }

  private groupObservationsByPromptNumber(observations: BottleObservation[]): Map<number, BottleObservation[]> {
    const observationsByPrompt = new Map<number, BottleObservation[]>();
    for (const observation of observations) {
      if (observation.prompt_number === null) continue;
      const group = observationsByPrompt.get(observation.prompt_number) ?? [];
      group.push(observation);
      observationsByPrompt.set(observation.prompt_number, group);
    }
    return observationsByPrompt;
  }

  private renderObservationList(observations: BottleObservation[]): string {
    const lines = observations.map((observation) => this.renderObservationLine(observation));
    return `*What happened:*\n${lines.join('\n')}`;
  }

  private renderObservationLine(observation: BottleObservation): string {
    const title = stripMemoryTags(observation.title ?? observation.type).replace(/\s+/g, ' ').trim();
    const clause = this.firstNarrativeClause(observation);
    return clause ? `- [#${observation.id}] ${title} — ${clause}` : `- [#${observation.id}] ${title}`;
  }

  private firstNarrativeClause(observation: BottleObservation): string {
    const narrative = observation.narrative ? stripMemoryTags(observation.narrative).replace(/\s+/g, ' ').trim() : '';
    if (narrative) {
      const firstSentence = narrative.match(/^[\s\S]*?[.!?](?=\s|$)/);
      return firstSentence ? firstSentence[0].trim() : narrative;
    }
    return observation.subtitle ? stripMemoryTags(observation.subtitle).replace(/\s+/g, ' ').trim() : '';
  }

  private renderSummaryQuoteBlock(summary: BottleSummary): string {
    const lines = ['> Session summary (generated by claude-mem — not verbatim)'];
    const fields: Array<[string, string | null]> = [
      ['Request', summary.request],
      ['Investigated', summary.investigated],
      ['Learned', summary.learned],
      ['Completed', summary.completed],
      ['Next steps', summary.next_steps],
      ['Notes', summary.notes],
    ];
    for (const [label, value] of fields) {
      if (!value) continue;
      const renderedValue = stripMemoryTags(value).replace(/\s*\n\s*/g, ' ').trim();
      if (!renderedValue) continue;
      lines.push(`> ${label}: ${renderedValue}`);
    }
    return lines.join('\n');
  }

  private formatClockTime(timestamp: string | undefined): string {
    if (!timestamp) return '';
    const parsed = new Date(timestamp);
    if (Number.isNaN(parsed.getTime())) return '';
    const hours = String(parsed.getHours()).padStart(2, '0');
    const minutes = String(parsed.getMinutes()).padStart(2, '0');
    return ` (${hours}:${minutes})`;
  }

  private resolveCurrentTask(
    store: SessionStore,
    contentSessionId: string,
    memorySessionId: string | null
  ): string {
    const latestSummary = memorySessionId ? store.getSummaryForSession(memorySessionId) : null;
    // Strip before the truthiness check: a fully-private next_steps must fall
    // through to request, then to the latest prompt.
    const strippedNextSteps = latestSummary?.next_steps ? stripMemoryTags(latestSummary.next_steps).trim() : '';
    const strippedRequest = latestSummary?.request ? stripMemoryTags(latestSummary.request).trim() : '';
    const summaryTask = strippedNextSteps || strippedRequest;
    if (summaryTask) {
      return summaryTask.replace(/\s*\n\s*/g, ' ').trim();
    }

    const latestPrompt = store.getLatestUserPrompt(contentSessionId);
    if (latestPrompt?.prompt_text) {
      return stripMemoryTags(latestPrompt.prompt_text).split('\n')[0].trim();
    }
    return '';
  }
}
