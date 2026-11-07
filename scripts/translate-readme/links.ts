import * as path from 'path';

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

  let inFence = false;
  return markdown
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line
        .replace(/(\]\()([^)\s]+)/g, (_, open, target) => open + rewriteTarget(target, from, to))
        .replace(/\b(href|src)="([^"]*)"/g, (_, attr, target) => `${attr}="${rewriteTarget(target, from, to)}"`)
        .replace(/\bsrcset="([^"]*)"/g, (_, value) => `srcset="${rewriteSrcset(value, from, to)}"`);
    })
    .join('\n');
}
