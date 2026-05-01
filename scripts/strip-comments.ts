#!/usr/bin/env bun
import ts from 'typescript';
import postcss from 'postcss';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkMdx from 'remark-mdx';
import { visit } from 'unist-util-visit';
import { parse as parse5Parse, parseFragment as parse5ParseFragment } from 'parse5';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { extname, basename, join } from 'node:path';

interface CliOptions {
  root: string;
  check: boolean;
  dryRun: boolean;
  verbose: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  let root = process.cwd();
  let check = false;
  let dryRun = false;
  let verbose = false;
  for (const arg of argv.slice(2)) {
    if (arg === '--check') check = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--verbose' || arg === '-v') verbose = true;
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (!arg.startsWith('-')) {
      root = arg;
    } else {
      console.error(`Unknown flag: ${arg}`);
      printHelp();
      process.exit(2);
    }
  }
  return { root, check, dryRun, verbose };
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
  return /^(@ts-(?:ignore|expect-error|nocheck|check)\b|eslint-(?:disable|enable)|biome-ignore|prettier-ignore|@vitest-|c8\s+ignore|istanbul\s+ignore|@__PURE__|#__PURE__|webpack(?:ChunkName|Prefetch|Preload|Include|Exclude|Mode|Ignore))/.test(inner);
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
  const out = spliceRanges(source, ranges);

  const after = ts.createSourceFile('check', out, ts.ScriptTarget.Latest, true, kind);
  const afterErrs = parseDiagnosticsCount(after);
  if (afterErrs > beforeErrs) {
    throw new Error(`strip introduced ${afterErrs - beforeErrs} new parse error(s); refusing to write`);
  }
  return out;
}

function collapseBlankLines(s: string): string {
  return s.replace(/(?:[ \t]*\n){3,}/g, '\n\n');
}

function spliceRanges(source: string, ranges: Array<[number, number]>): string {
  ranges.sort((a, b) => a[0] - b[0]);
  let out = source;
  for (let i = ranges.length - 1; i >= 0; i--) {
    const [s, e] = ranges[i];
    let removeStart = s;
    let removeEnd = e;
    let lineStart = s;
    while (lineStart > 0 && (out[lineStart - 1] === ' ' || out[lineStart - 1] === '\t')) {
      lineStart--;
    }
    if (lineStart === 0 || out[lineStart - 1] === '\n') {
      removeStart = lineStart;
      if (out[removeEnd] === '\n') removeEnd++;
    }
    out = out.slice(0, removeStart) + out.slice(removeEnd);
  }
  return collapseBlankLines(out);
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

const HTML_COMMENT_RE = /^<!--[\s\S]*-->$/;

function isMdxNarrativeComment(value: string): boolean {
  const trimmed = value.trim();
  if (/^\/\*[\s\S]*\*\/$/.test(trimmed)) return true;
  if (/^\/\/.*$/.test(trimmed)) return true;
  return false;
}

interface MdNode {
  type: string;
  value?: string;
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
      if (KEEP_MARKER.test(n.value)) return;
      ranges.push([start, end]);
      return;
    }
    if (isMdx && (n.type === 'mdxFlowExpression' || n.type === 'mdxTextExpression')) {
      const v = n.value ?? '';
      if (isMdxNarrativeComment(v) && !KEEP_MARKER.test(v)) {
        ranges.push([start, end]);
      }
    }
  });
  return spliceRanges(source, ranges);
}

interface Parse5Node {
  nodeName: string;
  childNodes?: Parse5Node[];
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
      if (!KEEP_MARKER.test(raw)) {
        ranges.push([start, end]);
      }
    }
  }
  if (node.childNodes) {
    for (const child of node.childNodes) {
      collectHtmlCommentRanges(child, source, ranges);
    }
  }
}

function stripHashComments(source: string, preserveShebang: boolean): string {
  const lines = source.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === 0 && preserveShebang && line.startsWith('#!')) {
      out.push(line);
      continue;
    }
    const stripped = stripHashFromLine(line);
    if (stripped === '' && line.trim().startsWith('#')) {
      continue;
    }
    out.push(stripped);
  }
  return collapseBlankLines(out.join('\n'));
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
    st = statSync(absPath);
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

  if (raw.includes(NUL_BYTE)) {
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
      stripped = stripHashComments(original, true);
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

  const removedBytes = original.length - stripped.length;
  if (removedBytes > 0) {
    const lineDiff = Math.abs(original.split('\n').length - stripped.split('\n').length);
    const removedFraction = removedBytes / Math.max(original.length, 1);
    if (lineDiff > 20 && removedFraction < 0.005) {
      stats.reformatRatioFlags.push(relPath);
    }
  }

  stats.changed++;
  stats.bytesBefore += original.length;
  stats.bytesAfter += stripped.length;
  stats.changedFiles.push(relPath);

  if (!opts.check && !opts.dryRun) {
    writeFileSync(absPath, stripped, 'utf-8');
  }
  if (opts.verbose || opts.dryRun) {
    console.log(`would change: ${relPath}`);
  }
}

function main(): void {
  const opts = parseArgs(process.argv);

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
    files = execSync('git ls-files', { cwd: opts.root, encoding: 'utf-8' })
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
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
