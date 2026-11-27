import { expect, it } from 'bun:test';
import { resolvePresetDefaultModel } from '../../src/shared/openai-compat-presets.js';

it('keeps the preset default for an empty override', () => {
  expect(resolvePresetDefaultModel('', 'kimi-k3')).toBe('kimi-k3');
});
it('removes the default for none', () => {
  expect(resolvePresetDefaultModel(' NoNe ', 'kimi-k3')).toBe('');
});
it('replaces the default verbatim', () => {
  expect(resolvePresetDefaultModel('my-id', 'kimi-k3')).toBe('my-id');
});
