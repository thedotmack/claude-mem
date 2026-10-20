import { describe, expect, it } from 'bun:test';
import { MEMORY_PLUGIN_INSTRUCTIONS, memoryInstructionsForRuntime } from '../../src/shared/memory-instructions.js';

describe('runtime-specific memory instructions', () => {
  it('keeps worker recall on the three-step Smart workflow', () => {
    const text = memoryInstructionsForRuntime('worker');
    expect(text).toContain('Smart search by default');
    expect(text).toContain('search({query, project})');
    expect(text).toContain('timeline({anchor})');
    expect(text).toContain('get_observations({ids})');
    expect(text).toContain('Doesn’t reason about the results. Fast, but shallow. Use Smart for reliable recall.');
    expect(text).not.toContain('Server runtime:');
  });
  it('does not direct server recall into the local corpus', () => {
    const text = memoryInstructionsForRuntime('server');
    expect(text).toContain('search({query})');
    expect(text).toContain('timeline({anchor: ID})');
    expect(text).toContain('get_observations({ids})');
    expect(text).toContain('configured server project');
    expect(text).not.toContain('search({query, project})');
    expect(text).not.toContain('timeline({anchor})');
    expect(MEMORY_PLUGIN_INSTRUCTIONS).toContain('Worker runtime:');
    expect(MEMORY_PLUGIN_INSTRUCTIONS).toContain('Server runtime:');
  });
});
