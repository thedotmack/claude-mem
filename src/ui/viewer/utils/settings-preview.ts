import { PREVIEW_SHORTENINGS, previewTruncationNote, type PreviewShortening } from '../../context-preview-note';

export type { PreviewShortening };

/** ANSI colour and style codes, as the worker's human preview writes them (src/services/context/types.ts `colors`). */
const ANSI_CODES = /\x1b\[[0-9;]*m/g;

/**
 * One observation row of the human preview: two spaces, "#" and its id, two spaces (HumanFormatter.ts
 * renderHumanTableRow and renderHumanFullObservation). Summary rows start "#S" at the margin and never match.
 */
const OBSERVATION_ROW = /^ {2}#\S+ {2}/;

export interface PreviewFacts {
  /** The preview to draw, with the worker's shortening note taken out (ANSI codes kept). */
  body: string;
  /** The same text without ANSI codes: what Copy puts on the clipboard. */
  plainText: string;
  /** Characters the preview shows (code points of plainText). */
  characters: number;
  /** Observation rows the preview shows. */
  observations: number;
  shortened: PreviewShortening | null;
}

/**
 * Where the worker's shortening note sits and how it shortened the preview, found by the note's own words
 * (previewTruncationNote, shared with the worker). The blank lines the worker puts before it and the line break
 * after it go with it. A note in other words (another worker's wording) is not found, so the text keeps it as-is:
 * it is read where it stands, never dropped.
 */
function findShorteningNote(content: string): { start: number; end: number; shortened: PreviewShortening } | null {
  for (const shortened of PREVIEW_SHORTENINGS) {
    const at = content.indexOf(previewTruncationNote(shortened));
    if (at === -1) continue;
    let start = at;
    while (start > 0 && content[start - 1] === '\n') start--;
    let end = at + previewTruncationNote(shortened).length;
    if (content[end] === '\n') end++;
    return { start, end, shortened };
  }
  return null;
}

/** Exact counts of what the context preview returned; nothing is estimated. The dialog moves the note under the text. */
export function previewFacts(content: string): PreviewFacts {
  const note = findShorteningNote(content);
  const body = note ? content.slice(0, note.start) + (note.start > 0 ? '\n' : '') + content.slice(note.end) : content;
  const plainText = body.replace(ANSI_CODES, '');
  const observations = plainText.split('\n').filter(line => OBSERVATION_ROW.test(line)).length;
  return {
    body,
    plainText,
    characters: [...plainText].length,
    observations,
    shortened: note?.shortened ?? null,
  };
}
