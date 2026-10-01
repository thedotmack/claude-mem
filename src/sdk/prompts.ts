
import { logger } from '../utils/logger.js';
import { REDACTION_MARKER_HINT, hasRedactionMarker } from '../utils/redaction.js';
import type { ModeConfig } from '../services/domain/types.js';
import type { RequiredPromptKey } from '../services/domain/mode-validation.js';

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

function getPrompt(mode: ModeConfig, key: RequiredPromptKey): string {
  const prompt = mode.prompts?.[key];
  const allowEmpty = key === 'format_examples' || key === 'xml_file_placeholder';
  if (typeof prompt !== 'string' || (!allowEmpty && !prompt.trim())) {
    throw new Error(`Mode "${mode.id ?? mode.name}" is missing prompt "${key}"`);
  }
  return prompt;
}

function observationSkeleton(mode: ModeConfig): string {
  return `${getPrompt(mode, 'output_format_header')}

<observation>
  <type>[ ${mode.observation_types.map(t => t.id).join(' | ')} ]</type>
  <!--
    ${getPrompt(mode, 'type_guidance')}
  -->
  <title>${getPrompt(mode, 'xml_title_placeholder')}</title>
  <subtitle>${getPrompt(mode, 'xml_subtitle_placeholder')}</subtitle>
  <facts>
    <fact>${getPrompt(mode, 'xml_fact_placeholder')}</fact>
    <fact>${getPrompt(mode, 'xml_fact_placeholder')}</fact>
    <fact>${getPrompt(mode, 'xml_fact_placeholder')}</fact>
  </facts>
  <!--
    ${getPrompt(mode, 'field_guidance')}
  -->
  <narrative>${getPrompt(mode, 'xml_narrative_placeholder')}</narrative>
  <concepts>
    <concept>${getPrompt(mode, 'xml_concept_placeholder')}</concept>
    <concept>${getPrompt(mode, 'xml_concept_placeholder')}</concept>
  </concepts>
  <!--
    ${getPrompt(mode, 'concept_guidance')}
  -->
  <files_read>
    <file>${getPrompt(mode, 'xml_file_placeholder')}</file>
    <file>${getPrompt(mode, 'xml_file_placeholder')}</file>
  </files_read>
  <files_modified>
    <file>${getPrompt(mode, 'xml_file_placeholder')}</file>
    <file>${getPrompt(mode, 'xml_file_placeholder')}</file>
  </files_modified>
</observation>
${getPrompt(mode, 'format_examples')}

${getPrompt(mode, 'footer')}`;
}

export function buildInitPrompt(
  project: string,
  sessionId: string,
  userPrompt: string,
  mode: ModeConfig,
  priorContext: string = '',
): string {
  return `${getPrompt(mode, 'system_identity')}
${wrapPriorContext(priorContext)}

<observed_from_primary_session>
  <user_request>${userPrompt}</user_request>
  <requested_at>${new Date().toISOString().split('T')[0]}</requested_at>
</observed_from_primary_session>

${getPrompt(mode, 'observer_role')}

${getPrompt(mode, 'spatial_awareness')}

${getPrompt(mode, 'recording_focus')}

${getPrompt(mode, 'skip_guidance')}

${observationSkeleton(mode)}

${getPrompt(mode, 'header_memory_start')}`;
}

/**
 * Wrap the session-start context block for a generation that begins partway
 * through a session (#3800).
 *
 * The text comes from `generateContext` — the same builder the SessionStart
 * hook uses to tell a brand-new Claude Code session what happened before it.
 * An observer generation that starts after a recycle is in exactly that
 * position, so it gets exactly that context rather than a second, parallel
 * rendering of the same rows.
 *
 * Returns '' when there is nothing yet, so a first generation is unchanged.
 */
