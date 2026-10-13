import { expect, test } from 'bun:test';
import { canonicalIntegrationId } from '../../src/shared/integration-id.js';
for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
  test(`retains unsupported integration ${name} as a string`, () => expect(canonicalIntegrationId(name)).toBe(name));
}
test('resolves declared aliases', () => expect(canonicalIntegrationId('claude')).toBe('claude-code'));
