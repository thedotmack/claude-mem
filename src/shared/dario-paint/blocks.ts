// Adapted from Dario Paint, copyright 2026 Alex Newman. See the MIT license in NOTICE.
// The body is cut into blocks you can paint over: one heading, one paragraph, one list item,
// one code fence, one table, one quote, or a run of blank lines. Blank runs are blocks too,
// so joining the blocks gives back the exact body.

export type BodyBlockKind = "blank" | "heading" | "paragraph" | "list-item" | "code" | "table" | "quote" | "rule";
export type BodyBlock = { kind: BodyBlockKind; markdown: string };

const headingLinePattern = /^ {0,3}(#{1,6})(?=[ \t]|\r?\n|$)/;
const fenceOpeningPattern = /^ {0,3}(`{3,}|~{3,})/;
const thematicBreakPattern = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*\r?\n?$/;
const listItemStartPattern = /^( {0,3})([-*+]|\d{1,9}[.)])(?=[ \t]|\r?\n|$)/;
const orderedListNumberPattern = /^( {0,3})(\d{1,9})([.)])/;
const tableLinePattern = /^ {0,3}\|/;
const quoteLinePattern = /^ {0,3}>/;
const setextUnderlinePattern = /^ {0,3}(=+|-+)[ \t]*\r?\n?$/;

function isBlankLine(line: string): boolean {
  return line.trim() === "";
}

function leadingSpaceCount(line: string): number {
  return line.length - line.trimStart().length;
}

function startsAnotherBlock(line: string): boolean {
  return (
    headingLinePattern.test(line) ||
    fenceOpeningPattern.test(line) ||
    thematicBreakPattern.test(line) ||
    listItemStartPattern.test(line) ||
    tableLinePattern.test(line) ||
    quoteLinePattern.test(line)
  );
}

function closesFence(line: string, openingFence: string): boolean {
  const trimmedLine = line.trim();
  return trimmedLine.length >= openingFence.length && trimmedLine === openingFence[0].repeat(trimmedLine.length);
}

function fenceEndExclusive(lines: string[], openingLineIndex: number, openingFence: string): number {
  for (let lineIndex = openingLineIndex + 1; lineIndex < lines.length; lineIndex++) {
    if (closesFence(lines[lineIndex], openingFence)) return lineIndex + 1;
  }
  return lines.length;
}

function paragraphEndExclusive(lines: string[], firstLineIndex: number): number {
  let lineIndex = firstLineIndex + 1;
  while (lineIndex < lines.length && !isBlankLine(lines[lineIndex])) {
    if (setextUnderlinePattern.test(lines[lineIndex])) return lineIndex + 1;
    if (startsAnotherBlock(lines[lineIndex])) return lineIndex;
    lineIndex++;
  }
  return lineIndex;
}

// A list item owns everything indented deeper than its marker (nested lists, indented fences,
// continuation paragraphs after a blank line) plus unindented "lazy" continuation lines.
function listItemEndExclusive(lines: string[], firstLineIndex: number, itemIndent: number): number {
  let openFenceInsideItem: string | null = null;
  let lineIndex = firstLineIndex + 1;
  while (lineIndex < lines.length) {
    const line = lines[lineIndex];
    if (openFenceInsideItem) {
      if (closesFence(line, openFenceInsideItem)) openFenceInsideItem = null;
      lineIndex++;
      continue;
    }
    if (isBlankLine(line)) {
      let nextContentLineIndex = lineIndex;
      while (nextContentLineIndex < lines.length && isBlankLine(lines[nextContentLineIndex])) nextContentLineIndex++;
      const itemContinuesAfterBlankLines =
        nextContentLineIndex < lines.length && leadingSpaceCount(lines[nextContentLineIndex]) > itemIndent;
      if (!itemContinuesAfterBlankLines) return lineIndex;
      lineIndex = nextContentLineIndex;
      continue;
    }
    if (leadingSpaceCount(line) > itemIndent) {
      const indentedFence = /^\s*(`{3,}|~{3,})/.exec(line);
      if (indentedFence) openFenceInsideItem = indentedFence[1];
      lineIndex++;
      continue;
    }
    if (startsAnotherBlock(line)) return lineIndex;
    lineIndex++;
  }
  return lineIndex;
}

