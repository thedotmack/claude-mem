
import { logger } from '../utils/logger.js';
import type { ModeConfig } from '../services/domain/types.js';

export const SUMMARY_MODE_MARKER = 'MODE SWITCH: PROGRESS SUMMARY';

export interface Observation {
  id: number;
  tool_name: string;
  tool_input: string;
  tool_output: string;
  created_at_epoch: number;
  cwd?: string;
}

export interface SDKSession {
  id: number;
  memory_session_id: string | null;
  project: string;
  user_prompt: string;
  last_assistant_message?: string;
}

/**
 * Backfill prompt framing (#2690): when a session is replaying a COMPLETED
 * transcript (session.backfill), the observer is framed for historical replay —
 * "this already happened, record what was done" — instead of the live "watching
 * work happen RIGHT NOW" framing, which makes the model skip everything as
 * not-yet-actionable. Selected per-session via the `backfill` argument on
 * buildInitPrompt / buildObservationPrompt / buildContinuationPrompt.
 */
const BACKFILL_SYSTEM_IDENTITY = `You are Claude-Mem, a specialized tool creating searchable memory FOR FUTURE SESSIONS from a COMPLETED Claude Code session being replayed from the archive.

CRITICAL: This session ALREADY HAPPENED — you are processing a finished transcript, NOT watching live work. For each tool use provided, record what was LEARNED/BUILT/FIXED/DEPLOYED/CONFIGURED/DISCOVERED.

You do not have access to tools. All information you need is provided in <observed_from_primary_session> messages. Create observations from what you observe - no investigation needed.`;

const BACKFILL_OBSERVER_ROLE = `Your job is to read a COMPLETED Claude Code session tool-use by tool-use and record durable observations of the work that was done. The session is already finished; you are reconstructing memory from the historical record. These tool uses represent real work that already occurred — prefer recording over skipping.`;

const BACKFILL_RECORDING_FOCUS = `WHAT TO RECORD
--------------
Record durable technical signal from each tool use:
- What the system NOW DOES differently (new capabilities)
- What shipped (features, fixes, configs, docs)
- Changes in technical domains (auth, data, UI, infra, DevOps, docs)
- Concrete debugging/investigative findings from logs, traces, queue state, database rows, code-path inspection

Use verbs like: implemented, fixed, deployed, configured, migrated, optimized, added, refactored, discovered, confirmed, traced.`;

const BACKFILL_SKIP_GUIDANCE = `WHEN TO SKIP
------------
Prefer recording. Only return an empty response for a GENUINELY contentless tool use:
- An empty status check that revealed nothing
- A file read/listing that returned nothing or "not found"
If a tool use produced real output or advanced the work, record it. Do not skip merely because the operation looks routine — in a historical replay the cumulative record is the value. If skipping, return an empty response only; never explain the skip in prose.`;

function buildBackfillInitPrompt(project: string, sessionId: string, userPrompt: string, mode: ModeConfig): string {
  return `${BACKFILL_SYSTEM_IDENTITY}

<observed_from_primary_session>
  <user_request>${userPrompt}</user_request>
  <requested_at>${new Date().toISOString().split('T')[0]}</requested_at>
</observed_from_primary_session>

${BACKFILL_OBSERVER_ROLE}

${mode.prompts.spatial_awareness}

${BACKFILL_RECORDING_FOCUS}

${BACKFILL_SKIP_GUIDANCE}

${mode.prompts.output_format_header}

<observation>
  <type>[ ${mode.observation_types.map(t => t.id).join(' | ')} ]</type>
  <!--
    ${mode.prompts.type_guidance}
  -->
  <title>${mode.prompts.xml_title_placeholder}</title>
  <subtitle>${mode.prompts.xml_subtitle_placeholder}</subtitle>
  <facts>
    <fact>${mode.prompts.xml_fact_placeholder}</fact>
    <fact>${mode.prompts.xml_fact_placeholder}</fact>
    <fact>${mode.prompts.xml_fact_placeholder}</fact>
  </facts>
  <!--
    ${mode.prompts.field_guidance}
  -->
  <narrative>${mode.prompts.xml_narrative_placeholder}</narrative>
  <concepts>
    <concept>${mode.prompts.xml_concept_placeholder}</concept>
    <concept>${mode.prompts.xml_concept_placeholder}</concept>
  </concepts>
  <files_read>
    <file>${mode.prompts.xml_file_placeholder}</file>
  </files_read>
  <files_modified>
    <file>${mode.prompts.xml_file_placeholder}</file>
  </files_modified>
</observation>
${mode.prompts.format_examples}

${mode.prompts.footer}

${mode.prompts.header_memory_start}`;
}