export function wrapPriorContext(priorContext: string): string {
  const trimmed = priorContext.trim();
  if (!trimmed) {
    return '';
  }

  return `
<session_start_context>
${trimmed}
</session_start_context>

The context above is what you have already recorded for this work. Continue from
there: do not re-record it, and do not treat its absence from the conversation
above as meaning the work did not happen.`;
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
export const OBS_PROMPT_FIELD_MAX_CHARS = 16_000;
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

// URI schemes are case-insensitive. A `DATA:image/png;base64,…` source is the
// same inlined payload as `data:` — Greptile reproduced the bypass on #3762.
function isDataUrl(url: string): boolean {
  return url.slice(0, 5).toLowerCase() === 'data:';
}

// A field is stripped twice — once before the condense pass, once when the
// prompt is built — so a block that has already been elided has to survive the
// second pass as it is, rather than losing the byte count it recorded.
function isElided(container: Record<string, unknown>): boolean {
  return typeof container.elided === 'string';
}

function elideImageSource(source: Record<string, unknown>, dataKey: string = 'data'): Record<string, unknown> {
  const data = source[dataKey];
  const elided: Record<string, unknown> = { elided: 'image data withheld from the observer' };
  if (typeof source.media_type === 'string') elided.media_type = source.media_type;
  if (typeof data === 'string') elided.bytes = data.length;
  return elided;
}

function stripImagePayloads(value: unknown, depth = 0): unknown {
  if (depth > MAX_SANITIZE_DEPTH || value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    let changed = false;
    const mapped = value.map((entry) => {
      const next = stripImagePayloads(entry, depth + 1);
      if (next !== entry) changed = true;
      return next;
    });
    return changed ? mapped : value;
  }

  const record = value as Record<string, unknown>;

  // Anthropic content block: { type: 'image', source: { data: '<base64>' } }.
  // A url-backed source is the same case as OpenAI's plain http URL — short,
  // and it carries signal — so only an inlined payload is removed.
  const source = record.source;
  if (record.type === 'image' && source !== null && typeof source === 'object') {
    const record_source = source as Record<string, unknown>;
    if (isElided(record_source)) return value;
    const url = record_source.url;
    if (typeof url === 'string' && !isDataUrl(url)) {
      return value;
    }
    return { type: 'image', source: elideImageSource(record_source) };
  }

  // Claude Code's Read returns an image file as
  // { type: 'image', file: { base64: '<base64>' } } — no `source`, so the
  // block above never matched it and a video frame or screenshot read off
  // disk went to the model whole (#3606).
  const file = record.file;
  if (record.type === 'image' && file !== null && typeof file === 'object') {
    const record_file = file as Record<string, unknown>;
    if (isElided(record_file)) return value;
    if (typeof record_file.base64 === 'string') {
      return { type: 'image', file: elideImageSource(record_file, 'base64') };
    }
  }

  // OpenAI content block: { type: 'image_url', image_url: { url: 'data:...' } }.
  const imageUrl = record.image_url;
  if (record.type === 'image_url' && imageUrl !== null && typeof imageUrl === 'object') {
    if (isElided(imageUrl as Record<string, unknown>)) return value;
    const url = (imageUrl as Record<string, unknown>).url;
    // A plain http(s) URL is short and can carry signal; only a data: URL is
    // the inlined payload this exists to remove.
    if (typeof url === 'string' && isDataUrl(url)) {
      return {
        type: 'image_url',
        image_url: { elided: 'image data withheld from the observer', bytes: url.length },
      };
    }
    return value;
  }

  // Identity is the signal that nothing was stripped, so it is preserved all
  // the way up: callers rely on an untouched payload staying the very object
  // they passed in, and `stripImagePayloadsFromField` uses it to decide
  // whether a field needs re-encoding at all.
  const out: Record<string, unknown> = {};
  let changed = false;
  for (const [key, entry] of Object.entries(record)) {
    const next = stripImagePayloads(entry, depth + 1);
    if (next !== entry) changed = true;
    out[key] = next;
  }
  return changed ? out : value;
}

/**
 * Strip the image payloads out of one observation field.
 *
 * The stripper matches on the *shape* of a content block, so it has to be
 * handed parsed JSON. A field does not arrive that way: the ingest boundary
 * stores a tool payload as JSON text (`http/shared.ts` JSON.stringify()s it),
 * so what reaches the worker is a string. Passing that string straight to
 * `stripImagePayloads` returns it unchanged — which is why the sanitizer never
 * fired on a real observation, only in tests that build the field themselves.
 *
 * Text that is not JSON is returned as-is; it has no content blocks to find.
 */
export function stripImagePayloadsFromField(value: unknown): unknown {
  if (typeof value !== 'string') return stripImagePayloads(value);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return value;
  }
  const stripped = stripImagePayloads(parsed);
  // No image in it: hand back the original text, so every field that did not
  // need this is encoded exactly as it was before.
  return stripped === parsed ? value : stripped;
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

/**
 * `fieldMaxChars` caps each of <parameters> and <outcome>; callers pass the
 * observer model's window-aware cap (observationFieldMaxChars).
 */
export function buildObservationPrompt(
  obs: Observation,
  fieldMaxChars: number = OBS_PROMPT_FIELD_MAX_CHARS,
  /** The previous reply drifted off the schema (#3461): restate it once. */
  restateSchema: boolean = false,
): string {
  return renderObservationPrompt(buildObservationPromptParts(obs, fieldMaxChars, restateSchema));
}

/**
 * An observation prompt before rendering, with the tool payload kept apart
 * from the wrapper, so a provider can bound the payload without cutting into
 * tag text a tool's own output may contain (Codex batching).
 */
export interface ObservationPromptParts {
  header: string;
  parameters: string;
  outcome: string;
  restateSchema: boolean;
}

export function buildObservationPromptParts(
  obs: Observation,
  fieldMaxChars: number = OBS_PROMPT_FIELD_MAX_CHARS,
  restateSchema: boolean = false,
): ObservationPromptParts {
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

  return {
    header: `<observed_from_primary_session>
  <what_happened>${obs.tool_name}</what_happened>
  <occurred_at>${new Date(obs.created_at_epoch).toISOString()}</occurred_at>${obs.cwd ? `\n  <working_directory>${obs.cwd}</working_directory>` : ''}`,
    parameters: truncateObservationField(stripImagePayloadsFromField(toolInput), fieldMaxChars),
    outcome: truncateObservationField(stripImagePayloadsFromField(toolOutput), fieldMaxChars),
    restateSchema,
  };
}

export function renderObservationPrompt(parts: ObservationPromptParts): string {
  const { parameters, outcome, restateSchema } = parts;
  const redactionHint = hasRedactionMarker(parameters + outcome) ? `\n${REDACTION_MARKER_HINT}\n` : '';

  return `${parts.header}
  <parameters>${parameters}</parameters>
  <outcome>${outcome}</outcome>
</observed_from_primary_session>

If a <parameters> or <outcome> block above contains an "<elided chars=... />" marker, that field was truncated to fit the observer's context window. Describe only what you can see in the kept portion and do not infer details about the elided range.
${redactionHint}
Return either one or more <observation>...</observation> blocks, or <skip_summary reason="noise" /> if this tool use should be skipped.
Concrete debugging findings from logs, queue state, database rows, session routing, or code-path inspection count as durable discoveries and should be recorded.
Never reply with an empty response, or with prose such as "Skipping", "No substantive tool executions", or any explanation outside XML. Only <observation> blocks or the <skip_summary /> sentinel complete this tool use; anything else is asked again once, then discarded.${restateSchema ? `\n${OBSERVATION_SCHEMA_REMINDER}` : ''}`;
}

/** Restated once after a reply that used tags outside the observation schema (#3461). */
export const OBSERVATION_SCHEMA_REMINDER =
  'Your previous reply used tags outside the observation format. Use only <type>, <title>, <subtitle>, <facts>, <narrative>, <concepts>, <files_read> and <files_modified> inside each <observation>.';

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

${getPrompt(mode, 'header_summary_checkpoint')}
${getPrompt(mode, 'summary_instruction')}

${getPrompt(mode, 'summary_context_label')}
${lastAssistantMessage}
${hasRedactionMarker(lastAssistantMessage) ? `\n${REDACTION_MARKER_HINT}\n` : ''}
${getPrompt(mode, 'summary_format_instruction')}
<summary>
  <request>${getPrompt(mode, 'xml_summary_request_placeholder')}</request>
  <investigated>${getPrompt(mode, 'xml_summary_investigated_placeholder')}</investigated>
  <learned>${getPrompt(mode, 'xml_summary_learned_placeholder')}</learned>
  <completed>${getPrompt(mode, 'xml_summary_completed_placeholder')}</completed>
  <next_steps>${getPrompt(mode, 'xml_summary_next_steps_placeholder')}</next_steps>
  <notes>${getPrompt(mode, 'xml_summary_notes_placeholder')}</notes>
</summary>

REMINDER: Your response MUST use <summary> as the root tag, NOT <observation>.
If there is genuinely nothing to summarize, reply with exactly <skip_summary reason="nothing durable" /> instead of an empty response or prose.
${getPrompt(mode, 'summary_footer')}`;
}

export function buildContinuationPrompt(
  userPrompt: string,
  promptNumber: number,
  contentSessionId: string,
  mode: ModeConfig,
  priorContext: string = '',
): string {
  return `${getPrompt(mode, 'continuation_greeting')}
${wrapPriorContext(priorContext)}

<observed_from_primary_session>
  <user_request>${userPrompt}</user_request>
  <requested_at>${new Date().toISOString().split('T')[0]}</requested_at>
</observed_from_primary_session>

${getPrompt(mode, 'system_identity')}

${getPrompt(mode, 'observer_role')}

${getPrompt(mode, 'spatial_awareness')}

${getPrompt(mode, 'recording_focus')}

${getPrompt(mode, 'skip_guidance')}

${getPrompt(mode, 'continuation_instruction')}

${observationSkeleton(mode)}

${getPrompt(mode, 'header_memory_continued')}`;
}

/** The user-request block buildInitPrompt and buildContinuationPrompt embed. */
const USER_REQUEST_BLOCK = /<observed_from_primary_session>\s*<user_request>[\s\S]*?<\/observed_from_primary_session>/;

/**
 * Split an init or continuation prompt into the observer's instructions and
 * the user's request (#3868). HTTP providers send the instructions as the
 * system message and the request as the first user turn: a small model keeps
 * the output schema in view that way, where the same text sent as one user
 * turn drifts out of its attention as the conversation grows. `userRequest`
 * is null when the prompt carries no request block.
 */
export function splitFramingPrompt(prompt: string): { instructions: string; userRequest: string | null } {
  const match = prompt.match(USER_REQUEST_BLOCK);
  if (!match) {
    return { instructions: prompt, userRequest: null };
  }
  return {
    instructions: prompt.replace(match[0], '').replace(/\n{3,}/g, '\n\n').trim(),
    userRequest: match[0],
  };
}
