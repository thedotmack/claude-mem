/** A Gemini response part. Gemini 3 marks a reasoning part with `thought: true`. */
export interface GeminiPart {
  text?: string;
  thought?: boolean;
}

/**
 * The answer's text — not the reasoning that came before it.
 *
 * A response arrives as an ordered list of parts, and when thinking output is
 * included the chain of thought is `parts[0]`, so reading the first part
 * returns the model's private deliberation instead of its answer. Confirmed
 * against the live endpoint: with `thinkingConfig.includeThoughts` a two-part
 * response came back, reasoning first and answer second. An answer can also be
 * split across parts, so the answer parts are joined rather than picked.
 *
 * A response whose every part is reasoning has no answer at all; returning ''
 * lets the caller report the empty response it is, instead of storing
 * deliberation as an observation.
 *
 * Shared by the worker's GeminiProvider and the server runtime's
 * GeminiObservationProvider, which may not import from each other.
 */
export function readGeminiAnswerText(parts: GeminiPart[] | undefined): string {
  if (!parts?.length) return '';
  return parts
    .filter((part): part is GeminiPart & { text: string } =>
      part.thought !== true && typeof part.text === 'string')
    .map(part => part.text)
    .join('');
}
