import { describe, expect, it } from 'bun:test';
import { resolveEndpointModelId } from '../../src/shared/opencode-model-id.js';

/** The `provider` field of an OpenCode host config, in its V2 and V1 forms. */
const PROVIDER = {
  openrouter: {
    models: {
      'anthropic/claude-sonnet-4': { modelID: 'anthropic/claude-sonnet-4-20250514' },
      'meta/llama-3.3-70b': { name: 'Llama 3.3 70B' },
      'legacy-model': { id: 'vendor/legacy-endpoint-id' },
    },
  },
};

describe('id-v2-mappe', () => {
  it('returns the V2 modelID of the mapped model, splitting at the first slash', () => {
    expect(resolveEndpointModelId('openrouter/anthropic/claude-sonnet-4', PROVIDER))
      .toBe('anthropic/claude-sonnet-4-20250514');
  });
});

describe('id-v1-mappe', () => {
  it('returns the map key when the V1 entry carries no modelID', () => {
    expect(resolveEndpointModelId('openrouter/meta/llama-3.3-70b', PROVIDER))
      .toBe('meta/llama-3.3-70b');
  });

  it('returns the V1 id field when the entry carries one', () => {
    expect(resolveEndpointModelId('openrouter/legacy-model', PROVIDER))
      .toBe('vendor/legacy-endpoint-id');
  });
});

describe('id-inconnu', () => {
  it('returns undefined when the provider is known but the model is not', () => {
    expect(resolveEndpointModelId('openrouter/unknown-model', PROVIDER)).toBeUndefined();
  });
});

describe('provider-absent', () => {
  it('returns undefined when there is no provider config', () => {
    expect(resolveEndpointModelId('openrouter/anthropic/claude-sonnet-4', undefined))
      .toBeUndefined();
  });

  it('returns undefined when the provider is not declared', () => {
    expect(resolveEndpointModelId('other/anthropic/claude-sonnet-4', PROVIDER))
      .toBeUndefined();
  });
});

describe('id-sans-slash', () => {
  it('returns undefined when the host id has no provider prefix', () => {
    expect(resolveEndpointModelId('claude-sonnet-4', PROVIDER)).toBeUndefined();
  });
});

describe('garde-fous-de-type', () => {
  it('returns undefined when a level of the provider map is not an object', () => {
    expect(resolveEndpointModelId('openrouter/model', { openrouter: 'not-an-object' }))
      .toBeUndefined();
    expect(resolveEndpointModelId('openrouter/model', { openrouter: { models: 'nope' } }))
      .toBeUndefined();
    expect(resolveEndpointModelId('openrouter/model', { openrouter: { models: { model: null } } }))
      .toBeUndefined();
    expect(resolveEndpointModelId('openrouter/model', { openrouter: { models: { model: [] } } }))
      .toBeUndefined();
  });

  it('returns undefined for a leading or trailing slash', () => {
    expect(resolveEndpointModelId('/model', PROVIDER)).toBeUndefined();
    expect(resolveEndpointModelId('openrouter/', PROVIDER)).toBeUndefined();
  });

  it('leaves the provider config untouched', () => {
    const frozen = Object.freeze({
      openrouter: Object.freeze({
        models: Object.freeze({
          model: Object.freeze({ modelID: 'endpoint-id' }),
        }),
      }),
    });
    expect(resolveEndpointModelId('openrouter/model', frozen)).toBe('endpoint-id');
    expect(frozen).toEqual({
      openrouter: { models: { model: { modelID: 'endpoint-id' } } },
    });
  });
});
