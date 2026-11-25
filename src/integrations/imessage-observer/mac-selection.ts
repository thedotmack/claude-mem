/**
 * Which chats the Mac app observes, and what to watch for in each.
 *
 * The Mac app writes ~/.claude-mem/imessage-observer/mac.json; the observer
 * reads it again whenever the file changes, so ticking a chat in the app
 * takes effect on the next message, without a restart.
 *
 *   {
 *     "version": 1,
 *     "defaultFocus": "",
 *     "chats": {
 *       "iMessage;+;chat123": { "observe": true, "focus": "trip plans and who pays for what" }
 *     }
 *   }
 *
 * A chat that is not in the file, or has `observe: false`, is not read and
 * nothing from it is sent. The file holds chat ids and the person's own
 * notes, never messages.
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** What the person wrote for "observe for"; kept short so it cannot crowd out the chat. */
export const MAX_FOCUS_CHARS = 500;

export interface ChatChoice {
  observe: boolean;
  focus?: string;
}

export interface MacSelectionFile {
  version: 1;
  defaultFocus?: string;
  chats: Record<string, ChatChoice>;
}

export function emptySelection(): MacSelectionFile {
  return { version: 1, chats: {} };
}

export function parseSelection(raw: unknown): MacSelectionFile {
  const file = emptySelection();
  if (!raw || typeof raw !== 'object') return file;
  const input = raw as Partial<MacSelectionFile>;
  if (typeof input.defaultFocus === 'string') file.defaultFocus = input.defaultFocus.slice(0, MAX_FOCUS_CHARS);
  if (input.chats && typeof input.chats === 'object') {
    for (const [guid, choice] of Object.entries(input.chats)) {
      if (!guid || !choice || typeof choice !== 'object') continue;
      const focus = typeof choice.focus === 'string' ? choice.focus.slice(0, MAX_FOCUS_CHARS) : undefined;
      file.chats[guid] = { observe: choice.observe === true, ...(focus ? { focus } : {}) };
    }
  }
  return file;
}

export function writeSelection(path: string, selection: MacSelectionFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp`;
  writeFileSync(temp, JSON.stringify(selection, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, path);
}

/** The selection as it is on disk now, re-read when the file changes. */
export class MacSelection {
  private current: MacSelectionFile = emptySelection();
  private stamp = '';

  constructor(private readonly path: string) {
    this.refresh();
  }

  /** Re-reads the file if it changed. Cheap enough to call per message. */
  refresh(): boolean {
    let stamp: string;
    try {
      const info = statSync(this.path);
      stamp = `${info.mtimeMs}:${info.size}`;
    } catch {
      stamp = 'missing';
    }
    if (stamp === this.stamp) return false;
    this.stamp = stamp;
    if (stamp === 'missing') {
      this.current = emptySelection();
      return true;
    }
    try {
      this.current = parseSelection(JSON.parse(readFileSync(this.path, 'utf8')));
    } catch {
      // A half-written or broken file keeps the last good selection.
      this.stamp = '';
      return false;
    }
    return true;
  }

  get file(): MacSelectionFile {
    return this.current;
  }

  isObserved(guid: string): boolean {
    this.refresh();
    return this.current.chats[guid]?.observe === true;
  }

  observedChats(): string[] {
    this.refresh();
    return Object.entries(this.current.chats).filter(([, choice]) => choice.observe).map(([guid]) => guid);
  }

  /** The chat's own focus, or the default one, or nothing. */
  focusFor(guid: string): string | undefined {
    this.refresh();
    const own = this.current.chats[guid]?.focus?.trim();
    if (own) return own;
    return this.current.defaultFocus?.trim() || undefined;
  }
}
