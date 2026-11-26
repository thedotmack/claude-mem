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
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

/** What the person wrote for "observe for"; kept short so it cannot crowd out the chat. */
export const MAX_FOCUS_CHARS = 500;

export interface ChatChoice {
  observe: boolean;
  focus?: string;
  selectionId?: string;
  observedSince?: number;
}

/** Each activation is distinct, including two picks made in the same millisecond. */
export function updateChatChoice(previous: ChatChoice, observe: boolean, focus?: string, now = Date.now()): ChatChoice {
  const choice: ChatChoice = { observe, ...(focus ? { focus } : {}) };
  if (observe && !previous.observe) return { ...choice, selectionId: randomUUID(), observedSince: now };
  return previous.selectionId ? { ...choice, selectionId: previous.selectionId, observedSince: previous.observedSince } : choice;
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
      const selectionId = typeof choice.selectionId === 'string' && choice.selectionId.length <= 128 ? choice.selectionId : undefined;
      const since = choice.observedSince;
      const observedSince = typeof since === 'number' && Number.isSafeInteger(since) && since >= 0 ? since : undefined;
      file.chats[guid] = { observe: choice.observe === true, ...(focus ? { focus } : {}), ...(selectionId ? { selectionId, observedSince } : {}) };
    }
  }
  return file;
}

export function writeSelection(path: string, selection: MacSelectionFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // One temporary file per writer, so two saves at once cannot collide on the rename.
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temp, JSON.stringify(selection, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, path);
}

const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 10_000;

/**
 * Runs a read-change-write of the selection file while holding `<path>.lock`,
 * so two saves started at once (a tick and a focus edit) cannot undo each
 * other. A lock older than 10 seconds is left over from a crash and removed.
 */
export async function withSelectionLock<T>(path: string, change: () => T): Promise<T> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(lockPath, 'wx', 0o600));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) rmSync(lockPath, { force: true });
      } catch {
        // Removed by its owner meanwhile: try again.
      }
      if (Date.now() > deadline) throw new Error(`Another save of ${path} is still running.`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  try {
    return change();
  } finally {
    rmSync(lockPath, { force: true });
  }
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
      const info = statSync(this.path, { bigint: true });
      stamp = `${info.ino}:${info.mtimeNs}:${info.size}`;
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
    return this.selectionId(guid) !== undefined;
  }

  /** Empty id is a previously saved v1 pick. An absent id means the event is ineligible. */
  selectionId(guid: string, eventTime?: number): string | undefined {
    this.refresh();
    const choice = this.current.chats[guid];
    if (!choice?.observe) return undefined;
    if (eventTime !== undefined && choice.observedSince !== undefined && eventTime <= choice.observedSince) return undefined;
    return choice.selectionId ?? '';
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
