import { describe, expect, it } from 'bun:test';
import { buildObservationPromptParts } from '../../src/sdk/prompts.js';
import { boundObservationPrompt } from '../../src/services/worker/codex-observation-batch.js';

const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('observation truncation keeps Unicode scalar values intact', () => {
  it('does not split emoji when truncating individual tool fields', () => {
    const parts = buildObservationPromptParts({ id: 1, tool_name: 'Read', tool_input: JSON.stringify('😀'.repeat(300)), tool_output: JSON.stringify('😀'.repeat(300)), created_at_epoch: 1 }, 200);
    expect(parts.parameters).not.toMatch(loneSurrogate);
    expect(parts.outcome).not.toMatch(loneSurrogate);
    expect(parts.parameters).toContain('<elided chars=');
  });

  it('keeps Codex head and tail cuts well-formed within the character budget', () => {
    const parts = { header: '<observed_from_primary_session>', parameters: '😀'.repeat(2000), outcome: '😀'.repeat(2000), restateSchema: false };
    for (let limit = 2200; limit < 2230; limit++) {
      const result = boundObservationPrompt(parts, limit);
      expect(result.length).toBeLessThanOrEqual(limit);
      expect(result).not.toMatch(loneSurrogate);
    }
  });
});