export function buildInitPrompt(project: string, sessionId: string, userPrompt: string, mode: ModeConfig, backfill = false): string {
  if (backfill) {
    return buildBackfillInitPrompt(project, sessionId, userPrompt, mode);
  }
  return `${mode.prompts.system_identity}

<observed_from_primary_session>
  <user_request>${userPrompt}</user_request>
  <requested_at>${new Date().toISOString().split('T')[0]}</requested_at>
</observed_from_primary_session>

${mode.prompts.observer_role}

${mode.prompts.spatial_awareness}

${mode.prompts.recording_focus}

${mode.prompts.skip_guidance}

${mode.prompts.output_format_header}

<observation>
  <type>[ ${mode.observation_types.map(t => t.id).join(' | ')} ]</type>
  <!--
    ${mode.prompts.type_guidance}
  -->
  <title>${mode.prompts.xml_title_placeholder}</title>
  <subtitle>${mode.prompts.xml_subtitle_placeholder}</subtitle>
  <facts>
    <fact>${mode.prompts.xml_fact_placeholder}</fact>
    <fact>${mode.prompts.xml_fact_placeholder}</fact>
    <fact>${mode.prompts.xml_fact_placeholder}</fact>
  </facts>
  <!--
    ${mode.prompts.field_guidance}
  -->
  <narrative>${mode.prompts.xml_narrative_placeholder}</narrative>
  <concepts>
    <concept>${mode.prompts.xml_concept_placeholder}</concept>
    <concept>${mode.prompts.xml_concept_placeholder}</concept>
  </concepts>
  <!--
    ${mode.prompts.concept_guidance}
  -->
  <files_read>
    <file>${mode.prompts.xml_file_placeholder}</file>
    <file>${mode.prompts.xml_file_placeholder}</file>
  </files_read>
  <files_modified>
    <file>${mode.prompts.xml_file_placeholder}</file>
    <file>${mode.prompts.xml_file_placeholder}</file>
  </files_modified>
</observation>
${mode.prompts.format_examples}

${mode.prompts.footer}

${mode.prompts.header_memory_start}`;
}

// Per-field character budget for the <parameters> / <outcome> blocks in an
// observation prompt. Each field is allowed up to OBS_PROMPT_FIELD_MAX_CHARS;
// content past that is replaced with a head + tail slice plus an explicit
// <elided ...> marker so the observer model can see *that* truncation
// happened (and won't fabricate detail about the missing range).
//
// 16k chars ≈ ~4k tokens (4 chars/token rough estimate). Two fields per
// observation → ~8k tokens of variable input. With a 128k-token observer
// model that leaves ample room for the system prompt, conversation
// history, and the model's own response — and prevents a single oversized
// Read tool result (issue #2468 reports a 130k-char file) from blowing
// the entire context window and forcing the SDK session to abort with
// "prompt is too long".
//
// Head/tail ratio (60% / 30%) keeps the start of the field (where most
// tools put their canonical signal — file path, error message, command
// header) and the tail (where errors / final-line context typically sit)
// while dropping the middle. The 10% remainder is the elision marker.
const OBS_PROMPT_FIELD_MAX_CHARS = 16_000;
const OBS_PROMPT_FIELD_HEAD_RATIO = 0.6;
const OBS_PROMPT_FIELD_TAIL_RATIO = 0.3;

function truncateObservationField(value: unknown, maxChars: number = OBS_PROMPT_FIELD_MAX_CHARS): string {
  // JSON.stringify returns undefined for undefined / functions / symbols;
  // fall back to empty string so the call sites (template literal output)
  // and the length check below stay well-defined.
  const raw = JSON.stringify(value, null, 2) ?? '';
  if (raw.length <= maxChars) return raw;
  const headChars = Math.max(0, Math.floor(maxChars * OBS_PROMPT_FIELD_HEAD_RATIO));
  const tailChars = Math.max(0, Math.floor(maxChars * OBS_PROMPT_FIELD_TAIL_RATIO));
  const head = raw.slice(0, headChars);
  const tail = tailChars > 0 ? raw.slice(-tailChars) : '';
  const elidedChars = Math.max(0, raw.length - head.length - tail.length);
  return `${head}\n... <elided chars="${elidedChars}" original_size_chars="${raw.length}" reason="oversize" /> ...\n${tail}`;
}

