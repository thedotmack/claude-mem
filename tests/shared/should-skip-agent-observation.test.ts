import { describe, it, expect } from 'bun:test';
import {
  parseSkipAgentTypes,
  shouldSkipAgentObservation,
  type AgentSkipSettings,
} from '../../src/shared/should-skip-agent-observation.js';

const settings = (overrides: Partial<AgentSkipSettings> = {}): AgentSkipSettings => ({
  CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS: 'false',
  CLAUDE_MEM_SKIP_AGENT_TYPES: '',
  ...overrides,
});

describe('parseSkipAgentTypes', () => {
  it('returns an empty set for empty, undefined, and null values', () => {
    expect(parseSkipAgentTypes('').size).toBe(0);
    expect(parseSkipAgentTypes(undefined).size).toBe(0);
    expect(parseSkipAgentTypes(null).size).toBe(0);
  });

  it('trims whitespace, drops blanks, and de-dupes values', () => {
    const parsed = parseSkipAgentTypes(' workflow-subagent , Explore ,, Explore ,');
    expect(parsed.has('workflow-subagent')).toBe(true);
    expect(parsed.has('Explore')).toBe(true);
    expect(parsed.size).toBe(2);
  });
});

describe('shouldSkipAgentObservation', () => {
  it('preserves current behavior by default', () => {
    expect(shouldSkipAgentObservation('agent-1', 'workflow-subagent', settings()).skip).toBe(false);
    expect(shouldSkipAgentObservation(undefined, undefined, settings()).skip).toBe(false);
  });

  it('global toggle skips observations carrying agentId', () => {
    const decision = shouldSkipAgentObservation(
      'agent-1',
      'workflow-subagent',
      settings({ CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS: 'true' }),
    );
    expect(decision.skip).toBe(true);
    expect(decision.reason).toBe('subagent_observation');
  });

  it('global toggle does not skip main-session observations', () => {
    const s = settings({ CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS: 'true' });
    expect(shouldSkipAgentObservation(undefined, undefined, s).skip).toBe(false);
    expect(shouldSkipAgentObservation(undefined, 'Explore', s).skip).toBe(false);
  });

  it('per-type list skips matching agentType values', () => {
    const s = settings({ CLAUDE_MEM_SKIP_AGENT_TYPES: 'workflow-subagent,Explore' });
    const decision = shouldSkipAgentObservation('agent-1', 'workflow-subagent', s);
    expect(decision.skip).toBe(true);
    expect(decision.reason).toBe('agent_type_excluded');
    expect(shouldSkipAgentObservation('agent-2', 'Plan', s).skip).toBe(false);
  });

  it('per-type list can match even when agentId is absent', () => {
    const s = settings({ CLAUDE_MEM_SKIP_AGENT_TYPES: 'workflow-subagent' });
    expect(shouldSkipAgentObservation(undefined, 'workflow-subagent', s).skip).toBe(true);
  });

  it('combines settings as a union and reports the global reason first', () => {
    const decision = shouldSkipAgentObservation(
      'agent-1',
      'Explore',
      settings({
        CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS: 'true',
        CLAUDE_MEM_SKIP_AGENT_TYPES: 'Explore',
      }),
    );
    expect(decision.skip).toBe(true);
    expect(decision.reason).toBe('subagent_observation');
  });
});
