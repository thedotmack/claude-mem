/**
 * Condense oversized observation fields instead of cutting them (#3800).
 *
 * A single Read or Bash result can be far larger than one observation prompt is
 * allowed to carry. The existing guard, `truncateObservationField`, keeps a head
 * and a tail and drops the middle — the discarded range is gone, and the
 * observer is told only that *something* was elided. For a memory product that
 * is the wrong trade: the whole point is to end up with a compressed record of
 * what happened, not a record with holes in it.
 *
 * So an oversized field is handed to a small, bounded model pass that rewrites
 * it into something that fits, and the observation is then built and sent with
 * that. Nothing is dropped on the floor; it is summarised.
 *
 * The pass is deliberately hard to turn into a loop, because unbounded retry is
 * the class of bug this whole change exists to remove:
 *  - one attempt per field, never a retry ladder;
 *  - a wall-clock timeout, so a hung compressor cannot stall the observer;
 *  - any failure — throw, timeout, empty, or a reply cut off at the
 *    output-token limit — falls through to the existing truncation, so an
 *    observation is degraded rather than lost;
 *  - a reply that still does not fit once wrapped and JSON-encoded is kept,
 *    not thrown away (its tokens are spent and it carries more of the field
 *    than a raw cut would): its head and tail are kept and the cut is marked
 *    `reason="condense-over-budget"`, sized so the prompt builder never cuts
 *    it a second time (#5450).
 */

import {
  OBS_PROMPT_FIELD_HEAD_RATIO,
  OBS_PROMPT_FIELD_MAX_CHARS,
  OBS_PROMPT_FIELD_TAIL_RATIO,
  stripImagePayloadsFromField,
} from '../../sdk/prompts.js';
import { retainTextHeadTail } from '../../shared/text-truncation.js';
import { CHARS_PER_TOKEN_ESTIMATE } from '../context/types.js';
import { logger } from '../../utils/logger.js';
import { condenseInputMaxTokens, estimateCondenseTokens } from './context-window.js';

/**
 * A compressor's reply. `truncated` is true when the provider reported that
 * the output-token cap cut the reply off (finish_reason 'length', Gemini's
 * 'MAX_TOKENS'): the text is then a fragment, not a summary of the field. A
 * provider that cannot tell reports false.
 */
export interface CompressedField {
  text: string;
  truncated: boolean;
}

/**
 * A single bounded model call: condense `text` to at most `budgetChars`.
 * Returns null when the provider cannot do it. Supplied by each provider so
 * this module stays free of provider wiring and is testable on its own.
 * `deadlineMs` is the deadline `signal` enforces; a provider whose request
 * path has its own per-attempt timeout must use it there too, or its shorter
 * default cuts the pass off first (#4134).
 */
export type FieldCompressor = (
  text: string,
  budgetChars: number,
  signal: AbortSignal,
  deadlineMs: number,
) => Promise<CompressedField | null>;

/**
 * Default deadline for one compression pass before the observer gives up on it
 * and falls back to truncation. Overridable per call via
 * CLAUDE_MEM_FIELD_OPTIMIZE_TIMEOUT_MS — the providers pass
 * resolveFieldOptimizeTimeoutMs (the function, not its result) so the settings
 * file is read only on the rare oversized branch, not every turn. This constant
 * stays the fallback so the module has no settings dependency of its own and
 * remains testable in isolation; a test keeps it equal to the shipped default.
 *
 * The pass is one request to the same backend as the observer request, and the
 * heaviest one: the whole oversized field in, up to FIELD_OPTIMIZE_TARGET_RATIO
 * of the field cap back. At 30s it expired on the cmem.ai gateway's ordinary
 * latency (p90 40–72s by day) and truncated, while the abandoned request could
 * still be billed. So it gets the observer request's deadline
 * (DEFAULT_LLM_TIMEOUT_MS): above the gateway's worst daily p99, below its own
 * 240s timeout.
 */
export const FIELD_OPTIMIZE_TIMEOUT_MS = 180_000;

/**
 * Target size for compressed output, as a fraction of the per-field budget.
 * Leaves headroom so a slightly-over reply still fits rather than being thrown
 * away for missing the cap by a few characters.
 */
const FIELD_OPTIMIZE_TARGET_RATIO = 0.8;

