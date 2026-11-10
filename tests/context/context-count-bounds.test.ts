import { expect, it } from 'bun:test';
import { parseContextCountValue } from '../../src/shared/context-count.js';
import { SettingsRoutes } from '../../src/services/worker/http/routes/SettingsRoutes.js';

it.each([
  ['NaN', undefined], ['Infinity', undefined], ['-1', undefined],
  ['3.5', undefined], ['', undefined], ['1e3', undefined], ['10junk', undefined],
  [NaN, undefined], [Infinity, undefined], [-1, undefined], [3.5, undefined],
  ['0', 0], ['1000', 1000], ['100', 100], ['500', 500], ['1', 1],
  ['200', 200], ['20', 20], ['50', 50], [25, 25], [5, 5], [4, 4],
])('parses context count %p as %p', (raw, expected) => {
  expect(parseContextCountValue(raw)).toBe(expected);
});

const routes = new SettingsRoutes({} as any) as unknown as {
  validateSettings(settings: Record<string, unknown>): { valid: boolean; error?: string };
};

it.each(['1e3', '1.5', '1trailing'])('rejects prefix-like count %s at the settings validator', value => {
  expect(routes.validateSettings({ CLAUDE_MEM_CONTEXT_FULL_COUNT: value }).valid).toBe(false);
});

it('accepts a numeric JSON count at the settings validator', () => {
  expect(routes.validateSettings({ CLAUDE_MEM_CONTEXT_FULL_COUNT: 5 }).valid).toBe(true);
});
