/**
 * Auto-clear: when the main conversation reaches the configured share of the
 * context window, Claude saves its work state, then /clear runs and
 * "continue" is sent, so the work carries on in a fresh conversation that
 * starts with the open work state (SessionStart context, `clear` source).
 * It ships off: CLAUDE_MEM_AUTO_CLEAR_ENABLED=true turns it on.
 *
 * The flow, all on the main loop (subagents are never counted):
 *  1. After a tool call, context use is at or past the threshold: a note is
 *     attached to that tool's result asking Claude to save the work state with
 *     work_state_write and end its turn. A turn that crosses the threshold
 *     without a tool call is caught when it ends, and the same request is sent
 *     as a prompt of its own.
 *  2. The turn ends. If the latest thing Claude did was a successful
 *     work_state_write, /clear runs and "continue" is sent as the user.
 *     Otherwise Claude is asked once more in a turn of its own; if that turn
 *     saves nothing either, nothing is cleared and auto-clear waits for the
 *     next /clear. A stopped turn (Esc) never starts or finishes the flow.
 *  3. Every deferred step belongs to the conversation that started it: the
 *     person's own /clear or resume cancels it, and a prompt they typed that
 *     runs before the clear puts the flow back to asking for a fresh save.
 *  4. A fresh conversation that already starts at or past the threshold (a
 *     large system prompt and context against a small window) would clear in
 *     a loop, so auto-clear turns itself off until Claude Code restarts.
 *
 * Nothing here talks to Claude Code directly: AutoClearHost is the mods API
 * as register.ts adapts it, which keeps this file testable.
 */
import type { AutoClearSettings } from './settings.js';

/** claude-mem's write tool, however the host prefixes it (mcp__plugin_claude-mem_mcp-search__work_state_write). */
export const WORK_STATE_WRITE_TOOL = /(?:^|__)work_state_write$/;
/** Reading the work state back does not make a save stale. */
const WORK_STATE_READ_TOOL = /(?:^|__)work_state_read$/;

/** The text that starts a successful work_state_write result (WorkStateRoutes.handleWrite). */
const SAVED_RESULT = /^Saved to "/;

export const CONTINUE_PROMPT = 'continue';

export interface AutoClearHost {
  settings(): Promise<AutoClearSettings>;
  /** The main conversation's context window use, in whole percent, as of the last response. */
  contextPercent(): Promise<number | undefined>;
  /** False in `-p` runs and SDK sessions, where nobody is there to see a clear. */
  isInteractive(): Promise<boolean>;
  /** Sends a prompt from the plugin (Claude sees it is from claude-mem); resolves once its turn starts. */
  submitPrompt(text: string): Promise<void>;
  /** Runs /clear; resolves once the fresh conversation exists. */
  clear(): Promise<void>;
  /** Sends text as the user's own message; resolves once its turn starts. */
  submitAsUser(text: string): Promise<void>;
  /** A line in the transcript for the person; Claude does not read it. */
  note(text: string): void;
  /** Runs `task` after the current hook has returned, so a turn never waits on it. */
  defer(task: () => Promise<void>): void;
}

export interface ToolCallEnd {
  tool: string;
  /** Set when a subagent made the call. */
  agentId?: string;
  /** The call was refused before it ran. */
  denied: boolean;
  isError: boolean;
  /** The result as the model reads it. */
  text?: string;
}

export interface TurnEnd {
  /** Set when the turn was a subagent's. */
  agentId?: string;
  isAborted: boolean;
  /** 'answer' when the model finished normally. */
  reason: string;
}

type Phase =
  /** Nothing asked of Claude. */
  | 'idle'
  /** Claude was asked to save inside its current turn. */
  | 'saving-in-turn'
  /** A save prompt is queued and its turn has not started. */
  | 'save-prompt-queued'
  /** The save prompt's turn is running. */
  | 'saving-in-prompt'
  /** /clear and "continue" are on their way. */
  | 'clearing';

