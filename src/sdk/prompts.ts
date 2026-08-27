
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

function observationSkeleton(mode: ModeConfig): string {
  return `${mode.prompts.output_format_header}

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

${mode.prompts.footer}`;
}

export function buildInitPrompt(project: string, sessionId: string, userPrompt: string, mode: ModeConfig): string {
  return `${mode.prompts.system_identity}

<observed_from_primary_session>
  <user_request>${userPrompt}</user_request>
  <requested_at>${new Date().toISOString().split('T')[0]}</requested_at>
</observed_from_primary_session>

${mode.prompts.observer_role}

${mode.prompts.spatial_awareness}

${mode.prompts.recording_focus}

${mode.prompts.skip_guidance}

${observationSkeleton(mode)}

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

// Image content blocks carry base64 payloads that are worthless to a text
// observer and ruinously expensive to carry. Two things compound (#3730):
// truncateObservationField keeps the head and tail of an oversized field, so
// what survives a screenshot is thousands of characters of base64 rather than
// the caption beside it; and the prompt is appended to
// session.conversationHistory, which every later observation in the session
// re-sends in full. A browser-automation session taking a few hundred
// screenshots replays all of it, every time.
//
// Stripping generically, on the shape of the content block, rather than by
// tool name: CLAUDE_MEM_SKIP_TOOLS needs every screenshot-producing tool
// enumerated ahead of time, and it drops the observation entirely instead of
// keeping the part that has signal.
const MAX_SANITIZE_DEPTH = 12;

function elideImageSource(source: Record<string, unknown>): Record<string, unknown> {
  const data = source.data;
  const elided: Record<string, unknown> = { elided: 'image data withheld from the observer' };
  if (typeof source.media_type === 'string') elided.media_type = source.media_type;
  if (typeof data === 'string') elided.bytes = data.length;
  return elided;
}

function stripImagePayloads(value: unknown, depth = 0): unknown {
  if (depth > MAX_SANITIZE_DEPTH || value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map((entry) => stripImagePayloads(entry, depth + 1));
  }

  const record = value as Record<string, unknown>;

  // Anthropic content block: { type: 'image', source: { data: '<base64>' } }.
  // A url-backed source is the same case as OpenAI's plain http URL — short,
  // and it carries signal — so only an inlined payload is removed.
  const source = record.source;
  if (record.type === 'image' && source !== null && typeof source === 'object') {
    const record_source = source as Record<string, unknown>;
    const url = record_source.url;
    if (typeof url === 'string' && !url.startsWith('data:')) {
      return value;
    }
    return { type: 'image', source: elideImageSource(record_source) };
  }

  // OpenAI content block: { type: 'image_url', image_url: { url: 'data:...' } }.
  const imageUrl = record.image_url;
  if (record.type === 'image_url' && imageUrl !== null && typeof imageUrl === 'object') {
    const url = (imageUrl as Record<string, unknown>).url;
    // A plain http(s) URL is short and can carry signal; only a data: URL is
    // the inlined payload this exists to remove.
    if (typeof url === 'string' && url.startsWith('data:')) {
      return {
        type: 'image_url',
        image_url: { elided: 'image data withheld from the observer', bytes: url.length },
      };
    }
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    out[key] = stripImagePayloads(entry, depth + 1);
  }
  return out;
}

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

export function buildObservationPrompt(obs: Observation): string {
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

  return `<observed_from_primary_session>
  <what_happened>${obs.tool_name}</what_happened>
  <occurred_at>${new Date(obs.created_at_epoch).toISOString()}</occurred_at>${obs.cwd ? `\n  <working_directory>${obs.cwd}</working_directory>` : ''}
  <parameters>${truncateObservationField(stripImagePayloads(toolInput))}</parameters>
  <outcome>${truncateObservationField(stripImagePayloads(toolOutput))}</outcome>
</observed_from_primary_session>

If a <parameters> or <outcome> block above contains an "<elided chars=... />" marker, that field was truncated to fit the observer's context window. Describe only what you can see in the kept portion and do not infer details about the elided range.

Return either one or more <observation>...</observation> blocks, or an empty response if this tool use should be skipped.
Concrete debugging findings from logs, queue state, database rows, session routing, or code-path inspection count as durable discoveries and should be recorded.
Never reply with prose such as "Skipping", "No substantive tool executions", or any explanation outside XML. Non-XML text is discarded.`;
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

export function buildContinuationPrompt(userPrompt: string, promptNumber: number, contentSessionId: string, mode: ModeConfig): string {
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

${observationSkeleton(mode)}

${mode.prompts.header_memory_continued}`;
}
