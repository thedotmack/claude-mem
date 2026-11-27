import { readFileSync } from 'node:fs';
import { expect, it } from 'bun:test';

for (const path of ['docs/public/configuration.mdx', 'docs/public/usage/openai-compatible-provider.mdx']) {
  it(`documents the implicit default override in ${path}`, () => {
    const source = readFileSync(path, 'utf8');
    const row = source.split('\n').find(line => line.startsWith('| `CLAUDE_MEM_OPENAI_COMPAT_DEFAULT_MODEL` |'));
    expect(row).toBeString();
    expect(row).toContain('`none` removes both');
    expect(row).toContain('last-served');
    expect(row!.split('|')).toHaveLength(5); // key, default, description, plus the two edge pipes
  });
}
