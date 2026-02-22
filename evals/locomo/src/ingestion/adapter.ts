/**
 * Ingestion adapter for the LoCoMo evaluation harness.
 *
 * Transforms LoCoMo conversation sessions into worker API call parameters.
 * Produces deterministic IDs and formats dialog transcripts as tool executions
 * so claude-mem's compression pipeline processes them naturally.
 */

import type { LoCoMoSample, LoCoMoSession, LoCoMoTurn } from "../types.js";

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic content session ID for a LoCoMo session.
 * Format: `locomo-{sampleId}-s{sessionId}`
 */
export function generateContentSessionId(
  sampleId: string,
  sessionId: number
): string {
  return `locomo-${sampleId}-s${sessionId}`;
}

/**
 * Generate a project name for a LoCoMo conversation.
 * One project per conversation enables isolated search during QA.
 * Format: `locomo-eval-{sampleId}`
 */
export function generateProjectName(sampleId: string): string {
  return `locomo-eval-${sampleId}`;
}

// ---------------------------------------------------------------------------
// Session formatting
// ---------------------------------------------------------------------------

export interface FormattedToolExecution {
  toolName: string;
  toolInput: string;
  toolResponse: string;
  userPrompt: string;
}

/**
 * Transform a LoCoMo session into worker API parameters shaped like a
 * Read tool execution. The raw dialog transcript is passed as tool_response
 * so claude-mem's Sonnet 4.6 agent compresses and extracts observations
 * naturally — simulating real usage.
 */
export function formatSessionAsToolExecution(
  sample: LoCoMoSample,
  session: LoCoMoSession
): FormattedToolExecution {
  const { speaker_a, speaker_b } = sample.conversation;
  const sessionId = session.session_id;
  const date = session.date;

  const toolName = "Read";

  const toolInput = JSON.stringify({
    file_path: `conversation-transcript/session-${sessionId}.txt`,
  });

  const toolResponse = formatDialogTranscript(
    session.turns,
    sessionId,
    date,
    speaker_a as string,
    speaker_b as string
  );

  const userPrompt = `Conversation between ${speaker_a} and ${speaker_b} on ${date}`;

  return { toolName, toolInput, toolResponse, userPrompt };
}

// ---------------------------------------------------------------------------
// Transcript formatting
// ---------------------------------------------------------------------------

/**
 * Format dialog turns into a readable transcript.
 *
 * Output format:
 * ```
 * [Session {N} — {date}]
 * [Conversation between {speaker_a} and {speaker_b}]
 *
 * {speaker_a}: {turn 1 text}
 * {speaker_b}: {turn 2 text}
 * ...
 * ```
 */
function formatDialogTranscript(
  turns: LoCoMoTurn[],
  sessionId: number,
  date: string,
  speakerA: string,
  speakerB: string
): string {
  const header = `[Session ${sessionId} — ${date}]\n[Conversation between ${speakerA} and ${speakerB}]`;

  const speakerMap: Record<string, string> = {
    A: speakerA,
    B: speakerB,
  };

  const lines = turns.map((turn) => {
    const speakerName = speakerMap[turn.speaker] ?? turn.speaker;
    return `${speakerName}: ${turn.text}`;
  });

  return `${header}\n\n${lines.join("\n")}`;
}
