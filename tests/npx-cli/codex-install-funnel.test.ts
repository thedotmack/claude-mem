import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
const source = readFileSync(join(__dirname, '../../src/npx-cli/commands/install.ts'), 'utf8');
describe('personal provider selection', () => {
  it('offers personal credentials without preselecting a paid service', () => {
    const start = source.indexOf('await p.multiselect<ProviderChoice>(');
    const menu = source.slice(start, source.indexOf('required: true', start));
    for (const provider of ['claude', 'codex', 'gemini', 'openrouter']) expect(menu).toContain(`value: '${provider}'`);
    expect(menu).not.toContain("value: 'cmem'");
    expect(menu).not.toContain("initialValues: ['cmem']");
  });
});
