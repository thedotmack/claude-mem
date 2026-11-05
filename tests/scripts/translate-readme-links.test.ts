import { describe, it, expect } from 'bun:test';
import { join } from 'path';
import { rewriteRelativeLinks } from '../../scripts/translate-readme/links';

/**
 * Translations are written to docs/i18n/ but keep the English README's links verbatim, so
 * root-relative links like `LICENSE` or `docs/i18n/README.ja.md` 404 from the translated page.
 */
describe('rewriteRelativeLinks', () => {
  const root = '/repo';
  const outDir = join(root, 'docs', 'i18n');
  const rewrite = (markdown: string) => rewriteRelativeLinks(markdown, root, outDir);

  it('rewrites Markdown links relative to the output directory', () => {
    expect(rewrite('See [LICENSE](LICENSE) and [docs/license.md](docs/license.md).')).toBe(
      'See [LICENSE](../../LICENSE) and [docs/license.md](../license.md).',
    );
  });

  it('keeps a trailing slash on directory links', () => {
    expect(rewrite('- **Documentation**: [docs/](docs/)')).toBe('- **Documentation**: [docs/](../)');
  });

  it('rewrites the language switcher to sibling files', () => {
    expect(rewrite('<a href="docs/i18n/README.ja.md">🇯🇵 日本語</a>')).toBe('<a href="README.ja.md">🇯🇵 日本語</a>');
  });

  it('rewrites src and every srcset candidate', () => {
    expect(rewrite('<img src="docs/public/logo.webp" alt="Logo">')).toBe('<img src="../public/logo.webp" alt="Logo">');
    expect(rewrite('<source srcset="docs/public/a.webp 1x, docs/public/b.webp 2x">')).toBe(
      '<source srcset="../public/a.webp 1x, ../public/b.webp 2x">',
    );
  });

  it('keeps anchors and query strings on rewritten links', () => {
    expect(rewrite('[guide](docs/server.md#setup)')).toBe('[guide](../server.md#setup)');
  });

  it('leaves absolute URLs, anchors and root paths alone', () => {
    const markdown = [
      '[site](https://docs.claude-mem.ai/)',
      '[mail](mailto:a@b.c)',
      '<a href="#quick-start">Quick Start</a>',
      '[root](/docs)',
      '<img src="//cdn.example.com/x.svg">',
    ].join('\n');
    expect(rewrite(markdown)).toBe(markdown);
  });

  it('leaves fenced code blocks untouched', () => {
    const markdown = ['```md', '[LICENSE](LICENSE)', '```', '[LICENSE](LICENSE)'].join('\n');
    expect(rewrite(markdown)).toBe(['```md', '[LICENSE](LICENSE)', '```', '[LICENSE](../../LICENSE)'].join('\n'));
  });

  it('does nothing when the output directory is the source directory', () => {
    expect(rewriteRelativeLinks('[LICENSE](LICENSE)', root, root)).toBe('[LICENSE](LICENSE)');
  });
});