export class AutoClearController {
  private phase: Phase = 'idle';
  /** The latest main-loop tool call since Claude was asked was a successful work_state_write. */
  private saved = false;
  /** Waiting for the first context reading of a conversation auto-clear started. */
  private checkFreshStart = false;
  /** No more requests in this conversation (a save was refused or stopped); cleared by the next /clear. */
  private pausedForConversation = false;
  /** Off until Claude Code restarts. */
  private stopped = false;
  private threshold = 0;
  /** Bumped when a conversation ends; a deferred action of an older conversation does nothing. */
  private conversation = 0;
  /** Set from just before our own /clear runs until its conversation end is seen. */
  private ownClearPending = false;
  /** Bumped when a main-loop turn starts. */
  private turnsStarted = 0;

  constructor(private readonly host: AutoClearHost) {}

  /** A main-loop or subagent tool call finished; returns the note to attach to its result, if any. */
  async onToolCallEnd(call: ToolCallEnd): Promise<string | null> {
    if (call.agentId || call.denied) return null;
    if (WORK_STATE_WRITE_TOOL.test(call.tool)) {
      if (this.phase !== 'idle' && this.phase !== 'clearing') {
        this.saved = !call.isError && SAVED_RESULT.test((call.text ?? '').trim());
      }
      return null;
    }
    if (!WORK_STATE_READ_TOOL.test(call.tool)) this.saved = false;
    if (this.phase !== 'idle') return null;

    const percent = await this.thresholdCrossed();
    if (percent === null || this.phase !== 'idle') return null;
    this.phase = 'saving-in-turn';
    this.saved = false;
    this.host.note(`Context is at ${percent}% (auto-clear at ${this.threshold}%): Claude is saving the work state, then claude-mem clears and continues.`);
    return inTurnSaveRequest(percent, this.threshold);
  }

  /**
   * A main-loop turn started (subagent runs raise no turn start). A turn that
   * starts while the clear is still to come is the person's prompt typed
   * before the turn ended: its work is not in the save, so the clear waits
   * and the save is asked for again once that turn is past the threshold.
   */
  onTurnStart(): void {
    this.turnsStarted += 1;
    if (this.phase === 'clearing' && !this.ownClearPending) {
      this.phase = 'idle';
      this.saved = false;
    }
  }

  async onTurnEnd(turn: TurnEnd): Promise<void> {
    if (turn.agentId) return;
    switch (this.phase) {
      case 'idle': {
        // A stopped or failed turn starts nothing: Esc means the person wants the floor.
        if (turn.isAborted || turn.reason !== 'answer') return;
        const percent = await this.thresholdCrossed();
        if (percent === null || this.phase !== 'idle') return;
        this.saved = false;
        this.host.note(`Context is at ${percent}% (auto-clear at ${this.threshold}%): asking Claude to save the work state, then claude-mem clears and continues.`);
        this.queueSavePrompt(percent);
        return;
      }
      case 'saving-in-turn':
        if (turn.isAborted || turn.reason !== 'answer') return this.giveUp('The turn was stopped before the work state was saved, so the conversation was not cleared.');
        if (this.saved) return this.clearAndContinue();
        this.queueSavePrompt(await this.host.contextPercent() ?? this.threshold);
        return;
      case 'saving-in-prompt':
        if (turn.isAborted || turn.reason !== 'answer') return this.giveUp('The save was stopped, so the conversation was not cleared.');
        if (this.saved) return this.clearAndContinue();
        return this.giveUp('Claude did not save the work state, so the conversation was not cleared.');
      case 'save-prompt-queued':
        // A prompt the person typed ran first; the save prompt is still to come.
        return;
      case 'clearing':
        return;
    }
  }

  /** The conversation ended: /clear (ours or the person's), a resume, or exit. */
  onConversationEnd(): void {
    this.conversation += 1;
    this.pausedForConversation = false;
    if (this.ownClearPending) {
      // Our own /clear: the continue step still has to run.
      this.ownClearPending = false;
      return;
    }
    // The person cleared or switched conversations: anything in flight belonged to the old one.
    this.phase = 'idle';
    this.saved = false;
    this.checkFreshStart = false;
  }