function runEndExclusive(lines: string[], firstLineIndex: number, belongsToRun: (line: string) => boolean): number {
  let lineIndex = firstLineIndex + 1;
  while (lineIndex < lines.length && belongsToRun(lines[lineIndex])) lineIndex++;
  return lineIndex;
}

export function splitBodyIntoBlocks(body: string): BodyBlock[] {
  const lines = body.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const blocks: BodyBlock[] = [];
  let lineIndex = 0;
  const takeBlock = (kind: BodyBlockKind, endExclusive: number) => {
    blocks.push({ kind, markdown: lines.slice(lineIndex, endExclusive).join("") });
    lineIndex = endExclusive;
  };

  while (lineIndex < lines.length) {
    const line = lines[lineIndex];
    if (isBlankLine(line)) {
      takeBlock("blank", runEndExclusive(lines, lineIndex, isBlankLine));
      continue;
    }
    const fenceOpening = fenceOpeningPattern.exec(line);
    if (fenceOpening) {
      takeBlock("code", fenceEndExclusive(lines, lineIndex, fenceOpening[1]));
      continue;
    }
    if (headingLinePattern.test(line)) {
      takeBlock("heading", lineIndex + 1);
      continue;
    }
    if (thematicBreakPattern.test(line)) {
      takeBlock("rule", lineIndex + 1);
      continue;
    }
    const listItemStart = listItemStartPattern.exec(line);
    if (listItemStart) {
      takeBlock("list-item", listItemEndExclusive(lines, lineIndex, listItemStart[1].length));
      continue;
    }
    if (tableLinePattern.test(line)) {
      takeBlock("table", runEndExclusive(lines, lineIndex, (nextLine) => tableLinePattern.test(nextLine)));
      continue;
    }
    if (quoteLinePattern.test(line)) {
      takeBlock("quote", runEndExclusive(lines, lineIndex, (nextLine) => quoteLinePattern.test(nextLine)));
      continue;
    }
    takeBlock("paragraph", paragraphEndExclusive(lines, lineIndex));
  }
  return blocks;
}

export function joinBodyBlocks(blocks: BodyBlock[]): string {
  return blocks.map((block) => block.markdown).join("");
}

/** A fence that never closes runs to the end of the file and swallows anything placed after it. */
export function isUnclosedCodeFence(block: BodyBlock): boolean {
  if (block.kind !== "code") return false;
  const lines = block.markdown.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const openingFence = fenceOpeningPattern.exec(lines[0] ?? "")?.[1];
  if (!openingFence) throw new Error(`Code block doesn't start with a fence: ${lines[0]}`);
  return lines.length < 2 || !closesFence(lines.at(-1)!, openingFence);
}

export function headingLevelOf(block: BodyBlock): number {
  const headingMatch = headingLinePattern.exec(block.markdown);
  if (!headingMatch) throw new Error(`Not a heading block: ${block.markdown.slice(0, 40)}`);
  return headingMatch[1].length;
}

export function withHeadingLevel(block: BodyBlock, headingLevel: number): BodyBlock {
  return { kind: "heading", markdown: block.markdown.replace(/^( {0,3})#{1,6}/, `$1${"#".repeat(headingLevel)}`) };
}

export function listMarkerOf(block: BodyBlock): { indent: number; isOrdered: boolean; orderedNumber: number | null } {
  const listItemStart = listItemStartPattern.exec(block.markdown);
  if (!listItemStart) throw new Error(`Not a list item block: ${block.markdown.slice(0, 40)}`);
  const orderedNumberMatch = orderedListNumberPattern.exec(block.markdown);
  return {
    indent: listItemStart[1].length,
    isOrdered: orderedNumberMatch !== null,
    orderedNumber: orderedNumberMatch ? Number(orderedNumberMatch[2]) : null,
  };
}

export function withOrderedNumber(block: BodyBlock, orderedNumber: number): BodyBlock {
  return { kind: "list-item", markdown: block.markdown.replace(orderedListNumberPattern, `$1${orderedNumber}$3`) };
}
