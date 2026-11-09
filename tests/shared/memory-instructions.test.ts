import { describe, expect, it } from 'bun:test';
import {
  CLAUDE_CODE_MCP_INSTRUCTIONS_MAX_CHARS,
  MEMORY_PLUGIN_INSTRUCTIONS,
  WORK_STATE_RULE,
  mcpServerInstructions,
  memoryInstructionsForRuntime,
} from '../../src/shared/memory-instructions.js';

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

describe('MCP server instructions', () => {
  it('carries the work-state rule, then the memory guidance for the runtime', () => {
    for (const runtime of ['worker', 'server'] as const) {
      const text = mcpServerInstructions({ runtime, workStateEnabled: true, memoryInstructionsEnabled: true });
      expect(text).toBe(`${WORK_STATE_RULE}\n\n${memoryInstructionsForRuntime(runtime)}`);
    }
    expect(WORK_STATE_RULE).toStartWith("# Work state: your to-do lists and working state\nUse claude-mem's work_state_write tool");
    expect(WORK_STATE_RULE).toContain('It is your canonical to-do list: use it instead of any built-in to-do tool.');
    // A bare work_state_read shows only what is open, so the hint for closed items names the flag.
    expect(WORK_STATE_RULE).toContain('\n- Read every list, closed items included: work_state_read with includeClosed=true');
    // It no longer sits beside the open lists, so it does not say "here".
    expect(WORK_STATE_RULE).toContain('Whatever is still open is shown at the start of every session in this project.');
  });

  it('leaves out each part its setting turns off', () => {
    const memoryOnly = mcpServerInstructions({ runtime: 'worker', workStateEnabled: false, memoryInstructionsEnabled: true });
    expect(memoryOnly).toBe(memoryInstructionsForRuntime('worker'));
    expect(memoryOnly).not.toContain('# Work state');

    const workStateOnly = mcpServerInstructions({ runtime: 'worker', workStateEnabled: true, memoryInstructionsEnabled: false });
    expect(workStateOnly).toBe(WORK_STATE_RULE);

    expect(mcpServerInstructions({ runtime: 'worker', workStateEnabled: false, memoryInstructionsEnabled: false })).toBe('');
  });

  it('fits whole inside the length Claude Code keeps of an MCP server\'s instructions', () => {
    for (const runtime of ['worker', 'server'] as const) {
      const text = mcpServerInstructions({ runtime, workStateEnabled: true, memoryInstructionsEnabled: true });
      expect(text.length).toBeLessThanOrEqual(CLAUDE_CODE_MCP_INSTRUCTIONS_MAX_CHARS);
    }
  });
});
