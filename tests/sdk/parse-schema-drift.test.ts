import { beforeAll, describe, expect, it } from 'bun:test';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { parseAgentXml } from '../../src/sdk/parser.js';

// #3461: an observation written in tags outside the schema (<kind>/<detail>
// instead of <type>/<title>) is still salvaged into a row, but the parser now
// says so, so the worker can correct the turn instead of letting the model copy it.
describe('parseAgentXml schema-drift flag (#3461)', () => {
  beforeAll(() => {
    ModeManager.getInstance().loadMode('code');
  });

  it('flags the unknown tags of a salvaged block, and still returns its row', () => {
    const result = parseAgentXml('<observation><kind>bugfix</kind><detail>Fixed the retry loop</detail></observation>');
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.observations).toHaveLength(1);
    expect(result.schemaDrift).toEqual(['detail', 'kind']);
  });

  it('does not flag a block written in the schema', () => {
    const result = parseAgentXml('<observation><type>bugfix</type><title>Fixed it</title><narrative>n</narrative></observation>');
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.schemaDrift).toBeUndefined();
  });

  it('does not flag an extra tag beside the schema\'s own fields (nothing was salvaged)', () => {
    const result = parseAgentXml('<observation><type>bugfix</type><title>Fixed it</title><severity>high</severity></observation>');
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.schemaDrift).toBeUndefined();
  });

  it('matches tags case-insensitively, like the rest of the parser', () => {
    const result = parseAgentXml('<observation><Kind>bugfix</Kind><Detail>Fixed</Detail></observation>');
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.schemaDrift).toEqual(['detail', 'kind']);
  });

  it('leaves a content-free block invalid: there is nothing to salvage', () => {
    expect(parseAgentXml('<observation><kind></kind></observation>').valid).toBe(false);
  });
});
