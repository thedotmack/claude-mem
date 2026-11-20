import { expect, it } from 'bun:test';
import { join } from 'node:path';
import { runOwnedFixture } from '../helpers/owned-fixture.js';

for (const scenario of ['native', 'override', 'no-cwd', 'no-cwd-override', 'excluded', 'excluded-override', 'whitespace-cwd']) {
  it(`applies the native DSH checkout to automatic tool memories (${scenario})`, async () => {
    const output = await runOwnedFixture(join(import.meta.dir, '../fixtures/dsh-native-checkout.ts'), {
      prefix: 'dsh-native-checkout-', args: [scenario],
      env: () => ({ CLAUDE_MEM_PROJECT_NAME_SOURCE: 'path', CLAUDE_MEM_PROJECT_ENVIRONMENTS: '[]', CLAUDE_MEM_NOTION_ENABLED: 'false' }),
    });
    expect(output).toContain(`"scenario":"${scenario}"`);
    expect(output).toContain('"continued":1');
  }, 10_000);
}
