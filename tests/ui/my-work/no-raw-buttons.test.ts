import { expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript-compiler-api';

/**
 * G14: My Work's own pages and components use `Button` (variant="bare" for whole-card and title buttons), so the
 * primitive's focus ring, cursors, disabled look and touch size reach every button. Raw `<button>` tags skip all
 * of that: on the All requests page 79 of 97 buttons did (UI UX Pro Max review, c-ui-button).
 *
 * The ceiling is the count on 2026-11-15 at the start of Phase 1 (44 tags in 10 files). Each later phase lowers it
 * as its pages move onto Button; Phase 8 sets it to 0. Never raise it.
 * Phase 2 (2026-11-16): the focus rail's rows and chips moved onto Button (focus-nav.tsx, 5 tags): 39 in 9 files.
 * Phase 3 (2026-11-16): the focus board (focus-overview.tsx, all of its tags) and the home page's summary, cards and
 * folds (pages/my-work.tsx) moved onto Button: 27 in 8 files. The List, By agent and Team rows left in my-work.tsx are
 * Phase 4's.
 * Phase 3 fix round (2026-11-16): `motion.button` counts too, since it skips the primitive just as `<button>` does (the
 * change ticker's line was one, 38px on touch); the ticker now animates a Button: still 27 in 8 files, 0 of them motion.
 * Phase 7 (2026-11-16): My Rules (10 tags) and Past focus (2) moved onto Button: 27 in 7 files.
 * Phases 3 and 7 merged (2026-11-16): 15 in 6 files.
 * Phase 4 (2026-11-16): the List's phone rows and table titles, By agent's request rows and the Team cards
 * (pages/my-work.tsx, its last 4 tags) moved onto Button: 11 in 5 files.
 * Phase 5 (2026-11-16): the request card's title and terminal buttons, the focus area link, and the image strip and
 * viewer (9 tags) moved onto Button, and the reply card's folder path left raw buttons too: 5 in 2 files.
 * Phases 4 and 5 merged (2026-11-17): 1 in 1 file (components/share-focus.tsx).
 * Phase 6 (2026-11-17): the shared mark (share-focus.tsx SharedMark) moved onto Button: 0.
 */
const RAW_BUTTON_CEILING = 0;

const MY_WORK_SOURCE = resolve(import.meta.dir, '../../../src/ui/my-work/src');
const SCANNED_FOLDERS = ['pages', 'components'];
// components/ui is the primitives themselves; aceternity and ai-elements are vendor kits, which use buttonVariants
// classes or are wrapped instead (G14).
const EXCLUDED_FOLDERS = ['components/ui', 'components/aceternity', 'components/ai-elements'];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return EXCLUDED_FOLDERS.includes(relative(MY_WORK_SOURCE, path)) ? [] : sourceFiles(path);
    return /\.tsx$/.test(entry.name) && !entry.name.includes('.test.') ? [path] : [];
  });
}

/** JSX tags that draw a raw button: `<button>`, and motion's `<motion.button>`. */
const RAW_BUTTON_TAGS = new Set(['button', 'motion.button']);

/** The raw button tags in one file, read from its syntax tree so comments and strings never count. */
function rawButtonCount(path: string): number {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let count = 0;
  const visit = (node: ts.Node) => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && RAW_BUTTON_TAGS.has(node.tagName.getText(source))) count++;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return count;
}

it('My Work pages and components add no raw <button> or <motion.button> tags (G14)', () => {
  const perFile = SCANNED_FOLDERS.flatMap((folder) => sourceFiles(join(MY_WORK_SOURCE, folder)))
    .map((path) => ({ file: relative(MY_WORK_SOURCE, path), count: rawButtonCount(path) }))
    .filter(({ count }) => count > 0);
  const total = perFile.reduce((sum, { count }) => sum + count, 0);
  // On failure the files with raw tags are listed, so the new one is easy to find.
  expect({ total, withinCeiling: total <= RAW_BUTTON_CEILING, perFile })
    .toEqual({ total, withinCeiling: true, perFile });
});
