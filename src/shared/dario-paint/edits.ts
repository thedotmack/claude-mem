// Adapted from Dario Paint, copyright 2026 Alex Newman. See the MIT license in NOTICE.
// What each stamp does to the body, as plain functions over blocks.
// Every edit ends in normalizeBlocks, so the result is always a clean, re-parsed body.

import {
  type BodyBlock,
  headingLevelOf,
  isUnclosedCodeFence,
  joinBodyBlocks,
  listMarkerOf,
  splitBodyIntoBlocks,
  withHeadingLevel,
  withOrderedNumber,
} from "./blocks.js";

function lineEnding(text: string, fallback = "\n"): string {
  return text.match(/\r?\n/)?.[0] ?? fallback;
}

const blankLineBlock = (previous: BodyBlock): BodyBlock => ({ kind: "blank", markdown: lineEnding(previous.markdown) });

function ensureTrailingNewline(markdown: string, eol = lineEnding(markdown)): string {
  return markdown.endsWith("\n") ? markdown : markdown + eol;
}

// Re-parse after an edit: give every block but the last a line ending, keep at most one blank
// block between neighbours, and let the splitter decide the block boundaries again.
export function normalizeBlocks(blocks: BodyBlock[]): BodyBlock[] {
  const cleanedBlocks: BodyBlock[] = [];
  blocks.forEach((block, blockIndex) => {
    const isLastBlock = blockIndex === blocks.length - 1;
    if (block.kind === "blank" && cleanedBlocks.at(-1)?.kind === "blank") return;
    cleanedBlocks.push(isLastBlock ? block : { ...block, markdown: ensureTrailingNewline(block.markdown, lineEnding(block.markdown, lineEnding(blocks[blockIndex + 1]?.markdown ?? ""))) });
  });
  return splitBodyIntoBlocks(joinBodyBlocks(cleanedBlocks));
}

// Markdown glues a paragraph onto whatever text directly follows it, so blocks that end up
// touching after an edit get a blank line between them. Items of one list may touch.
function needsBlankLineBetween(upperBlock: BodyBlock | undefined, lowerBlock: BodyBlock | undefined): boolean {
  if (!upperBlock || !lowerBlock) return false;
  if (upperBlock.kind === "blank" || lowerBlock.kind === "blank") return false;
  return !(upperBlock.kind === "list-item" && lowerBlock.kind === "list-item");
}

function joinKeepingBlocksApart(...blockGroups: BodyBlock[][]): BodyBlock[] {
  return blockGroups.reduce<BodyBlock[]>(
    (joinedBlocks, blockGroup) =>
      needsBlankLineBetween(joinedBlocks.at(-1), blockGroup[0])
        ? [...joinedBlocks, blankLineBlock(joinedBlocks[joinedBlocks.length - 1]), ...blockGroup]
        : [...joinedBlocks, ...blockGroup],
    [],
  );
}

export function eraseBlockRange(blocks: BodyBlock[], firstBlockIndex: number, lastBlockIndex: number): BodyBlock[] {
  return normalizeBlocks(joinKeepingBlocksApart(blocks.slice(0, firstBlockIndex), blocks.slice(lastBlockIndex + 1)));
}

/** Human and Einstein stamps: the painted blocks become whatever markdown came back. */
export function replaceBlockRange(
  blocks: BodyBlock[],
  firstBlockIndex: number,
  lastBlockIndex: number,
  replacementMarkdown: string,
): BodyBlock[] {
  const eol = lineEnding(blocks[firstBlockIndex].markdown, lineEnding(joinBodyBlocks(blocks)));
  const replacement = replacementMarkdown.trim().replace(/\r?\n/g, eol);
  const replacementBlocks = splitBodyIntoBlocks(ensureTrailingNewline(replacement, eol));
  return normalizeBlocks(
    joinKeepingBlocksApart(blocks.slice(0, firstBlockIndex), replacementBlocks, blocks.slice(lastBlockIndex + 1)),
  );
}

