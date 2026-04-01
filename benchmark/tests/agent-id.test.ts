import { describe, expect, test } from 'bun:test';
import type { Arm, Prompt } from '../src/types.js';

/**
 * Generates an agent ID from arm, prompt ID, and replica index.
 * This mirrors the logic in orchestrator.ts.
 */
function generateAgentId(arm: Arm, promptId: string, replicaIndex: number): string {
  const armPrefix = arm === 'claude-mem' ? 'cmem' : 'vanilla';
  return `${armPrefix}-${promptId}-${replicaIndex}`;
}

function makeStubPrompt(id: string): Prompt {
  return {
    frontmatter: {
      id,
      title: 'Test Prompt',
      category: 'web',
      timeout_hint: '4h',
      industry_baseline: {
        source: 'none',
        reference_cost_usd: null,
        reference_duration_seconds: null,
        reference_architecture: null,
      },
      smoke_tests: [
        { name: 'test', command: 'echo hello', expected: 'contains:hello' },
      ],
    },
    body: '# Test',
    filePath: '/test/prompts/test.md',
  };
}

describe('agent-id', () => {
  test('claude-mem arm generates cmem prefix', () => {
    const agentId = generateAgentId('claude-mem', '01-twosidednews', 1);
    expect(agentId).toBe('cmem-01-twosidednews-1');
  });

  test('vanilla arm generates vanilla prefix', () => {
    const agentId = generateAgentId('vanilla', '09-url-shortener', 3);
    expect(agentId).toBe('vanilla-09-url-shortener-3');
  });

  test('agent ID format matches {arm}-{promptId}-{replica}', () => {
    const pattern = /^(cmem|vanilla)-[\w-]+-\d+$/;

    const id1 = generateAgentId('claude-mem', '03-study-boss-fight', 2);
    expect(id1).toMatch(pattern);
    expect(id1).toBe('cmem-03-study-boss-fight-2');

    const id2 = generateAgentId('vanilla', '15-text-similarity', 5);
    expect(id2).toMatch(pattern);
    expect(id2).toBe('vanilla-15-text-similarity-5');
  });

  test('different replicas produce different IDs for same prompt', () => {
    const id1 = generateAgentId('claude-mem', '07-markdown-site-generator', 1);
    const id2 = generateAgentId('claude-mem', '07-markdown-site-generator', 2);
    const id3 = generateAgentId('claude-mem', '07-markdown-site-generator', 3);
    expect(id1).not.toBe(id2);
    expect(id2).not.toBe(id3);
    expect(id1).not.toBe(id3);
  });

  test('same prompt with different arms produces different IDs', () => {
    const cmemId = generateAgentId('claude-mem', '10-recipe-api', 1);
    const vanillaId = generateAgentId('vanilla', '10-recipe-api', 1);
    expect(cmemId).not.toBe(vanillaId);
    expect(cmemId).toBe('cmem-10-recipe-api-1');
    expect(vanillaId).toBe('vanilla-10-recipe-api-1');
  });
});
