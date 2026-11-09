#!/usr/bin/env bun
import ts from 'typescript';
import postcss from 'postcss';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkMdx from 'remark-mdx';
import { visit } from 'unist-util-visit';
import { parse as parse5Parse, parseFragment as parse5ParseFragment } from 'parse5';
import { readFileSync, writeFileSync, lstatSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { extname, basename, join } from 'node:path';
import { isUtf8 } from 'node:buffer';
import { parseArgs } from 'node:util';

interface CliOptions {
  root: string;
  check: boolean;
  dryRun: boolean;
  verbose: boolean;
}

function parseCliArgs(argv: string[]): CliOptions {
  try {
    const { values, positionals } = parseArgs({
      args: argv.slice(2),
      allowPositionals: true,
      options: {
        check: { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        verbose: { type: 'boolean', short: 'v', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
    if (values.help) {
      printHelp();
      process.exit(0);
    }
    return {
      root: positionals[0] ?? process.cwd(),
      check: values.check,
      dryRun: values['dry-run'],
      verbose: values.verbose,
    };
  } catch (e) {
    console.error((e as Error).message);
    printHelp();
    process.exit(2);
  }
}

function printHelp(): void {
  console.log(`Usage: bun scripts/strip-comments.ts [path] [flags]

Strips narrative comments from all git-tracked files using real parsers:
  JS/TS/JSX  -> TypeScript compiler (ts.getLeadingCommentRanges)
  CSS/SCSS   -> postcss + postcss-discard-comments
  MD/MDX     -> unified + remark-parse + remark-mdx + remark-stringify
  HTML       -> parse5 (parse, drop #comment nodes, serialize)
  shell/py   -> line-based hash stripper (kept; no library worth its weight)

Build directives are preserved (shebangs, @ts-*, eslint-disable, biome-ignore,
prettier-ignore, triple-slash references, webpack magic, /*! license keep).
Files containing @strip-comments-keep in the first 4096 bytes are skipped.

Flags:
  --check     Exit non-zero if any file would change. Doesn't write.
  --dry-run   Print what would change without writing.
  --verbose   Log each changed file.
  -h, --help  Show this help.

After running, review the diff with \`git diff\`, then run
\`npm run build-and-sync\` to confirm typecheck and build still pass.
`);
}

const SKIP_PATHS = new Set<string>([
  'package-lock.json',
  'bun.lock',
  'bun.lockb',
  'plugin/scripts/claude-mem',
]);

const SKIP_BASENAMES = new Set<string>([
  'LICENSE',
  'COPYING',
  'NOTICE',
]);

const BINARY_EXT = new Set<string>([
  '.svg', '.webp', '.woff', '.woff2', '.gif', '.png', '.jpg', '.jpeg', '.ico', '.pdf', '.zip',
]);

const JS_LIKE_EXT = new Set<string>(['.ts', '.tsx', '.js', '.jsx', '.cjs', '.mjs']);
const MD_EXT = new Set<string>(['.md', '.mdx']);
const HTML_EXT = new Set<string>(['.html', '.htm']);
const CSS_LIKE_EXT = new Set<string>(['.css', '.scss', '.less']);
const HASH_LIKE_EXT = new Set<string>(['.sh', '.bash', '.zsh', '.py']);
const HASH_LIKE_BASE = new Set<string>([
  '.gitignore', '.npmignore', '.dockerignore', '.gitattributes', '.npmrc', '.editorconfig',
]);

const KEEP_MARKER = /@strip-comments-keep/;
const NUL_BYTE = 0;

function isDirectiveJs(text: string): boolean {
  if (text.startsWith('///')) return true;
  if (text.startsWith('/*!')) return true;
  if (KEEP_MARKER.test(text)) return true;
  const inner = text
    .replace(/^\/\/\s*/, '')
    .replace(/^\/\*+\s*/, '')
    .replace(/\s*\*+\/$/, '')
    .trim();
  if (/^[ \t]*(?:\*[ \t]*)?@(?:license|preserve)\b/m.test(inner)) return true;
  return /^(@ts-(?:ignore|expect-error|nocheck|check)\b|eslint-(?:disable|enable)|biome-ignore|prettier-ignore|@vitest-|c8\s+ignore|istanbul\s+ignore|@__PURE__|#__PURE__|[@#]\s*source(?:Mapping)?URL=|webpack(?:ChunkName|Prefetch|Preload|Include|Exclude|Mode|Ignore))/.test(inner);
}

function scriptKindFor(ext: string): ts.ScriptKind {
  switch (ext) {
    case '.tsx': return ts.ScriptKind.TSX;
    case '.jsx': return ts.ScriptKind.JSX;
    case '.js':
    case '.cjs':
    case '.mjs': return ts.ScriptKind.JS;
    default: return ts.ScriptKind.TS;
  }
}

function parseDiagnosticsCount(sf: ts.SourceFile): number {
  return ((sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? []).length;
}

function stripJsLike(source: string, ext: string): string {
  const kind = scriptKindFor(ext);
  const sf = ts.createSourceFile('input', source, ts.ScriptTarget.Latest, true, kind);
  const beforeErrs = parseDiagnosticsCount(sf);

  const seen = new Set<string>();
  const ranges: Array<[number, number]> = [];

  function visitNode(node: ts.Node): void {
    const leading = ts.getLeadingCommentRanges(source, node.getFullStart()) || [];
    const trailing = ts.getTrailingCommentRanges(source, node.getEnd()) || [];
    for (const r of leading) addRange(r);
    for (const r of trailing) addRange(r);
    ts.forEachChild(node, visitNode);
  }
  function addRange(r: ts.CommentRange): void {
    const key = `${r.pos}-${r.end}`;
    if (seen.has(key)) return;
    seen.add(key);
    const text = source.slice(r.pos, r.end);
    if (isDirectiveJs(text)) return;
    ranges.push([r.pos, r.end]);
  }

  visitNode(sf);
  const out = spliceRanges(source, ranges, 'js');

  const after = ts.createSourceFile('check', out, ts.ScriptTarget.Latest, true, kind);
  const afterErrs = parseDiagnosticsCount(after);
  if (afterErrs > beforeErrs) {
    throw new Error(`strip introduced ${afterErrs - beforeErrs} new parse error(s); refusing to write`);
  }
  return out;
}

// Parser offsets point into the original text. Copy each unaffected span once;
// whitespace in strings, templates, HTML pre blocks and fenced examples is data.
function spliceRanges(source: string, ranges: Array<[number, number]>, syntax?: 'js'): string {
  const parts: string[] = [];
  let cursor = 0;
  for (const [start, end] of ranges.sort((a, b) => a[0] - b[0])) {
    let from = start;
    while (from > cursor && /[ \t]/.test(source[from - 1])) from--;
    const atLineStart = from === 0 || source[from - 1] === '\n';
    const lineEnd = source.startsWith('\r\n', end) ? 2 : source[end] === '\n' ? 1 : 0;
    if (atLineStart && (lineEnd || end === source.length)) {
      parts.push(source.slice(cursor, from));
      cursor = end + lineEnd;
      continue;
    }
    parts.push(source.slice(cursor, start));
    if (syntax === 'js') {
      // A block comment separates tokens; any line terminator inside it also
      // affects automatic semicolon insertion (e.g. a return statement).
      const lineBreak = source.slice(start, end).match(/[\r\n\u2028\u2029]+/u);
      if (lineBreak) parts.push(lineBreak[0]);
      else if (start > 0 && end < source.length && !/\s/.test(source[start - 1]) && !/\s/.test(source[end])) parts.push(' ');
    }
    cursor = end;
  }
  parts.push(source.slice(cursor));
  return parts.join('');
}

function stripCss(source: string): string {
  const root = postcss.parse(source);
  const ranges: Array<[number, number]> = [];
  root.walkComments((node) => {
    const start = node.source?.start?.offset;
    const end = node.source?.end?.offset;
    if (typeof start !== 'number' || typeof end !== 'number') return;
    const raw = source.slice(start, end);
    if (raw.startsWith('/*!')) return;
    if (KEEP_MARKER.test(raw)) return;
    if (/\/\*\s*prettier-ignore/.test(raw)) return;
    ranges.push([start, end]);
  });
  return spliceRanges(source, ranges);
}

const HTML_COMMENT_RE = /^<!--(?:(?!-->)[\s\S])*-->$/;
function isHtmlDirective(raw: string): boolean {
  return /^<!--(?:#|\s*\[if\b|\s*<!\[endif\])/i.test(raw);
}

interface MdNode {
  type: string;
  value?: string;
  data?: { estree?: { body?: unknown[] } };
  position?: { start?: { offset?: number }; end?: { offset?: number } };
}

function stripMarkdown(source: string, isMdx: boolean): string {
  const processor = unified().use(remarkParse);
  if (isMdx) processor.use(remarkMdx);
  const tree = processor.parse(source);
  const ranges: Array<[number, number]> = [];
  visit(tree, (node) => {
    const n = node as MdNode;
    const start = n.position?.start?.offset;
    const end = n.position?.end?.offset;
    if (typeof start !== 'number' || typeof end !== 'number') return;
    if (n.type === 'html' && typeof n.value === 'string' && HTML_COMMENT_RE.test(n.value.trim())) {
      if (KEEP_MARKER.test(n.value) || isHtmlDirective(n.value.trim())) return;
      ranges.push([start, end]);
      return;
    }
    if (isMdx && (n.type === 'mdxFlowExpression' || n.type === 'mdxTextExpression')) {
      const v = n.value ?? '';
      if (n.data?.estree?.body?.length === 0 && /^\s*\/[*\/]/.test(v) && !KEEP_MARKER.test(v)) {
        ranges.push([start, end]);
      }
    }
  });
  return spliceRanges(source, ranges);
}

interface Parse5Node {
  nodeName: string;
  childNodes?: Parse5Node[];
  content?: Parse5Node;
  data?: string;
  sourceCodeLocation?: { startOffset?: number; endOffset?: number };
}

function stripHtml(source: string, isFragment: boolean): string {
  const tree = (isFragment
    ? parse5ParseFragment(source, { sourceCodeLocationInfo: true })
    : parse5Parse(source, { sourceCodeLocationInfo: true })) as unknown as Parse5Node;
  const ranges: Array<[number, number]> = [];
  collectHtmlCommentRanges(tree, source, ranges);
  return spliceRanges(source, ranges);
}

function collectHtmlCommentRanges(node: Parse5Node, source: string, ranges: Array<[number, number]>): void {
  if (node.nodeName === '#comment') {
    const start = node.sourceCodeLocation?.startOffset;
    const end = node.sourceCodeLocation?.endOffset;
    if (typeof start === 'number' && typeof end === 'number') {
      const raw = source.slice(start, end);
      if (!KEEP_MARKER.test(raw) && !isHtmlDirective(raw)) {
        ranges.push([start, end]);
      }
    }
  }
  if (node.content) collectHtmlCommentRanges(node.content, source, ranges);
  if (node.childNodes) {
    for (const child of node.childNodes) {
      collectHtmlCommentRanges(child, source, ranges);
    }
  }
}

function stripHashComments(source: string, wholeLineOnly: boolean): string {
  const lines = source.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === 0 && line.startsWith('#!')) {
      out.push(line);
      continue;
    }
    const stripped = wholeLineOnly && !line.trimStart().startsWith('#') ? line : stripHashFromLine(line);
    if (stripped === '' && line.trim().startsWith('#')) {
      continue;
    }
    out.push(stripped);
  }
  return out.join('\n');
}

function stripHashFromLine(line: string): string {
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length) {
      i++;
      continue;
    }
    if (!inDouble && !inBacktick && c === "'") inSingle = !inSingle;
    else if (!inSingle && !inBacktick && c === '"') inDouble = !inDouble;
    else if (!inSingle && !inDouble && c === '`') inBacktick = !inBacktick;
    else if (!inSingle && !inDouble && !inBacktick && c === '#') {
      if (i === 0 || /\s/.test(line[i - 1])) {
        return line.slice(0, i).replace(/[ \t]+$/, '');
      }
    }
  }
  return line;
}

interface Stats {
  changed: number;
  unchanged: number;
  skipped: number;
  bytesBefore: number;
  bytesAfter: number;
  errors: string[];
  changedFiles: string[];
  reformatRatioFlags: string[];
}

function processFile(absPath: string, relPath: string, stats: Stats, opts: CliOptions): void {
  if (SKIP_PATHS.has(relPath)) {
    stats.skipped++;
    return;
  }
  const base = basename(relPath);
  if (SKIP_BASENAMES.has(base)) {
    stats.skipped++;
    return;
  }
  const ext = extname(relPath).toLowerCase();
  if (BINARY_EXT.has(ext)) {
    stats.skipped++;
    return;
  }

  let st;
  try {
    st = lstatSync(absPath);
    // A tracked directory may also have been replaced by a symlink locally.
    if (st.isFile() && realpathSync(absPath) !== absPath) {
      stats.skipped++;
      return;
    }
  } catch {
    stats.skipped++;
    return;
  }
  if (!st.isFile()) {
    stats.skipped++;
    return;
  }

  let raw: Buffer;
  try {
    raw = readFileSync(absPath);
  } catch {
    stats.skipped++;
    return;
  }

  if (raw.includes(NUL_BYTE) || !isUtf8(raw)) {
    stats.skipped++;
    return;
  }

  const original = raw.toString('utf-8');
  if (KEEP_MARKER.test(original.slice(0, 4096))) {
    stats.skipped++;
    return;
  }

  let stripped: string;
  try {
    if (JS_LIKE_EXT.has(ext)) {
      stripped = stripJsLike(original, ext);
    } else if (CSS_LIKE_EXT.has(ext)) {
      stripped = stripCss(original);
    } else if (MD_EXT.has(ext)) {
      stripped = stripMarkdown(original, ext === '.mdx');
    } else if (HTML_EXT.has(ext)) {
      stripped = stripHtml(original, false);
    } else if (
      HASH_LIKE_EXT.has(ext) ||
      HASH_LIKE_BASE.has(base) ||
      base === 'Dockerfile' ||
      base.startsWith('Dockerfile.')
    ) {
      stripped = stripHashComments(original, HASH_LIKE_BASE.has(base));
    } else {
      stats.skipped++;
      return;
    }
  } catch (e: unknown) {
    stats.errors.push(`${relPath}: ${(e as Error).message}`);
    return;
  }

  if (stripped === original) {
    stats.unchanged++;
    return;
  }

  const removedBytes = raw.length - Buffer.byteLength(stripped);
  if (removedBytes > 0) {
    const lineDiff = Math.abs(original.split('\n').length - stripped.split('\n').length);
    const removedFraction = removedBytes / Math.max(raw.length, 1);
    if (lineDiff > 20 && removedFraction < 0.005) {
      stats.reformatRatioFlags.push(relPath);
    }
  }

  stats.changed++;
  stats.bytesBefore += raw.length;
  stats.bytesAfter += Buffer.byteLength(stripped);
  stats.changedFiles.push(relPath);

  if (!opts.check && !opts.dryRun) {
    writeFileSync(absPath, stripped, 'utf-8');
  }
  if (opts.verbose || opts.dryRun) {
    console.log(`would change: ${relPath}`);
  }
}

function main(): void {
  const opts = parseCliArgs(process.argv);

  const stats: Stats = {
    changed: 0,
    unchanged: 0,
    skipped: 0,
    bytesBefore: 0,
    bytesAfter: 0,
    errors: [],
    changedFiles: [],
    reformatRatioFlags: [],
  };

  let files: string[];
  try {
    opts.root = realpathSync(opts.root);
    const paths = execFileSync('git', ['ls-files', '-z', '--deduplicate'], { cwd: opts.root });
    files = [];
    let start = 0;
    for (let end = paths.indexOf(0); end !== -1; end = paths.indexOf(0, start)) {
      const name = paths.subarray(start, end);
      if (isUtf8(name)) files.push(name.toString('utf8'));
      start = end + 1;
    }
  } catch (e) {
    console.error(`git ls-files failed in ${opts.root}: ${(e as Error).message}`);
    process.exit(2);
  }

  for (const rel of files) {
    processFile(join(opts.root, rel), rel, stats, opts);
  }

  const suffix = opts.check ? ' (check mode, no writes)' : opts.dryRun ? ' (dry-run, no writes)' : '';
  console.log(`Changed:   ${stats.changed}${suffix}`);
  console.log(`Unchanged: ${stats.unchanged}`);
  console.log(`Skipped:   ${stats.skipped}`);
  if (stats.changed > 0) {
    const saved = stats.bytesBefore - stats.bytesAfter;
    const pct = ((saved / stats.bytesBefore) * 100).toFixed(1);
    console.log(`Bytes:     ${stats.bytesBefore} -> ${stats.bytesAfter} (-${saved}, -${pct}%)`);
  }
  if (stats.reformatRatioFlags.length > 0) {
    console.log(`Reformat-suspect (${stats.reformatRatioFlags.length}): library may be reformatting more than stripping`);
    for (const f of stats.reformatRatioFlags.slice(0, 10)) console.log(`  ${f}`);
  }
  if (stats.errors.length > 0) {
    console.log(`Errors (${stats.errors.length}):`);
    for (const e of stats.errors.slice(0, 20)) {
      console.log(`  ${e}`);
    }
  }

  if (stats.errors.length > 0) process.exit(1);
  if (opts.check && stats.changed > 0) process.exit(1);
}

main();