/** Pencil: the author typed this block's markdown by hand, so it goes back exactly as typed. */
export function rewriteBlockExactly(blocks: BodyBlock[], blockIndex: number, typedMarkdown: string): BodyBlock[] {
  if (typedMarkdown.trim() === "") return eraseBlockRange(blocks, blockIndex, blockIndex);
  const original = blocks[blockIndex].markdown;
  const eol = lineEnding(original, lineEnding(joinBodyBlocks(blocks)));
  const typed = typedMarkdown.replace(/\r?\n/g, eol);
  const typedBlocks = splitBodyIntoBlocks(original.endsWith("\n") ? ensureTrailingNewline(typed, eol) : typed);
  return normalizeBlocks([...blocks.slice(0, blockIndex), ...typedBlocks, ...blocks.slice(blockIndex + 1)]);
}

// Smile and frown move importance. Headings change size (### -> ## -> #); everything else
// changes place: to the top or bottom of its list, or of the section it sits in.

export type ImportanceDirection = "more" | "less";

function isSiblingListItem(candidate: BodyBlock | undefined, listItem: BodyBlock): boolean {
  if (candidate?.kind !== "list-item") return false;
  const candidateMarker = listMarkerOf(candidate);
  const listItemMarker = listMarkerOf(listItem);
  return candidateMarker.indent === listItemMarker.indent && candidateMarker.isOrdered === listItemMarker.isOrdered;
}

function listBoundsAround(blocks: BodyBlock[], listItemIndex: number): { firstIndex: number; endExclusive: number } {
  const listItem = blocks[listItemIndex];
  let firstIndex = listItemIndex;
  while (true) {
    if (isSiblingListItem(blocks[firstIndex - 1], listItem)) firstIndex -= 1;
    else if (blocks[firstIndex - 1]?.kind === "blank" && isSiblingListItem(blocks[firstIndex - 2], listItem)) firstIndex -= 2;
    else break;
  }
  let lastIndex = listItemIndex;
  while (true) {
    if (isSiblingListItem(blocks[lastIndex + 1], listItem)) lastIndex += 1;
    else if (blocks[lastIndex + 1]?.kind === "blank" && isSiblingListItem(blocks[lastIndex + 2], listItem)) lastIndex += 2;
    else break;
  }
  return { firstIndex, endExclusive: lastIndex + 1 };
}

function moveListItemToEdge(blocks: BodyBlock[], listItem: BodyBlock, direction: ImportanceDirection): BodyBlock[] {
  const { firstIndex, endExclusive } = listBoundsAround(blocks, blocks.indexOf(listItem));
  const listBlocks = blocks.slice(firstIndex, endExclusive);
  const isLooseList = listBlocks.some((block) => block.kind === "blank");
  const otherItems = listBlocks.filter((block) => block.kind === "list-item" && block !== listItem);
  const reorderedItems = direction === "more" ? [listItem, ...otherItems] : [...otherItems, listItem];
  const rebuiltList = reorderedItems.flatMap((item, itemPosition) =>
    isLooseList && itemPosition > 0 ? [blankLineBlock(reorderedItems[itemPosition - 1]), item] : [item],
  );
  return [...blocks.slice(0, firstIndex), ...rebuiltList, ...blocks.slice(endExclusive)];
}

// Renumbering waits until every move is done, because it swaps in new block objects and the
// moves find painted blocks by reference.
function renumberOrderedLists(blocks: BodyBlock[], itemsWhoseListsMoved: BodyBlock[]): BodyBlock[] {
  const listEndByFirstIndex = new Map<number, number>();
  for (const item of itemsWhoseListsMoved) {
    const { firstIndex, endExclusive } = listBoundsAround(blocks, blocks.indexOf(item));
    listEndByFirstIndex.set(firstIndex, endExclusive);
  }
  const renumberedBlocks = [...blocks];
  for (const [firstIndex, endExclusive] of listEndByFirstIndex) {
    const itemIndexes: number[] = [];
    for (let blockIndex = firstIndex; blockIndex < endExclusive; blockIndex++) {
      if (renumberedBlocks[blockIndex].kind === "list-item") itemIndexes.push(blockIndex);
    }
    const startNumber = Math.min(...itemIndexes.map((blockIndex) => listMarkerOf(renumberedBlocks[blockIndex]).orderedNumber!));
    itemIndexes.forEach((blockIndex, itemPosition) => {
      renumberedBlocks[blockIndex] = withOrderedNumber(renumberedBlocks[blockIndex], startNumber + itemPosition);
    });
  }
  return renumberedBlocks;
}

