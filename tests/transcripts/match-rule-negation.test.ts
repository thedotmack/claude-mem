import { describe, it, expect } from 'bun:test';
import { matchesRule } from '../../src/services/transcripts/field-utils.js';
import type { MatchRule, TranscriptSchema } from '../../src/services/transcripts/types.js';

// Ingestion filtering (#2442): transcript MatchRule must support negation so
// structurally-identical guardian/subagent sessions can be excluded instead of
// polluting memory. Also covers the exists:false fix.
describe('matchesRule negation operators', () => {
  const schema: TranscriptSchema = {
    name: 'test',
    eventTypePath: 'type',
    events: [],
  };

  const noiseSession = { type: 'tool_use', agentType: 'guardian' };
  const realSession = { type: 'tool_use', agentType: 'primary' };

  it('not_equals excludes the matching noise session and keeps others', () => {
    const rule: MatchRule = { path: 'agentType', not_equals: 'guardian' };
    expect(matchesRule(noiseSession, rule, schema)).toBe(false);
    expect(matchesRule(realSession, rule, schema)).toBe(true);
  });

  it('not_in excludes any of the listed noise agent types', () => {
    const rule: MatchRule = { path: 'agentType', not_in: ['guardian', 'subagent'] };
    expect(matchesRule(noiseSession, rule, schema)).toBe(false);
    expect(matchesRule({ type: 'tool_use', agentType: 'subagent' }, rule, schema)).toBe(false);
    expect(matchesRule(realSession, rule, schema)).toBe(true);
  });

  it('not_contains excludes substring matches', () => {
    const rule: MatchRule = { path: 'agentType', not_contains: 'guard' };
    expect(matchesRule(noiseSession, rule, schema)).toBe(false);
    expect(matchesRule(realSession, rule, schema)).toBe(true);
  });

  it('combines a positive match with a negation in a single rule (AND semantics)', () => {
    // Match tool_use events, but exclude guardian sessions.
    const rule: MatchRule = { path: 'type', equals: 'tool_use' };
    const ruleWithExclusion: MatchRule = { path: 'agentType', not_equals: 'guardian' };
    expect(matchesRule(realSession, rule, schema) && matchesRule(realSession, ruleWithExclusion, schema)).toBe(true);
    expect(matchesRule(noiseSession, rule, schema) && matchesRule(noiseSession, ruleWithExclusion, schema)).toBe(false);
  });

  it('fixes exists:false — field must be ABSENT to match', () => {
    const rule: MatchRule = { path: 'agentType', exists: false };
    // agentType present → excluded
    expect(matchesRule(noiseSession, rule, schema)).toBe(false);
    // agentType absent → matches
    expect(matchesRule({ type: 'tool_use' }, rule, schema)).toBe(true);
  });

  it('exists:true still requires the field to be present', () => {
    const rule: MatchRule = { path: 'agentType', exists: true };
    expect(matchesRule(noiseSession, rule, schema)).toBe(true);
    expect(matchesRule({ type: 'tool_use' }, rule, schema)).toBe(false);
  });
});
