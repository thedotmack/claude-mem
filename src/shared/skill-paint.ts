import { joinBodyBlocks, splitBodyIntoBlocks, type BodyBlock } from './dario-paint/blocks.js';
import { changeImportance, eraseBlockRange, replaceBlockRange, rewriteBlockExactly } from './dario-paint/edits.js';

export type { BodyBlock } from './dario-paint/blocks.js';
export type RewriteStamp = 'human' | 'einstein';
export type PaintAction =
  | { tool: 'pencil' | RewriteStamp; markdown: string }
  | { tool: 'eraser' | 'more' | 'less' };

/** Keep the original header and byte-order mark out of the paintable body. Claude supports body-only skills. */
export function readPaintDocument(text: string): { prefix: string; blocks: BodyBlock[] } {
  let prefix = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  let body = text.slice(prefix.length);
  const opening = /^---[ \t]*(?:\r?\n|$)/.exec(body);
  if (opening) {
    const remainder = body.slice(opening[0].length);
    const closing = /^---[ \t]*(?:\r?\n|$)/m.exec(remainder);
    if (!closing) throw new Error('Close the front matter in Edit before painting.');
    const headerEnd = opening[0].length + closing.index + closing[0].length;
    prefix += body.slice(0, headerEnd);
    body = body.slice(headerEnd);
  }
  return { prefix, blocks: splitBodyIntoBlocks(body) };
}

export function paintedPassage(blocks: BodyBlock[], firstIndex: number, lastIndex: number): string {
  if (!Number.isInteger(firstIndex) || !Number.isInteger(lastIndex) || firstIndex < 0 ||
      lastIndex < firstIndex || lastIndex >= blocks.length ||
      blocks[firstIndex].kind === 'blank' || blocks[lastIndex].kind === 'blank') {
    throw new RangeError('Select one or more complete Markdown blocks.');
  }
  return joinBodyBlocks(blocks.slice(firstIndex, lastIndex + 1));
}

/** Apply one stroke to the current draft. Replacing text never rewrites the YAML header. */
export function applyPaintEdit(text: string, firstIndex: number, lastIndex: number, action: PaintAction): string {
  const { prefix, blocks } = readPaintDocument(text);
  paintedPassage(blocks, firstIndex, lastIndex);
  let edited: BodyBlock[];
  switch (action.tool) {
    case 'pencil':
      if (firstIndex !== lastIndex) throw new RangeError('Choose a single block for Pencil.');
      edited = rewriteBlockExactly(blocks, firstIndex, action.markdown);
      break;
    case 'human':
    case 'einstein':
      if (!action.markdown.trim()) throw new Error('Claude returned an empty rewrite.');
      edited = replaceBlockRange(blocks, firstIndex, lastIndex, action.markdown);
      break;
    case 'eraser':
      edited = eraseBlockRange(blocks, firstIndex, lastIndex);
      break;
    case 'more':
    case 'less':
      edited = changeImportance(blocks, firstIndex, lastIndex, action.tool);
      break;
  }
  let body = joinBodyBlocks(edited);
  // A moved or rewritten block may now occupy the last position. Keep the file's EOF convention.
  if (!text.endsWith('\n') && action.tool !== 'eraser' && action.tool !== 'pencil') body = body.replace(/\r?\n$/, '');
  return prefix + body;
}
