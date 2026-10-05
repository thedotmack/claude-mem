import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { claudeCodeAdapter } from '../../../src/cli/adapters/claude-code.js';

const baseInput = {
  hook_event_name: 'SessionStart',
  session_id: 'session-start-source',
  cwd: process.cwd(),
};

describe('Claude Code SessionStart source', () => {
  for (const source of ['startup', 'resume', 'clear', 'compact']) {
    it(`preserves ${source} when normalizing the hook input`, () => {
      expect(claudeCodeAdapter.normalizeInput({ ...baseInput, source }).sessionSource).toBe(source);
    });
  }

  it('drops missing, unknown, and non-string sources', () => {
    for (const source of [undefined, null, '', 'archive', 42, { source: 'resume' }]) {
      expect(claudeCodeAdapter.normalizeInput({ ...baseInput, source }).sessionSource).toBeUndefined();
    }
  });
});

interface SessionStartGroup {
  matcher?: string;
  hooks: Array<{ command: string }>;
}

const { hooks } = JSON.parse(readFileSync(
  new URL('../../../plugin/hooks/hooks.json', import.meta.url),
  'utf-8',
)) as { hooks: { SessionStart: SessionStartGroup[] } };

function commandsForSource(source: string): string[] {
  return hooks.SessionStart
    .filter(group => !group.matcher || new RegExp(group.matcher).test(source))
    .flatMap(group => group.hooks.map(hook => hook.command));
}

describe('Claude Code SessionStart hook matchers', () => {
  it('starts the worker on resume without running timeline injection', () => {
    const commands = commandsForSource('resume');
    expect(commands.filter(command => command.includes('"$_P/scripts/worker-service.cjs" start'))).toHaveLength(1);
    expect(commands.filter(command => command.includes(' hook claude-code context'))).toHaveLength(0);
  });

  for (const source of ['startup', 'clear', 'compact']) {
    it(`keeps timeline injection and worker startup on ${source}`, () => {
      const commands = commandsForSource(source);
      expect(commands.filter(command => command.includes('"$_P/scripts/worker-service.cjs" start'))).toHaveLength(1);
      expect(commands.filter(command => command.includes(' hook claude-code context'))).toHaveLength(1);
    });
  }
});