function moveBlockToSectionEdge(blocks: BodyBlock[], block: BodyBlock, direction: ImportanceDirection): BodyBlock[] {
  const blockIndex = blocks.indexOf(block);
  let sectionFirstIndex = blockIndex;
  while (sectionFirstIndex > 0 && blocks[sectionFirstIndex - 1].kind !== "heading") sectionFirstIndex--;
  let sectionEndExclusive = blockIndex + 1;
  while (sectionEndExclusive < blocks.length && blocks[sectionEndExclusive].kind !== "heading") sectionEndExclusive++;

  // Blank lines hugging the section's heading stay on top; blank lines before the next heading stay at the bottom.
  const sectionBlocks = joinKeepingBlocksApart(blocks.slice(sectionFirstIndex, blockIndex), blocks.slice(blockIndex + 1, sectionEndExclusive));
  let contentStart = 0;
  while (contentStart < sectionBlocks.length && sectionBlocks[contentStart].kind === "blank") contentStart++;
  let contentEnd = sectionBlocks.length;
  while (contentEnd > contentStart && sectionBlocks[contentEnd - 1].kind === "blank") contentEnd--;
  if (contentEnd > contentStart && isUnclosedCodeFence(sectionBlocks[contentEnd - 1])) {
    contentEnd--;
    while (contentEnd > contentStart && sectionBlocks[contentEnd - 1].kind === "blank") contentEnd--;
  }
  const insertIndex = direction === "more" ? contentStart : contentEnd;

  return joinKeepingBlocksApart(
    blocks.slice(0, sectionFirstIndex),
    joinKeepingBlocksApart(sectionBlocks.slice(0, insertIndex), [block], sectionBlocks.slice(insertIndex)),
    blocks.slice(sectionEndExclusive),
  );
}

export function changeImportance(
  blocks: BodyBlock[],
  firstBlockIndex: number,
  lastBlockIndex: number,
  direction: ImportanceDirection,
): BodyBlock[] {
  const paintedBlocks = blocks.slice(firstBlockIndex, lastBlockIndex + 1).filter((block) => block.kind !== "blank");
  // Moving several blocks to the top one at a time reverses them, so walk the painted blocks
  // bottom-up for "more" and top-down for "less" to keep their reading order.
  const blocksInMoveOrder = direction === "more" ? [...paintedBlocks].reverse() : paintedBlocks;
  let editedBlocks = blocks;
  const movedOrderedListItems: BodyBlock[] = [];
  for (const paintedBlock of blocksInMoveOrder) {
    if (isUnclosedCodeFence(paintedBlock)) continue;
    if (paintedBlock.kind === "heading") {
      const headingLevel = headingLevelOf(paintedBlock);
      const newHeadingLevel = Math.min(6, Math.max(1, headingLevel + (direction === "more" ? -1 : 1)));
      editedBlocks = editedBlocks.map((block) => (block === paintedBlock ? withHeadingLevel(block, newHeadingLevel) : block));
    } else if (paintedBlock.kind === "list-item") {
      editedBlocks = moveListItemToEdge(editedBlocks, paintedBlock, direction);
      if (listMarkerOf(paintedBlock).isOrdered) movedOrderedListItems.push(paintedBlock);
    } else {
      editedBlocks = moveBlockToSectionEdge(editedBlocks, paintedBlock, direction);
    }
  }
  return normalizeBlocks(renumberOrderedLists(editedBlocks, movedOrderedListItems));
}
