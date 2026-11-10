import { describe, it, expect } from 'bun:test';
import {
  AutoClearController,
  CONTINUE_PROMPT,
  type AutoClearHost,
} from '../../src/mods/auto-clear/controller.js';
import type { AutoClearSettings } from '../../src/mods/auto-clear/settings.js';

const WRITE = 'mcp__plugin_claude-mem_mcp-search__work_state_write';
const READ = 'mcp__plugin_claude-mem_mcp-search__work_state_read';
const SAVED = 'Saved to "auth-refactor" in claude-mem. Still open in it:\n- [doing] wire the login route';

/** A host that records what the controller asks of Claude Code; deferred tasks run when the test flushes them. */
function fakeHost(options: { percent?: number; settings?: Partial<AutoClearSettings>; interactive?: boolean } = {}) {
  const calls: string[] = [];
  const notes: string[] = [];
  const deferred: Array<() => Promise<void>> = [];
  const state = {
    percent: options.percent as number | undefined,
    settings: { enabled: true, percent: 33, ...options.settings } as AutoClearSettings,
    interactive: options.interactive ?? true,
    failClear: false,
    failAsUser: false,
  };
  const host: AutoClearHost = {
    settings: async () => state.settings,
    contextPercent: async () => state.percent,
    isInteractive: async () => state.interactive,
    submitPrompt: async text => { calls.push(`prompt:${text.split('\n')[0]}`); },
    clear: async () => {
      if (state.failClear) throw new Error('no /clear');
      calls.push('clear');
    },
    submitAsUser: async text => {
      if (state.failAsUser) throw new Error('no submit');
      calls.push(`user:${text}`);
    },
    note: text => { notes.push(text); },
    defer: task => { deferred.push(task); },
  };
  const flush = async () => {
    while (deferred.length > 0) await deferred.shift()!();
  };
  return { host, calls, notes, state, flush };
}

const answered = { isAborted: false, reason: 'answer' };
const tool = (name: string, text = 'ok', extra: Partial<{ agentId: string; isError: boolean; denied: boolean }> = {}) => ({
  tool: name, text, denied: false, isError: false, ...extra,
});

