import * as path from 'path';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';

const markdownParser = unified().use(remarkParse);

// Leaves URLs with a scheme (https:, mailto:), protocol-relative URLs, root-absolute paths and
// in-page anchors alone: they mean the same thing from any directory.
const NON_RELATIVE = /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i;

function rewriteTarget(target: string, sourceDir: string, outDir: string): string {
  if (!target || NON_RELATIVE.test(target)) return target;

  const suffixStart = target.search(/[?#]/);
  const pathPart = suffixStart === -1 ? target : target.slice(0, suffixStart);
  const suffix = suffixStart === -1 ? '' : target.slice(suffixStart);
  if (!pathPart) return target;

  let rewritten = path.relative(outDir, path.resolve(sourceDir, pathPart)).split(path.sep).join('/');
  if (!rewritten) rewritten = '.';
  if (pathPart.endsWith('/') && !rewritten.endsWith('/')) rewritten += '/';
  return rewritten + suffix;
}

function rewriteSrcset(srcset: string, sourceDir: string, outDir: string): string {
  return srcset
    .split(',')
    .map((candidate) => {
      const [, lead, url, rest] = candidate.match(/^(\s*)(\S+)(.*)$/s) ?? [];
      return url === undefined ? candidate : lead + rewriteTarget(url, sourceDir, outDir) + rest;
    })
    .join(',');
}

/**
 * The translator keeps links verbatim, but translations are written to a different directory
 * (docs/i18n/) than the source README. Rewrite relative Markdown and HTML links so they resolve
 * from the output directory: `LICENSE` becomes `../../LICENSE`, `docs/i18n/README.ja.md` becomes
 * `README.ja.md`. Fenced code blocks are left untouched.
 */
export function rewriteRelativeLinks(markdown: string, sourceDir: string, outDir: string): string {
  const from = path.resolve(sourceDir);
  const to = path.resolve(outDir);
  if (from === to) return markdown;

  // Markdown containers (such as nested lists) determine how far a fence can be indented.
  const codeLines = new Set<number>();
  visit(markdownParser.parse(markdown), 'code', ({ position }) => {
    if (!position) return;
    for (let line = position.start.line; line <= position.end.line; line++) codeLines.add(line);
  });
  return markdown
    .split('\n')
    .map((line, index) => {
      if (codeLines.has(index + 1)) return line;
      return line
        .replace(/(\]\()([^)\s]+)/g, (_, open, target) => open + rewriteTarget(target, from, to))
        .replace(/\b(href|src)=(["'])(.*?)\2/g, (_, attr, quote, target) => `${attr}=${quote}${rewriteTarget(target, from, to)}${quote}`)
        .replace(/\bsrcset=(["'])(.*?)\1/g, (_, quote, value) => `srcset=${quote}${rewriteSrcset(value, from, to)}${quote}`);
    })
    .join('\n');
}