export function buildObservationPrompt(obs: Observation, backfill = false): string {
  let toolInput: any;
  let toolOutput: any;

  try {
    toolInput = typeof obs.tool_input === 'string' ? JSON.parse(obs.tool_input) : obs.tool_input;
  } catch (error: unknown) {
    logger.debug('SDK', 'Tool input is plain string, using as-is', {
      toolName: obs.tool_name
    }, error instanceof Error ? error : new Error(String(error)));
    toolInput = obs.tool_input;
  }

  try {
    toolOutput = typeof obs.tool_output === 'string' ? JSON.parse(obs.tool_output) : obs.tool_output;
  } catch (error: unknown) {
    logger.debug('SDK', 'Tool output is plain string, using as-is', {
      toolName: obs.tool_name
    }, error instanceof Error ? error : new Error(String(error)));
    toolOutput = obs.tool_output;
  }

  const trailer = backfill
    ? `Record what this tool use accomplished as one or more <observation>...</observation> blocks. This is a historical replay — prefer recording over skipping; return an empty response ONLY if the tool use is genuinely contentless.
Concrete debugging findings from logs, queue state, database rows, session routing, or code-path inspection count as durable discoveries and should be recorded.
Never reply with prose such as "Skipping", "No observations to record", or any explanation outside XML. Non-XML text is discarded.`
    : `Return either one or more <observation>...</observation> blocks, or an empty response if this tool use should be skipped.
Concrete debugging findings from logs, queue state, database rows, session routing, or code-path inspection count as durable discoveries and should be recorded.
Never reply with prose such as "Skipping", "No substantive tool executions", or any explanation outside XML. Non-XML text is discarded.`;

  return `<observed_from_primary_session>
  <what_happened>${obs.tool_name}</what_happened>
  <occurred_at>${new Date(obs.created_at_epoch).toISOString()}</occurred_at>${obs.cwd ? `\n  <working_directory>${obs.cwd}</working_directory>` : ''}
  <parameters>${truncateObservationField(toolInput)}</parameters>
  <outcome>${truncateObservationField(toolOutput)}</outcome>
</observed_from_primary_session>

If a <parameters> or <outcome> block above contains an "<elided chars=... />" marker, that field was truncated to fit the observer's context window. Describe only what you can see in the kept portion and do not infer details about the elided range.

${trailer}`;
}

export function buildSummaryPrompt(session: SDKSession, mode: ModeConfig): string {
  const lastAssistantMessage = session.last_assistant_message || (() => {
    logger.error('SDK', 'Missing last_assistant_message in session for summary prompt', {
      sessionId: session.id
    });
    return '';
  })();

  return `--- ${SUMMARY_MODE_MARKER} ---
⚠️ CRITICAL TAG REQUIREMENT — READ CAREFULLY:
• You MUST wrap your ENTIRE response in <summary>...</summary> tags.
• Do NOT use <observation> tags. <observation> output will be DISCARDED and cause a system error.
• The ONLY accepted root tag is <summary>. Any other root tag is a protocol violation.

${mode.prompts.header_summary_checkpoint}
${mode.prompts.summary_instruction}

${mode.prompts.summary_context_label}
${lastAssistantMessage}

${mode.prompts.summary_format_instruction}
<summary>
  <request>${mode.prompts.xml_summary_request_placeholder}</request>
  <investigated>${mode.prompts.xml_summary_investigated_placeholder}</investigated>
  <learned>${mode.prompts.xml_summary_learned_placeholder}</learned>
  <completed>${mode.prompts.xml_summary_completed_placeholder}</completed>
  <next_steps>${mode.prompts.xml_summary_next_steps_placeholder}</next_steps>
  <notes>${mode.prompts.xml_summary_notes_placeholder}</notes>
</summary>

REMINDER: Your response MUST use <summary> as the root tag, NOT <observation>.
${mode.prompts.summary_footer}`;
}

export function buildContinuationPrompt(userPrompt: string, promptNumber: number, contentSessionId: string, mode: ModeConfig, backfill = false): string {
  if (backfill) {
    // Backfill continuation (e.g. after a respawn mid-replay) reuses the
    // historical framing; the START/CONTINUED header difference is cosmetic.
    return buildBackfillInitPrompt('', contentSessionId, userPrompt, mode);
  }
  return `${mode.prompts.continuation_greeting}

<observed_from_primary_session>
  <user_request>${userPrompt}</user_request>
  <requested_at>${new Date().toISOString().split('T')[0]}</requested_at>
</observed_from_primary_session>

${mode.prompts.system_identity}

${mode.prompts.observer_role}

${mode.prompts.spatial_awareness}

${mode.prompts.recording_focus}

${mode.prompts.skip_guidance}

${mode.prompts.continuation_instruction}

${mode.prompts.output_format_header}

<observation>
  <type>[ ${mode.observation_types.map(t => t.id).join(' | ')} ]</type>
  <!--
    ${mode.prompts.type_guidance}
  -->
  <title>${mode.prompts.xml_title_placeholder}</title>
  <subtitle>${mode.prompts.xml_subtitle_placeholder}</subtitle>
  <facts>
    <fact>${mode.prompts.xml_fact_placeholder}</fact>
    <fact>${mode.prompts.xml_fact_placeholder}</fact>
    <fact>${mode.prompts.xml_fact_placeholder}</fact>
  </facts>
  <!--
    ${mode.prompts.field_guidance}
  -->
  <narrative>${mode.prompts.xml_narrative_placeholder}</narrative>
  <concepts>
    <concept>${mode.prompts.xml_concept_placeholder}</concept>
    <concept>${mode.prompts.xml_concept_placeholder}</concept>
  </concepts>
  <!--
    ${mode.prompts.concept_guidance}
  -->
  <files_read>
    <file>${mode.prompts.xml_file_placeholder}</file>
    <file>${mode.prompts.xml_file_placeholder}</file>
  </files_read>
  <files_modified>
    <file>${mode.prompts.xml_file_placeholder}</file>
    <file>${mode.prompts.xml_file_placeholder}</file>
  </files_modified>
</observation>
${mode.prompts.format_examples}

${mode.prompts.footer}

${mode.prompts.header_memory_continued}`;
} 
