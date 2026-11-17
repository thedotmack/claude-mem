/**
 * The note the worker writes where it shortened a terminal preview (ContextBuilder.ts truncateTerminalPreview), and
 * the one definition the classic viewer's Settings preview reads it by (utils/settings-preview.ts): the two programs
 * agree on this sentence because both take it from here. It imports nothing, so the worker (root tsconfig) and the
 * viewer (rootDir src/ui) both compile it.
 *
 * The preview is presentation only and must fit the hook's output limit; the model still receives the whole selection.
 */

/** How the worker shortened the preview: older observations left out, or other presentation text cut. */
export const PREVIEW_SHORTENINGS = ['observations', 'text'] as const;
export type PreviewShortening = (typeof PREVIEW_SHORTENINGS)[number];

const LEFT_OUT: Record<PreviewShortening, string> = {
  observations: 'additional observations are not shown here.',
  text: 'some presentation text is not shown here.',
};

/** The note's words, in brackets, as the preview carries them (English: the worker writes the preview in English). */
export function previewTruncationNote(shortening: PreviewShortening): string {
  return `[Terminal preview truncated. The model received the full selected context; ${LEFT_OUT[shortening]}]`;
}