describe('auto-clear controller', () => {
  it('does nothing below the threshold', async () => {
    const { host, calls, notes, flush } = fakeHost({ percent: 32 });
    const controller = new AutoClearController(host);
    expect(await controller.onToolCallEnd(tool('Bash'))).toBeNull();
    await controller.onTurnEnd(answered);
    await flush();
    expect(calls).toEqual([]);
    expect(notes).toEqual([]);
  });

  it('asks Claude to save mid-turn, then clears and sends "continue" once the save is the last thing it did', async () => {
    const { host, calls, notes, flush } = fakeHost({ percent: 34 });
    const controller = new AutoClearController(host);

    const note = await controller.onToolCallEnd(tool('Bash'));
    expect(note).toContain('34% of the context window');
    expect(note).toContain('work_state_write');
    expect(notes[0]).toContain('Context is at 34%');
    // Asked once per conversation, not on every later tool call.
    expect(await controller.onToolCallEnd(tool('Read'))).toBeNull();

    await controller.onToolCallEnd(tool(WRITE, SAVED));
    await controller.onTurnEnd(answered);
    await flush();
    expect(calls).toEqual(['clear', `user:${CONTINUE_PROMPT}`]);
  });

  it('counts a save followed only by reading the work state back', async () => {
    const { host, calls, flush } = fakeHost({ percent: 40 });
    const controller = new AutoClearController(host);
    await controller.onToolCallEnd(tool('Bash'));
    await controller.onToolCallEnd(tool(WRITE, SAVED));
    await controller.onToolCallEnd(tool(READ, 'open lists'));
    await controller.onTurnEnd(answered);
    await flush();
    expect(calls).toEqual(['clear', 'user:continue']);
  });

  it('treats a save followed by more work as stale and asks again in a turn of its own', async () => {
    const { host, calls, flush } = fakeHost({ percent: 40 });
    const controller = new AutoClearController(host);
    await controller.onToolCallEnd(tool('Bash'));
    await controller.onToolCallEnd(tool(WRITE, SAVED));
    await controller.onToolCallEnd(tool('Edit'));
    await controller.onTurnEnd(answered);
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toStartWith('prompt:This conversation now uses 40%');

    // The save prompt's turn writes the work state: now it clears.
    await controller.onToolCallEnd(tool(WRITE, SAVED));
    await controller.onTurnEnd(answered);
    await flush();
    expect(calls.slice(1)).toEqual(['clear', 'user:continue']);
  });

  it('sends the save request as a prompt when the turn crossed the threshold without a tool call', async () => {
    const { host, calls, flush } = fakeHost({ percent: 50 });
    const controller = new AutoClearController(host);
    await controller.onTurnEnd(answered);
    await flush();
    expect(calls).toEqual(['prompt:This conversation now uses 50% of the context window, past the 33% auto-clear point set in claude-mem. When this turn ends, claude-mem clears the conversation and sends "continue", and the fresh conversation starts with your open work state.']);

    await controller.onToolCallEnd(tool(WRITE, SAVED));
    await controller.onTurnEnd(answered);
    await flush();
    expect(calls.slice(1)).toEqual(['clear', 'user:continue']);
  });

  it('never clears when nothing was saved, and waits for the next /clear', async () => {
    const { host, calls, notes, flush } = fakeHost({ percent: 50 });
    const controller = new AutoClearController(host);
    await controller.onTurnEnd(answered);
    await flush();
    await controller.onTurnEnd(answered); // the save prompt's turn, no write
    await flush();
    expect(calls).toHaveLength(1);
    expect(notes.at(-1)).toContain('did not save the work state, so the conversation was not cleared');

    // Paused: later turns ask nothing.
    await controller.onTurnEnd(answered);
    expect(await controller.onToolCallEnd(tool('Bash'))).toBeNull();
    await flush();
    expect(calls).toHaveLength(1);

    // The person's own /clear starts a new conversation, and auto-clear is back.
    controller.onConversationEnd();
    expect(await controller.onToolCallEnd(tool('Bash'))).not.toBeNull();
  });

  it('does not count a write that failed or was refused', async () => {
    for (const failed of [
      tool(WRITE, 'Not saved: this project is excluded from claude-mem (CLAUDE_MEM_EXCLUDED_PROJECTS).'),
      tool(WRITE, 'Worker API error (500)', { isError: true }),
      tool(WRITE, SAVED, { denied: true }),
    ]) {
      const { host, calls, flush } = fakeHost({ percent: 40 });
      const controller = new AutoClearController(host);
      await controller.onToolCallEnd(tool('Bash'));
      await controller.onToolCallEnd(failed);
      await controller.onTurnEnd(answered);
      await flush();
      expect(calls.some(call => call === 'clear')).toBe(false);
    }
  });

  it('does not clear when the person stops the turn, even after a save', async () => {
    const { host, calls, notes, flush } = fakeHost({ percent: 40 });
    const controller = new AutoClearController(host);
    await controller.onToolCallEnd(tool('Bash'));
    await controller.onToolCallEnd(tool(WRITE, SAVED));
    await controller.onTurnEnd({ isAborted: true, reason: 'aborted' });
    await flush();
    expect(calls).toEqual([]);
    expect(notes.at(-1)).toContain('stopped');
  });

  it('ignores subagents: their tool calls, saves and turns', async () => {
    const { host, calls, flush } = fakeHost({ percent: 60 });
    const controller = new AutoClearController(host);
    expect(await controller.onToolCallEnd(tool('Bash', 'ok', { agentId: 'a1' }))).toBeNull();
    await controller.onTurnEnd({ ...answered, agentId: 'a1' });
    await flush();
    expect(calls).toEqual([]);

    await controller.onToolCallEnd(tool('Bash'));
    await controller.onToolCallEnd(tool(WRITE, SAVED, { agentId: 'a1' }));
    await controller.onTurnEnd(answered);
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toStartWith('prompt:');
  });

  it('stays out of -p runs and SDK sessions, and honors the settings', async () => {
    for (const options of [
      { percent: 90, interactive: false },
      { percent: 90, settings: { enabled: false } },
      { percent: 90, settings: { percent: 95 } },
      { percent: undefined },
    ]) {
      const { host, calls, flush } = fakeHost(options);
      const controller = new AutoClearController(host);
      expect(await controller.onToolCallEnd(tool('Bash'))).toBeNull();
      await controller.onTurnEnd(answered);
      await flush();
      expect(calls).toEqual([]);
    }
  });

  it('keeps going cycle after cycle while each fresh conversation starts below the threshold', async () => {
    const { host, calls, state, flush } = fakeHost({ percent: 40 });
    let controller!: AutoClearController;
    const clearing = host.clear;
    host.clear = async () => {
      await clearing();
      controller.onConversationEnd(); // our own /clear ends the old conversation
    };
    controller = new AutoClearController(host);
    for (let cycle = 0; cycle < 3; cycle += 1) {
      state.percent = 40;
      await controller.onToolCallEnd(tool('Bash'));
      await controller.onToolCallEnd(tool(WRITE, SAVED));
      await controller.onTurnEnd(answered);
      await flush();
      controller.onTurnStart(); // the "continue" turn
      // The fresh conversation's first reading is low.
      state.percent = 6;
      expect(await controller.onToolCallEnd(tool('Read'))).toBeNull();
    }
    expect(calls.filter(call => call === 'clear')).toHaveLength(3);
    expect(calls.filter(call => call === 'user:continue')).toHaveLength(3);
  });

  it('turns itself off when a fresh conversation already starts at the threshold, instead of clearing in a loop', async () => {
    const { host, calls, notes, state, flush } = fakeHost({ percent: 40 });
    const controller = new AutoClearController(host);
    await controller.onToolCallEnd(tool('Bash'));
    await controller.onToolCallEnd(tool(WRITE, SAVED));
    await controller.onTurnEnd(answered);
    await flush();
    expect(calls).toEqual(['clear', 'user:continue']);

    state.percent = 35; // system prompt and context alone are past 33%
    expect(await controller.onToolCallEnd(tool('Read'))).toBeNull();
    await controller.onTurnEnd(answered);
    await flush();
    expect(calls).toEqual(['clear', 'user:continue']);
    expect(notes.at(-1)).toContain('auto-clear is off until Claude Code restarts');
  });

  it('lets a manual /clear cancel a request in flight', async () => {
    const { host, calls, flush } = fakeHost({ percent: 40 });
    const controller = new AutoClearController(host);
    await controller.onToolCallEnd(tool('Bash'));
    await controller.onToolCallEnd(tool(WRITE, SAVED));
    controller.onConversationEnd(); // the person typed /clear mid-turn
    await controller.onTurnEnd({ ...answered });
    await flush();
    // The new conversation is measured afresh, and nothing from the old one is cleared again.
    expect(calls.filter(call => call === 'clear')).toHaveLength(0);
  });

  it('does not start the flow when a turn that crossed the threshold was stopped (Esc)', async () => {
    const { host, calls, flush } = fakeHost({ percent: 50 });
    const controller = new AutoClearController(host);
    await controller.onTurnEnd({ isAborted: true, reason: 'aborted' });
    await controller.onTurnEnd({ isAborted: false, reason: 'error' });
    await flush();
    expect(calls).toEqual([]);
    // The next turn that ends normally still starts it.
    await controller.onTurnEnd(answered);
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toStartWith('prompt:');
  });

  it('drops a queued save prompt when the person clears before it is sent', async () => {
    const { host, calls, flush } = fakeHost({ percent: 50 });
    const controller = new AutoClearController(host);
    await controller.onTurnEnd(answered); // queues the save prompt
    controller.onConversationEnd(); // the person's /clear lands first
    await flush();
    expect(calls).toEqual([]);
  });

  it('drops a pending clear when the person clears or resumes first, so the new conversation is left alone', async () => {
    const { host, calls, flush } = fakeHost({ percent: 40 });
    const controller = new AutoClearController(host);
    await controller.onToolCallEnd(tool('Bash'));
    await controller.onToolCallEnd(tool(WRITE, SAVED));
    await controller.onTurnEnd(answered); // decides to clear; the clear is deferred
    controller.onConversationEnd(); // the person's /clear or /resume runs first
    await flush();
    expect(calls).toEqual([]);
  });

  it('waits when a prompt the person typed starts before the clear, and asks for a fresh save after it', async () => {
    const { host, calls, flush } = fakeHost({ percent: 40 });
    const controller = new AutoClearController(host);
    await controller.onToolCallEnd(tool('Bash'));
    await controller.onToolCallEnd(tool(WRITE, SAVED));
    await controller.onTurnEnd(answered); // decides to clear
    controller.onTurnStart(); // the queued prompt the person typed runs first
    await flush();
    expect(calls).toEqual([]);

    // That turn works on; past the threshold it is asked to save again, and only then cleared.
    const note = await controller.onToolCallEnd(tool('Edit'));
    expect(note).toContain('work_state_write');
    await controller.onToolCallEnd(tool(WRITE, SAVED));
    await controller.onTurnEnd(answered);
    await flush();
    expect(calls).toEqual(['clear', 'user:continue']);
  });

  it('does not send "continue" when a prompt the person typed ran while /clear waited for the session', async () => {
    const { host, calls, notes, flush } = fakeHost({ percent: 40 });
    let controller!: AutoClearController;
    const clearing = host.clear;
    host.clear = async () => {
      // /clear queues behind a turn that starts in the meantime, then runs as our own clear.
      controller.onTurnStart();
      await clearing();
      controller.onConversationEnd();
    };
    controller = new AutoClearController(host);
    await controller.onToolCallEnd(tool('Bash'));
    await controller.onToolCallEnd(tool(WRITE, SAVED));
    await controller.onTurnEnd(answered);
    await flush();
    expect(calls).toEqual(['clear']);
    expect(notes.at(-1)).toContain('Tell Claude where to pick up');
  });

  it('reports a /clear that could not run and pauses', async () => {
    const { host, calls, notes, state, flush } = fakeHost({ percent: 40 });
    state.failClear = true;
    const controller = new AutoClearController(host);
    await controller.onToolCallEnd(tool('Bash'));
    await controller.onToolCallEnd(tool(WRITE, SAVED));
    await controller.onTurnEnd(answered);
    await flush();
    expect(calls).toEqual([]);
    expect(notes.at(-1)).toContain('/clear could not run');
    expect(await controller.onToolCallEnd(tool('Bash'))).toBeNull();
  });

  it('tells the person to type "continue" when the conversation was cleared but the message could not be sent', async () => {
    const { host, calls, notes, state, flush } = fakeHost({ percent: 40 });
    state.failAsUser = true;
    const controller = new AutoClearController(host);
    await controller.onToolCallEnd(tool('Bash'));
    await controller.onToolCallEnd(tool(WRITE, SAVED));
    await controller.onTurnEnd(answered);
    await flush();
    expect(calls).toEqual(['clear']);
    expect(notes.at(-1)).toContain('Type it to pick the work back up');
  });
});
