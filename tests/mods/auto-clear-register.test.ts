import { describe, it, expect } from 'bun:test';
import { register } from '../../src/mods/auto-clear/register.js';

const WRITE = 'mcp__plugin_claude-mem_mcp-search__work_state_write';
const SAVED = 'Saved to "work" in demo.';

type Hook = ($: unknown, e: any, next: (e: any) => Promise<any>) => Promise<any>;

/**
 * register() against a stand-in for Claude Code's mods API: each hook is kept
 * by event and door (`session.append:tool-result`), and `$` records what the
 * mod asks for. Context use is fixed at 45%, past the default threshold, with
 * auto-clear turned on by the environment.
 */
function harness() {
  const hooks = new Map<string, Hook>();
  const on = ((event: string, ...rest: unknown[]) => {
    const door = rest.length > 1 ? (rest[0] as { door?: string }).door : undefined;
    hooks.set(door ? `${event}:${door}` : event, rest[rest.length - 1] as Hook);
    return { catch: () => undefined };
  }) as any;
  register(on);

  const record = { commands: [] as string[], prompts: [] as string[], notes: [] as string[], appended: [] as string[] };
  const timers: Array<() => void> = [];
  const env: Record<string, string> = { HOME: '/home/ada', CLAUDE_MEM_AUTO_CLEAR_ENABLED: 'true' };
  const $ = {
    env: { get: async (name: string) => env[name] },
    fs: { exists: async () => false, read: async () => '' },
    clock: { now: async () => 0, after: (_ms: number, callback: () => void) => { timers.push(callback); } },
    session: {
      usage: async () => ({ context: { tokens: 90_000, window: 200_000, percent: 45 } }),
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
  /** Raises a tool-result row; `storedAs` is the content the rest of the chain kept, when it differs; `toolUseId` names the call it answers. */
  const toolResult = async (tool: string, content: unknown, storedAs?: unknown, toolUseId?: string) => {
    rows += 1;
    const row = (text: unknown) => ({
      message: { type: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId ?? `toolu_${rows}`, content: text }] },
      door: 'tool-result',
      origin: { kind: 'tool', tool },
      uuid: `row-${rows}`,
    });
    const stored = row(storedAs === undefined ? content : storedAs);
    return hooks.get('session.append:tool-result')!($, row(content), async () => ({ message: stored.message, uuid: stored.uuid }));
  };
  /** Raises a response row as the rest of the chain stored it, with `content` as given (well formed or not). */
  const responseStoredAs = async (content: unknown) => {
    rows += 1;
    const row = { message: { type: 'assistant', content }, door: 'response', origin: { kind: 'model', model: 'claude-test' }, uuid: `row-${rows}` };
    return hooks.get('session.append:response')!($, row, async () => ({ message: row.message, uuid: row.uuid }));
  };
  /** Raises a block of the model's response carrying one tool call. */
  const toolUse = async (tool: string, input: unknown, agentId?: string) => {
    rows += 1;
    const row = {
      message: { type: 'assistant', content: [{ type: 'tool_use', id: `toolu_${rows}`, name: tool, input }] },
      door: 'response',
      origin: { kind: 'model', model: 'claude-test' },
      uuid: `row-${rows}`,
      ...(agentId ? { agentId } : {}),
    };
    return hooks.get('session.append:response')!($, row, async () => ({ message: row.message, uuid: row.uuid }));
  };
  const passThrough = async (e: unknown) => e;
  const start = () => hooks.get('session.start')!($, {}, passThrough);
  const turnDone = () => hooks.get('turn.complete')!($, { turnId: 't1', isAborted: false, reason: 'answer' }, passThrough);

  return { record, settle, toolResult, toolUse, responseStoredAs, start, turnDone };
}

const BLANKS = { continuation_recently_completed_task: 'wire the login route', continuation_overarching_goal: 'ship passwordless login' };
const CONTINUATION = 'You are working on "work" and recently completed "wire the login route". '
  + 'Pick back up on our overarching goal "ship passwordless login" from where you left off.';

describe('auto-clear register (session.append, door response)', () => {
  it('reads the blanks off the response row and sends the continuation prompt as the user after the clear', async () => {
    const { record, settle, toolResult, toolUse, start, turnDone } = harness();
    await start();
    await toolResult('Bash', 'ok');
    const call = await toolUse(WRITE, { list: 'work', fields: BLANKS });
    await toolResult(WRITE, [{ type: 'text', text: SAVED }], undefined, call.message.content[0].id);
    await turnDone();
    await settle();
    await settle();
    expect(record.commands).toEqual(['clear']);
    expect(record.prompts).toEqual([CONTINUATION]);
  });

  it('never uses the blanks of a save that failed, even when a later save succeeds', async () => {
    const { record, settle, toolResult, toolUse, start, turnDone } = harness();
    await start();
    await toolResult('Bash', 'ok');
    const failed = await toolUse(WRITE, { list: 'work', fields: BLANKS });
    await toolResult(WRITE, 'HTTP 400: fields is over the 2000-character limit', undefined, failed.message.content[0].id);
    const retried = await toolUse(WRITE, { list: 'work', fields: { status: 'doing' } });
    await toolResult(WRITE, [{ type: 'text', text: SAVED }], undefined, retried.message.content[0].id);
    await turnDone();
    await settle();
    await settle();
    expect(record.commands).toEqual(['clear']);
    expect(record.prompts).toEqual(['continue']);
  });

  it('ignores a subagent\'s save and other tools\' calls', async () => {
    const { record, settle, toolResult, toolUse, start, turnDone } = harness();
    await start();
    await toolResult('Bash', 'ok');
    const subagentCall = await toolUse(WRITE, { list: 'work', fields: BLANKS }, 'agent-1');
    const otherTool = await toolUse('Bash', { list: 'work', fields: BLANKS });
    await toolResult(WRITE, [{ type: 'text', text: SAVED }], undefined, subagentCall.message.content[0].id);
    await toolResult(WRITE, [{ type: 'text', text: SAVED }], undefined, otherTool.message.content[0].id);
    await turnDone();
    await settle();
    await settle();
    expect(record.prompts).toEqual(['continue']);
  });

  it('says so in the transcript when a response row cannot be read, and still keeps the row', async () => {
    const { record, responseStoredAs, start } = harness();
    await start();
    const kept = await responseStoredAs(null);
    expect(kept.message.content).toBeNull();
    expect(record.notes.at(-1) ?? '').toContain('could not read a work_state_write call off the model\'s response');
  });

  it('returns the response row unchanged', async () => {
    const { toolUse, start } = harness();
    await start();
    const kept = await toolUse(WRITE, { list: 'work', fields: BLANKS });
    expect(kept.message.content[0].input).toEqual({ list: 'work', fields: BLANKS });
  });
});

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
