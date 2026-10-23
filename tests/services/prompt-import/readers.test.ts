import { describe, expect, it } from 'bun:test';
import { join } from 'path';
import { scanOwnerPrompts, type OwnerPrompt } from '../../../src/services/prompt-import/index.js';
import { AgentTextIndex, isAgentWritten, normalize } from '../../../src/services/prompt-import/owner-prompt-filter.js';

const FIXTURE_HOME = join(import.meta.dir, '..', '..', 'fixtures', 'prompt-import', 'home');
const SINCE = Date.parse('2026-09-15T00:00:00.000Z');

async function scan() {
  return scanOwnerPrompts({ sinceEpochMs: SINCE, homeDirectory: FIXTURE_HOME, resolveProject: cwd => cwd ?? 'unknown' });
}

function texts(prompts: OwnerPrompt[], agent: OwnerPrompt['agent']): string[] {
  return prompts.filter(prompt => prompt.agent === agent).map(prompt => prompt.text);
}

describe('prompt readers on recorded transcript lines', () => {
  it('Claude Code: keeps typed prompts; drops subagent, meta, headless, task-notification, SDK and agent-written prompts', async () => {
    const result = await scan();
    expect(texts(result.ownerPrompts, 'claude-code')).toEqual([
      'make the scan screen show each agent',
      '/claude-mem:do PLAN.md',
      'continue',
      'continue',
      'ship it',
    ]);
    const excluded = texts(result.agentWritten, 'claude-code');
    expect(excluded).toHaveLength(3);
    expect(excluded[0]).toStartWith('Implement the funnel scan step'); // its opening was in an earlier Agent tool call
    expect(excluded[1]).toStartWith('You are the implementation agent'); // role assignment over 400 characters
    expect(excluded[2]).toStartWith('Write the release notes'); // written first by a subagent
    const command = result.ownerPrompts.find(prompt => prompt.text === '/claude-mem:do PLAN.md')!;
    expect(command.hookTextVariants).toEqual(['/claude-mem:do PLAN.md', '/do PLAN.md']);
    expect(command).toMatchObject({ sessionId: '11111111-aaaa-bbbb-cccc-000000000001', nativePromptId: 'u-command', cwd: '/work/alpha', platformSource: 'claude' });
  });

  it('Codex: keeps interactive typed prompts; drops injected AGENTS.md, exec and subagent sessions, and agent-written prompts', async () => {
    const result = await scan();
    expect(texts(result.ownerPrompts, 'codex')).toEqual(['fix the flaky test in beta']);
    expect(texts(result.agentWritten, 'codex')).toEqual([expect.stringMatching(/^Review the pull request/)]);
    expect(result.ownerPrompts.find(prompt => prompt.agent === 'codex')).toMatchObject({
      sessionId: 'codex-interactive-1', nativePromptId: 'msg_typed_1', cwd: '/work/beta',
    });
  });

  it('Gemini CLI: reads .jsonl and .json chats once each, prefers what was typed, drops injected context and continuations', async () => {
    const result = await scan();
    expect(texts(result.ownerPrompts, 'gemini-cli')).toEqual([
      'add dark mode to gamma',
      '/make-plan from the plan file',
      'look at this @img.png',
      'what changed in gamma',
    ]);
    expect(result.ownerPrompts.find(prompt => prompt.agent === 'gemini-cli')).toMatchObject({ sessionId: 'gem-1', cwd: '/work/gamma' });
  });

  it('Antigravity CLI: keeps typed history entries inside the window, drops built-in slash commands', async () => {
    const result = await scan();
    expect(texts(result.ownerPrompts, 'antigravity-cli')).toEqual(['/ponytail:ponytail-audit', 'make running experiments easier to follow']);
  });

  it('OpenCode: keeps typed text parts of top-level sessions, drops synthetic parts and subagent sessions', async () => {
    const result = await scan();
    expect(texts(result.ownerPrompts, 'opencode')).toEqual(['rename delta to epsilon']);
    expect(result.ownerPrompts.find(prompt => prompt.agent === 'opencode')).toMatchObject({ sessionId: 'ses_1', nativePromptId: 'msg_1', cwd: '/work/delta' });
  });

  it('detects every agent, reads only the requested ones, and reports no skipped files', async () => {
    const result = await scanOwnerPrompts({ sinceEpochMs: SINCE, homeDirectory: FIXTURE_HOME, agents: ['codex'], resolveProject: () => 'p' });
    expect(result.agents.map(agent => agent.id)).toEqual(['codex']);
    const all = await scan();
    expect(all.agents.every(agent => agent.detected)).toBe(true);
    expect(all.skippedSources).toEqual([]);
    expect(all.agents.find(agent => agent.id === 'claude-code')!.sessions.has('11111111-aaaa-bbbb-cccc-000000000001')).toBe(true);
  });

  it('a home without any agent detects nothing and finds nothing', async () => {
    const result = await scanOwnerPrompts({ sinceEpochMs: SINCE, homeDirectory: join(FIXTURE_HOME, 'no-such-home'), resolveProject: () => 'p' });
    expect(result.agents.some(agent => agent.detected)).toBe(false);
    expect(result.ownerPrompts).toEqual([]);
  });
});

describe('agent-written filter (port of is_agent_written)', () => {
  const prompt = 'Implement the funnel scan step so the worker reads every transcript, stores each typed prompt once, and streams progress to the browser while the scan runs from start to finish.';

  it('flags a prompt whose opening an agent wrote earlier, anywhere in a longer chunk', () => {
    const index = new AgentTextIndex([normalize(prompt).slice(0, 120)]);
    index.add(100, `Here is the brief: ${prompt} Thanks.`);
    expect(isAgentWritten(101, prompt, index)).toBe(true);
    expect(isAgentWritten(100, prompt, index)).toBe(false); // the same second is not earlier
  });

  it('keeps prompts that open in lowercase or are too short to check', () => {
    const lowercase = prompt[0].toLowerCase() + prompt.slice(1);
    const index = new AgentTextIndex([]);
    index.add(1, lowercase);
    expect(isAgentWritten(2, lowercase, index)).toBe(false);
    expect(isAgentWritten(2, 'Short prompt.', index)).toBe(false);
  });
});