  /** The context use when this conversation should be cleared now, else null. */
  private async thresholdCrossed(): Promise<number | null> {
    if (this.stopped || this.pausedForConversation) return null;
    const settings = await this.host.settings();
    if (!settings.enabled) return null;
    const percent = await this.host.contextPercent();
    if (percent === undefined) return null;
    if (this.checkFreshStart) {
      this.checkFreshStart = false;
      if (percent >= settings.percent) {
        this.stopped = true;
        this.host.note(
          `A fresh conversation already uses ${percent}% of the context window, at or past the ${settings.percent}% auto-clear point, `
          + 'so auto-clear is off until Claude Code restarts. Raise CLAUDE_MEM_AUTO_CLEAR_PERCENT in ~/.claude-mem/settings.json to keep using it.',
        );
        return null;
      }
    }
    if (percent < settings.percent) return null;
    if (!(await this.host.isInteractive())) return null;
    this.threshold = settings.percent;
    return percent;
  }

  private queueSavePrompt(percent: number): void {
    this.phase = 'save-prompt-queued';
    const conversation = this.conversation;
    const stillOurs = () => this.conversation === conversation && this.phase === 'save-prompt-queued';
    this.host.defer(async () => {
      if (!stillOurs()) return;
      try {
        await this.host.submitPrompt(savePrompt(percent, this.threshold));
      } catch {
        if (stillOurs()) this.giveUp('The save prompt could not be sent, so the conversation was not cleared.');
        return;
      }
      if (stillOurs()) this.phase = 'saving-in-prompt';
    });
  }

  private clearAndContinue(): void {
    this.phase = 'clearing';
    this.saved = false;
    const conversation = this.conversation;
    this.host.note('Work state saved. Clearing the conversation and continuing.');
    this.host.defer(async () => {
      // The person cleared, switched conversations, or a prompt they typed started first.
      if (this.conversation !== conversation || this.phase !== 'clearing') return;
      const turnsBeforeClear = this.turnsStarted;
      this.ownClearPending = true;
      try {
        await this.host.clear();
      } catch {
        this.ownClearPending = false;
        if (this.conversation === conversation && this.phase === 'clearing') this.giveUp('/clear could not run, so the conversation was not cleared.');
        return;
      }
      this.ownClearPending = false;
      if (this.phase !== 'clearing') return;
      this.phase = 'idle';
      this.checkFreshStart = true;
      if (this.turnsStarted !== turnsBeforeClear) {
        // /clear waits for the session to be idle: a prompt the person typed ran first, after the save.
        this.host.note('The conversation was cleared after your last message ran, so that turn is not in the saved work state. Tell Claude where to pick up.');
        return;
      }
      try {
        await this.host.submitAsUser(CONTINUE_PROMPT);
      } catch {
        this.host.note('The conversation was cleared, but "continue" could not be sent. Type it to pick the work back up.');
      }
    });
  }

  private giveUp(reason: string): void {
    this.phase = 'idle';
    this.saved = false;
    this.pausedForConversation = true;
    this.host.note(`${reason} Auto-clear waits until the next /clear.`);
  }
}

const SAVE_STEPS = [
  '- Update each list you are working from: mark finished items done and add what is still to do.',
  '- Record the goal, the decisions made and why, the files involved, and the exact next step.',
].join('\n');

/** Attached to a tool result in the middle of a turn. */
export function inTurnSaveRequest(percent: number, threshold: number): string {
  return [
    `claude-mem auto-clear: this conversation now uses ${percent}% of the context window, past the ${threshold}% point set in claude-mem.`
      + ' When this turn ends, claude-mem clears the conversation and sends "continue", and the fresh conversation starts with your open work state.',
    '',
    'Wrap up now so the work carries over. Save where things stand with work_state_write:',
    SAVE_STEPS,
    '',
    'Then end your turn with a one-line note instead of starting new work.',
  ].join('\n');
}

/** Sent as a prompt of its own when the turn ended without a save. */
export function savePrompt(percent: number, threshold: number): string {
  return [
    `This conversation now uses ${percent}% of the context window, past the ${threshold}% auto-clear point set in claude-mem.`
      + ' When this turn ends, claude-mem clears the conversation and sends "continue", and the fresh conversation starts with your open work state.',
    '',
    'Save where things stand with work_state_write so the work carries over:',
    SAVE_STEPS,
    '',
    'Only save state in this turn. A one-line confirmation is enough.',
  ].join('\n');
}