/**
 * Share of the output-token cap the condensed reply may plan for, in
 * CHARS_PER_TOKEN_ESTIMATE characters. Tool payloads are code, JSON and paths,
 * which tokenize denser than prose: a local OpenAI-compatible model cut off at
 * 3 200 tokens had emitted ~8 000 characters, 2.5 per token. Half of the
 * 4-per-token estimate (2 per token) asks only for what the cap can carry.
 */
export const FIELD_OPTIMIZE_OUTPUT_SAFETY = 0.5;

/**
 * The character budget the compression prompt asks for: a share of the field
 * cap, and never more than `maxOutputTokens` can emit. A larger ask is a reply
 * cut off at max_tokens. An unknown cap keeps the field-cap budget.
 */
export function fieldCompressionBudget(maxChars: number, maxOutputTokens?: number): number {
  const budget = Math.floor(maxChars * FIELD_OPTIMIZE_TARGET_RATIO);
  if (!maxOutputTokens) return budget;
  return Math.min(budget, Math.floor(maxOutputTokens * CHARS_PER_TOKEN_ESTIMATE * FIELD_OPTIMIZE_OUTPUT_SAFETY));
}

export function buildFieldCompressionPrompt(text: string, budgetChars: number): string {
  return `Condense the tool payload below to under ${budgetChars} characters.

It is going into an observation record, so preserve everything that carries
signal: file paths, identifiers, commands, counts, error text, status codes, and
any concrete values a later reader would need. Drop repetition, boilerplate and
filler. Keep the original ordering.

Reply with the condensed payload only — no preamble, no commentary, no code
fences.

<payload>
${text}
</payload>`;
}

