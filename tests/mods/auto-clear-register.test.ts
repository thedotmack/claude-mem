import { describe, it, expect } from 'bun:test';
import { registerAutoClear } from '../../src/mods/auto-clear/register.js';

const WRITE = 'mcp__plugin_claude-mem_mcp-search__work_state_write';
const SAVED = 'Saved to "work" in demo.';

type Hook = ($: unknown, e: any, next: (e: any) => Promise<any>) => Promise<any>;

/**
 * registerAutoClear() against a stand-in for Claude Code's mods API: each hook is kept
 * by event, and `$` records what the mod asks for. Context use is fixed at 40%,
 * past the default threshold, with auto-clear turned on by the environment.
 */
function harness() {
  const hooks = new Map<string, Hook>();
  const on = ((event: string, ...rest: unknown[]) => {
    hooks.set(event, rest[rest.length - 1] as Hook);
    return { catch: () => undefined };
  }) as any;
  registerAutoClear(on);

  const record = { commands: [] as string[], prompts: [] as string[], notes: [] as string[], appended: [] as string[] };
  const timers: Array<() => void> = [];
  const env: Record<string, string> = { HOME: '/home/ada', CLAUDE_MEM_AUTO_CLEAR_ENABLED: 'true' };
  const $ = {
    env: { get: async (name: string) => env[name] },
    fs: { exists: async () => false, read: async () => '' },
    clock: { now: async () => 0, after: (_ms: number, callback: () => void) => { timers.push(callback); } },
    session: {
      usage: async () => ({ context: { tokens: 80_000, window: 200_000, percent: 40 } }),
      surfaces: async () => ['terminal'],
      append: async (input: { message: { content: Array<{ text: string }> } }) => {
        record.appended.push(input.message.content.map(block => block.text).join(''));
      },
    },
    prompt: { submit: async (input: { text: string }) => { record.prompts.push(input.text); } },
    command: { run: async (input: { command: string }) => { record.commands.push(input.command); } },
    ui: { log: (text: string) => { record.notes.push(text); } },
  };
  const settle = async () => {
    while (timers.length > 0) timers.shift()!();
    await new Promise(resolve => setTimeout(resolve, 5));
  };

  let rows = 0;
  /** Raises a tool-result row; `storedAs` is the content the rest of the chain kept, when it differs. */
  const toolResult = async (tool: string, content: unknown, storedAs?: unknown) => {
    rows += 1;
    const row = (text: unknown) => ({
      message: { type: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${rows}`, content: text }] },
      door: 'tool-result',
      origin: { kind: 'tool', tool },
      uuid: `row-${rows}`,
    });
    const stored = row(storedAs === undefined ? content : storedAs);
    return hooks.get('session.append')!($, row(content), async () => ({ message: stored.message, uuid: stored.uuid }));
  };
  const passThrough = async (e: unknown) => e;
  const start = () => hooks.get('session.start')!($, {}, passThrough);
  const turnDone = () => hooks.get('turn.complete')!($, { turnId: 't1', isAborted: false, reason: 'answer' }, passThrough);

  return { record, settle, toolResult, start, turnDone };
}

describe('auto-clear register (session.append)', () => {
  it('clears after a save whose stored result reads as saved', async () => {
    const { record, settle, toolResult, start, turnDone } = harness();
    await start();
    await toolResult('Bash', 'ok');
    expect(record.appended).toHaveLength(1);
    await toolResult(WRITE, [{ type: 'text', text: SAVED }]);
    await turnDone();
    await settle();
    await settle();
    expect(record.commands).toEqual(['clear']);
  });

  it('judges the save by the row as stored: a save another hook emptied stops auto-clear and never clears', async () => {
    const { record, settle, toolResult, start, turnDone } = harness();
    await start();
    await toolResult('Bash', 'ok');
    // The event carries the save text, but the row the chain kept has none.
    await toolResult(WRITE, [{ type: 'text', text: SAVED }], '');
    expect(record.notes.at(-1) ?? '').toContain('did not clear the conversation');
    await turnDone();
    await settle();
    await settle();
    expect(record.commands).toEqual([]);
  });

  it('returns the stored row unchanged', async () => {
    const { toolResult, start } = harness();
    await start();
    const kept = await toolResult('Bash', 'from the event', 'as stored');
    expect(kept.message.content[0].content).toBe('as stored');
  });
});
