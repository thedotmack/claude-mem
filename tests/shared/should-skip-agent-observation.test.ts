import { describe, it, expect } from 'bun:test';
import {
  shouldSkipAgentObservation,
  parseSkipAgentTypes,
  type AgentSkipSettings,
} from '../../src/shared/should-skip-agent-observation.js';

const settings = (over: Partial<AgentSkipSettings> = {}): AgentSkipSettings => ({
  CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS: 'false',
  CLAUDE_MEM_SKIP_AGENT_TYPES: '',
  ...over,
});

describe('parseSkipAgentTypes', () => {
  it('returns an empty set for empty/undefined/null', () => {
    expect(parseSkipAgentTypes('').size).toBe(0);
    expect(parseSkipAgentTypes(undefined).size).toBe(0);
    expect(parseSkipAgentTypes(null).size).toBe(0);
  });

  it('trims whitespace, drops blanks, and de-dupes', () => {
    const set = parseSkipAgentTypes(' workflow-subagent , Explore ,, Explore ,');
    expect(set.has('workflow-subagent')).toBe(true);
    expect(set.has('Explore')).toBe(true);
    expect(set.size).toBe(2);
  });
});

describe('shouldSkipAgentObservation', () => {
  it('defaults preserve current behavior — never skips with both settings off', () => {
    expect(shouldSkipAgentObservation('agent-1', 'workflow-subagent', settings()).skip).toBe(false);
    expect(shouldSkipAgentObservation(undefined, undefined, settings()).skip).toBe(false);
  });

  it('global toggle skips any observation carrying an agentId', () => {
    const s = settings({ CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS: 'true' });
    const decision = shouldSkipAgentObservation('agent-1', 'workflow-subagent', s);
    expect(decision.skip).toBe(true);
    expect(decision.reason).toBe('subagent_observation');
  });

  it('global toggle skips regardless of agentType (even when type is absent)', () => {
    const s = settings({ CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS: 'true' });
    expect(shouldSkipAgentObservation('agent-1', undefined, s).skip).toBe(true);
  });

  it('global toggle does NOT skip the main session (no agentId)', () => {
    const s = settings({ CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS: 'true' });
    expect(shouldSkipAgentObservation(undefined, undefined, s).skip).toBe(false);
    // agentType present but no agentId is still treated as a main-session observation
    expect(shouldSkipAgentObservation(undefined, 'Explore', s).skip).toBe(false);
  });

  it('per-type list skips only matching agent_type values', () => {
    const s = settings({ CLAUDE_MEM_SKIP_AGENT_TYPES: 'workflow-subagent,Explore' });
    const skipped = shouldSkipAgentObservation('a', 'workflow-subagent', s);
    expect(skipped.skip).toBe(true);
    expect(skipped.reason).toBe('agent_type_excluded');

    expect(shouldSkipAgentObservation('a', 'Plan', s).skip).toBe(false);
  });

  it('per-type list matches even without an agentId (type-driven)', () => {
    const s = settings({ CLAUDE_MEM_SKIP_AGENT_TYPES: 'workflow-subagent' });
    expect(shouldSkipAgentObservation(undefined, 'workflow-subagent', s).skip).toBe(true);
  });

  it('union semantics — global toggle takes precedence and reports its reason', () => {
    const s = settings({
      CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS: 'true',
      CLAUDE_MEM_SKIP_AGENT_TYPES: 'Explore',
    });
    const decision = shouldSkipAgentObservation('a', 'workflow-subagent', s);
    expect(decision.skip).toBe(true);
    expect(decision.reason).toBe('subagent_observation');
  });

  it('main-session observation is unaffected by a per-type list', () => {
    const s = settings({ CLAUDE_MEM_SKIP_AGENT_TYPES: 'workflow-subagent,Explore,Plan' });
    expect(shouldSkipAgentObservation(undefined, undefined, s).skip).toBe(false);
  });
});