async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(controller.signal),
      new Promise<null>(resolve => {
        timer = setTimeout(() => { controller.abort(); resolve(null); }, ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Condense one field if it is over budget.
 *
 * Returns the original value untouched when it already fits or when the
 * compression pass does not produce something usable — in which case the
 * caller's existing truncation still applies.
 */
export async function optimizeField(
  value: unknown,
  compress: FieldCompressor,
  context: { sessionDbId: number; field: string; toolName?: string },
  maxChars: number = OBS_PROMPT_FIELD_MAX_CHARS,
  timeoutMs: number | (() => number) = FIELD_OPTIMIZE_TIMEOUT_MS,
  contextWindowTokens?: number,
  maxOutputTokens?: number | (() => number | undefined),
): Promise<unknown> {
  const raw = JSON.stringify(value, null, 2) ?? '';
  if (raw.length <= maxChars) {
    return value;
  }

  const estimatedTokens = estimateCondenseTokens(raw);
  const maxTokens = condenseInputMaxTokens(contextWindowTokens);
  if (estimatedTokens > maxTokens) {
    logger.warn('SDK', 'Oversized field too large to condense; falling back to truncation', {
      sessionId: context.sessionDbId,
      field: context.field,
      toolName: context.toolName,
      originalChars: raw.length,
      estimatedTokens,
      maxTokens,
    });
    return value;
  }

  // Resolve the deadline and the output cap only now that a field is actually
  // over budget — a lazy provider keeps the per-turn common case (everything
  // fits) free of the settings-file reads behind them.
  const budget = fieldCompressionBudget(maxChars,
    typeof maxOutputTokens === 'function' ? maxOutputTokens() : maxOutputTokens);
  const deadlineMs = typeof timeoutMs === 'function' ? timeoutMs() : timeoutMs;
  let condensed: CompressedField | null = null;
  try {
    condensed = await withTimeout(signal => compress(raw, budget, signal, deadlineMs), deadlineMs);
  } catch (error) {
    logger.warn('SDK', 'Oversized field compression failed; falling back to truncation', {
      sessionId: context.sessionDbId,
      field: context.field,
      toolName: context.toolName,
      originalChars: raw.length,
    }, error instanceof Error ? error : new Error(String(error)));
    return value;
  }

  // A reply cut at max_tokens is a fragment however well it fits: accepting it
  // would store half a summary marked as the whole field.
  const trimmed = condensed?.text.trim();
  if (!trimmed || condensed?.truncated) {
    logger.warn('SDK', 'Oversized field compression unusable; falling back to truncation', {
      sessionId: context.sessionDbId,
      field: context.field,
      toolName: context.toolName,
      originalChars: raw.length,
      returnedChars: trimmed?.length ?? 0,
      reason: !trimmed ? 'empty-or-timeout' : 'cut-at-max-tokens',
    });
    return value;
  }
  // Marked as condensed, not elided: the observer should treat this as a
  // faithful summary of the whole field rather than a fragment with a gap.
  // The prompt builder measures the JSON-encoded value (quotes, escaped
  // newlines and attribute quotes), so the fit is checked in that form.
  const whole = wrapCondensed(raw.length, trimmed);
  if (encodedLength(whole) <= maxChars) {
    logger.info('SDK', 'Condensed an oversized observation field to fit', {
      sessionId: context.sessionDbId,
      field: context.field,
      toolName: context.toolName,
      originalChars: raw.length,
      condensedChars: trimmed.length,
    });
    return whole;
  }

  // Still over budget: the reply shortened the field (median ~77% in the
  // wild) but missed the target. Its tokens are already spent and it carries
  // more of the field than a raw truncation would, so keep its head and tail
  // and mark the cut, instead of throwing it away (#5450).
  const clamped = clampCondensed(raw.length, trimmed, maxChars);
  if (clamped === null) {
    logger.warn('SDK', 'Oversized field compression over budget and the cap cannot hold its marks; falling back to truncation', {
      sessionId: context.sessionDbId,
      field: context.field,
      toolName: context.toolName,
      originalChars: raw.length,
      returnedChars: trimmed.length,
      budgetChars: maxChars,
    });
    return value;
  }
  logger.warn('SDK', 'Oversized field compression still over budget; kept the head and tail of the condensed text', {
    sessionId: context.sessionDbId,
    field: context.field,
    toolName: context.toolName,
    originalChars: raw.length,
    returnedChars: trimmed.length,
    budgetChars: maxChars,
  });
  return clamped;
}

/** The size truncateObservationField measures: the value as JSON. */
function encodedLength(text: string): number {
  return JSON.stringify(text).length;
}

function wrapCondensed(originalChars: number, body: string): string {
  return `<condensed original_size_chars="${originalChars}" reason="oversize">\n${body}\n</condensed>`;
}

/**
 * The head and tail of an over-budget condensed reply, with the cut marked,
 * at the longest kept length whose encoded result fits `maxChars`; null when
 * not even one kept character fits beside the wrapper and marker.
 */
function clampCondensed(originalChars: number, text: string, maxChars: number): string | null {
  const build = (keep: number): string => {
    const { head, tail } = retainTextHeadTail(
      text,
      Math.floor(keep * OBS_PROMPT_FIELD_HEAD_RATIO / (OBS_PROMPT_FIELD_HEAD_RATIO + OBS_PROMPT_FIELD_TAIL_RATIO)),
      Math.floor(keep * OBS_PROMPT_FIELD_TAIL_RATIO / (OBS_PROMPT_FIELD_HEAD_RATIO + OBS_PROMPT_FIELD_TAIL_RATIO)),
    );
    const elided = text.length - head.length - tail.length;
    return wrapCondensed(originalChars,
      `${head}\n... <elided chars="${elided}" reason="condense-over-budget" /> ...\n${tail}`);
  };
  // Binary search for the longest kept excerpt whose encoded form fits:
  // log2(maxChars) passes, since escapes make the encoded size non-linear.
  let best: string | null = null;
  let low = 1;
  let high = Math.min(text.length - 1, maxChars);
  while (low <= high) {
    const keep = Math.floor((low + high) / 2);
    const candidate = build(keep);
    if (encodedLength(candidate) <= maxChars) {
      best = candidate;
      low = keep + 1;
    } else {
      high = keep - 1;
    }
  }
  return best;
}

/**
 * Condense whichever of an observation's two payload fields are over budget,
 * so the observation can then be built and sent at full fidelity-per-token.
 */
function compactEditOutput(fields: { toolInput: unknown; toolOutput: unknown }, maxChars: number): unknown {
  try {
    const input: any = typeof fields.toolInput === 'string' ? JSON.parse(fields.toolInput) : fields.toolInput;
    const output: any = typeof fields.toolOutput === 'string' ? JSON.parse(fields.toolOutput) : fields.toolOutput;
    if (!input || !output || Array.isArray(output) || output.userModified !== false
        || typeof input.file_path !== 'string' || !input.file_path
        || typeof input.old_string !== 'string' || !input.old_string || typeof input.new_string !== 'string'
        || output.filePath !== input.file_path || output.oldString !== input.old_string || output.newString !== input.new_string
        || (output.originalFile !== null && typeof output.originalFile !== 'string')
        // Unknown scalar flags (Claude Code's contentNotInModelContext, staleRecovered) cannot carry source and stay
        // in the view as-is; an unknown string, array or object still keeps the normal path (#5023).
        || Object.entries(output).some(([k, v]) => !['filePath', 'oldString', 'newString', 'originalFile', 'structuredPatch', 'userModified', 'replaceAll'].includes(k)
          && v !== null && typeof v !== 'boolean' && typeof v !== 'number')
        || (input.replace_all !== undefined && typeof input.replace_all !== 'boolean')
        || (output.replaceAll !== undefined && output.replaceAll !== (input.replace_all ?? false))
        || !Array.isArray(output.structuredPatch) || !output.structuredPatch.length) return fields.toolOutput;
    const rawLength = JSON.stringify(fields.toolOutput, null, 2).length;
    if (rawLength <= maxChars) return fields.toolOutput;
    for (const h of output.structuredPatch) {
      if (!h || Object.keys(h).some(k => !['oldStart', 'oldLines', 'newStart', 'newLines', 'lines'].includes(k))
          || !['oldStart', 'oldLines', 'newStart', 'newLines'].every(k => Number.isSafeInteger(h[k]) && h[k] >= 0)
          || !Array.isArray(h.lines) || !h.lines.every((line: unknown) => typeof line === 'string' && (/^[ +\-]/.test(line) || line === '\\ No newline at end of file'))
          || h.lines.filter((l: string) => l[0] === ' ' || l[0] === '-').length !== h.oldLines
          || h.lines.filter((l: string) => l[0] === ' ' || l[0] === '+').length !== h.newLines) return fields.toolOutput;
      const before = h.lines.filter((l: string) => l[0] === ' ' || l[0] === '-').map((l: string) => l.slice(1)).join('\n');
      const after = h.lines.filter((l: string) => l[0] === ' ' || l[0] === '+').map((l: string) => l.slice(1)).join('\n');
      const replaced = input.replace_all ? before.split(input.old_string).join(input.new_string)
        : before.replace(input.old_string, () => input.new_string);
      if (!before.includes(input.old_string) || replaced !== after) return fields.toolOutput;
    }
    // Observer-only view: canonical native replacements survive, raw capture is untouched.
    const view = { ...output,
      originalFile: output.originalFile === null ? null : `[omitted ${output.originalFile.length} source characters]`,
      structuredPatch: output.structuredPatch.map(({ lines, ...h }: any) => ({ ...h, omitted_lines: lines.length })),
      observer_note: 'Redundant full-source and patch lines omitted; exact native oldString/newString and hunk locations retained. Raw tool payload unchanged.' };
    // A view still over budget (large oldString/newString) goes on to optimizeField, which condenses or
    // truncates it; that is cheaper than sending the raw payload with the whole file along (#5023).
    return view;
  } catch {
    return fields.toolOutput; // Unknown/non-JSON shapes retain the existing bounded model/fallback path.
  }
}

export async function optimizeObservationFields(
  fields: { toolInput: unknown; toolOutput: unknown },
  compress: FieldCompressor,
  context: { sessionDbId: number; toolName?: string },
  maxChars: number = OBS_PROMPT_FIELD_MAX_CHARS,
  timeoutMs: number | (() => number) = FIELD_OPTIMIZE_TIMEOUT_MS,
  contextWindowTokens?: number,
  maxOutputTokens?: number | (() => number | undefined),
): Promise<{ toolInput: unknown; toolOutput: unknown }> {
  // Inlined image payloads come out before anything measures or compresses the
  // field. `buildObservationPrompt` strips too, but it runs after this: a
  // screenshot still in place here is a screenshot sent to the compressor
  // model, and that is the most expensive call the observer can make — #3606
  // measured 225k-501k input tokens per condense of a video frame read off
  // disk. Stripping first also makes the oversize check honest, since it then
  // measures what the prompt will actually carry.
  const stripped = {
    toolInput: stripImagePayloadsFromField(fields.toolInput),
    toolOutput: stripImagePayloadsFromField(fields.toolOutput),
  };

  const [toolInput, toolOutput] = await Promise.all([
    optimizeField(stripped.toolInput, compress, { ...context, field: 'parameters' }, maxChars, timeoutMs,
      contextWindowTokens, maxOutputTokens),
    optimizeField(context.toolName === 'Edit' ? compactEditOutput(stripped, maxChars) : stripped.toolOutput,
      compress, { ...context, field: 'outcome' }, maxChars, timeoutMs, contextWindowTokens, maxOutputTokens),
  ]);
  return { toolInput, toolOutput };
}
