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

  it('global toggle skips a subagent observation (agent id AND agent type)', () => {
    const s = settings({ CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS: 'true' });
    expect(shouldSkipAgentObservation('agent-1', 'workflow-subagent', s))
      .toEqual({ skip: true, reason: 'subagent_observation' });
  });

  it('global toggle keeps transcript-watch rows that carry an agent id alone (Grok Bot seats)', () => {
    // Transcript-watch ingestion stamps the seat id (or an agent-transcripts
    // uuid) as agentId on MAIN-agent rows. Keying on agentId alone would drop
    // all Grok Bot capture as soon as the toggle is on.
    const s = settings({ CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS: 'true' });
    expect(shouldSkipAgentObservation('grok-seat-7', undefined, s)).toEqual({ skip: false });
  });

  it('global toggle does NOT skip the main session', () => {
    const s = settings({ CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS: 'true' });
    expect(shouldSkipAgentObservation(undefined, undefined, s)).toEqual({ skip: false });
    // agentType alone is a `claude --agent <type>` main thread.
    expect(shouldSkipAgentObservation(undefined, 'Explore', s)).toEqual({ skip: false });
  });

  it('per-type list skips only matching subagent agent_type values', () => {
    const s = settings({ CLAUDE_MEM_SKIP_AGENT_TYPES: 'workflow-subagent,Explore' });
    expect(shouldSkipAgentObservation('a', 'workflow-subagent', s))
      .toEqual({ skip: true, reason: 'agent_type_excluded' });

    expect(shouldSkipAgentObservation('a', 'Plan', s)).toEqual({ skip: false });
  });

  it('per-type list never drops a `claude --agent <type>` main thread (agent type without an id)', () => {
    const s = settings({ CLAUDE_MEM_SKIP_AGENT_TYPES: 'workflow-subagent' });
    expect(shouldSkipAgentObservation(undefined, 'workflow-subagent', s)).toEqual({ skip: false });
  });

  it('union semantics — global toggle takes precedence and reports its reason', () => {
    const s = settings({
      CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS: 'true',
      CLAUDE_MEM_SKIP_AGENT_TYPES: 'Explore',
    });
    expect(shouldSkipAgentObservation('a', 'workflow-subagent', s))
      .toEqual({ skip: true, reason: 'subagent_observation' });
  });

  it('main-session observation is unaffected by a per-type list', () => {
    const s = settings({ CLAUDE_MEM_SKIP_AGENT_TYPES: 'workflow-subagent,Explore,Plan' });
    expect(shouldSkipAgentObservation(undefined, undefined, s).skip).toBe(false);
  });
});
