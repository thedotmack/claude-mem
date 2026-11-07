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

  it('requires a matching fence of sufficient length with no trailing text', () => {
    for (const [open, inside, close] of [
      ['````md', '```', '````'],
      ['~~~md', '```', '~~~'],
      ['```md', '```example', '```'],
      ['   ~~~~md', '   ~~~', '   ~~~~'],
    ]) {
      const block = [open, inside, '[read](LICENSE)', close].join('\n');
      expect(rewrite(block + '\n[read](LICENSE)')).toBe(block + '\n[read](../../LICENSE)');
    }
  });

  it('leaves a fenced example nested in a list item unchanged', () => {
    const block = ['1. Example:', '', '    ```md', '    [read](LICENSE)', '    ```'].join('\n');
    expect(rewrite(block + '\n[read](LICENSE)')).toBe(block + '\n[read](../../LICENSE)');
  });

  it('keeps a deeply indented marker inside the enclosing example', () => {
    for (const [prefix, open, literal, close] of [
      ['', '```md', '    ```', '```'],
      ['1. Example:', '    ~~~md', '       ~~~', '    ~~~'],
      ['', '> ```md', '>     ```', '> ```'],
    ]) {
      const content = open.startsWith('>') ? '> [read](LICENSE)' : '    [read](LICENSE)';
      const block = [prefix, '', open, literal, content, close].join('\n');
      expect(rewrite(block + '\n[read](LICENSE)')).toBe(block + '\n[read](../../LICENSE)');
    }
  });

  it('preserves single quotes in HTML link and image attributes', () => {
    const input = "<a href='LICENSE'><img src='docs/a.png' srcset='docs/a.png 1x, docs/b.png 2x'></a>";
    expect(rewrite(input)).toBe("<a href='../../LICENSE'><img src='../a.png' srcset='../a.png 1x, ../b.png 2x'></a>");
  });

  it('does nothing when the output directory is the source directory', () => {
    expect(rewriteRelativeLinks('[LICENSE](LICENSE)', root, root)).toBe('[LICENSE](LICENSE)');
  });
});
