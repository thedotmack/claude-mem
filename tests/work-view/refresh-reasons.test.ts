import { describe, expect, it } from 'bun:test';
import { runAgentTask, type AgentTask } from '../../src/services/agent-runner/run.js';
import { WAITING_FOR_AGENT_REASON, isRefreshStartRefusal, isWaitingForAgentReason } from '../../src/shared/work-view-refresh-reasons.js';

/**
 * My Work's refresh line shows the worker's own sentences for people as they are, and folds anything else under Details
 * (decision G17; #5535 wants the "why" a refresh waits in sight). The sentences have one definition,
 * src/shared/work-view-refresh-reasons.ts, which the route, the agent runner and the line import. This runs the runner
 * to show a waiting refresh carries those sentences, and checks which text the line shows as it is.
 */
const task: AgentTask = {
  reason: 'test',
  cwd: '/data',
  claudeCode: { plugins: [], tools: [], allowedTools: [], readableFolders: ['/data'] },
  run: async () => { throw new Error('no agent may run in this test'); },
};

describe('the refresh reasons My Work shows as they are', () => {
  it('are what the agent runner returns for a refresh that waits for an agent', async () => {
    const noAgent = await runAgentTask(task, { detect: async () => [] });
    expect(noAgent.state).toBe('waiting-for-agent');
    expect(noAgent.error).toBe(WAITING_FOR_AGENT_REASON.noLoggedInAgent);
    const noneAllowed = await runAgentTask({ ...task, allowedAgents: [] }, { detect: async () => { throw new Error('must not detect'); } });
    expect(noneAllowed.error).toBe(WAITING_FOR_AGENT_REASON.noAgentAllowed);
  });

  it('tell the worker’s sentences from any other text, which goes under Details', () => {
    expect(isWaitingForAgentReason(WAITING_FOR_AGENT_REASON.noLoggedInAgent)).toBe(true);
    // A sentence built around an agent's name is not one of the fixed ones.
    expect(isWaitingForAgentReason('None of the allowed agents (Codex) is logged in on this computer.')).toBe(false);
    expect(isRefreshStartRefusal('Refresh is unavailable until setup finishes.')).toBe(true);
    // A raw error the route's generic handler sends (BaseRouteHandler.handleError) is not a refusal sentence.
    expect(isRefreshStartRefusal("EACCES: permission denied, open '/Users/someone/.claude-mem/work-view/refresh.json'")).toBe(false);
    expect(isRefreshStartRefusal(null)).toBe(false);
  });
});
