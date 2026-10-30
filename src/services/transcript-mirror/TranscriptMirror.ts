// SPDX-License-Identifier: Apache-2.0
//
// Full chat transcripts, kept by claude-mem itself. Modeled on Grok Bot's transcript journal
// (sand host `src/host/transcript-mirror/transcript-mirror.ts` and `transcript-journal-codec.ts`,
// preserved in thedotmack/grok-bot-backups):
//
// - one append-only JSONL file per conversation, `<root>/<source>/<key>/<key>.jsonl`, in Grok
//   Bot's line envelope `{ role, message: { content: [...] } }`;
// - every append is written in two steps. `prepare` installs `<key>.journal-pending.json`
//   atomically (temp file, fsync, rename) holding the lines and the byte offset they go at;
//   `commit` writes them at that offset, fsyncs, records the new size in
//   `<key>.journal-cursor.json` and removes the pending file. A crash anywhere in between is
//   finished on the next open by cutting the file back to the offset and writing the same lines
//   again, so a transcript never ends in half a line or holds a message twice;
// - the file is refused, not repaired, when it changed outside the journal (size, inode or
//   modification time differ from the cursor and nothing is pending).
//
// Three differences from Grok Bot, on purpose: tool results are kept (Grok Bot's mirror wrote only
// the tool name); every line carries the source message id, which is how a resend of a message
// already kept is recognised; and the folder name is a readable prefix plus a hash of the id, where
// Grok Bot's `encodeURIComponent` with `%` → `_` gives `a/b` and `a_2Fb` the same folder and can
// outgrow a file name's length limit. Nothing here is ever cut, pruned or summarised: the point is the whole
// transcript. Only `<private>` blocks are removed, the same promise every other claude-mem capture
// keeps.

import { createHash, randomUUID } from 'crypto';
import { constants as fsConstants } from 'fs';
import { mkdir, open, readFile, readdir, rename, stat, unlink, type FileHandle } from 'fs/promises';
import { dirname, join } from 'path';
import { IS_WINDOWS_PLATFORM } from '../../shared/atomic-json.js';
import { removeTagBlocks } from '../../utils/tag-stripping.js';

export const TRANSCRIPT_MIRROR_DIR_MODE = 0o700;
export const TRANSCRIPT_MIRROR_FILE_MODE = 0o600;

const SOURCE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_CONVERSATION_ID_LENGTH = 200;
const MAX_TITLE_LENGTH = 500;

export type MirrorToolCall = { id: string; name: string; args?: unknown };

/** One message as a source hands it over. `id` must be stable across resends. */
export type MirrorMessage = {
  id: string;
  role: string;
  /** A string, or the source's structured content (kept as-is). */
  content?: unknown;
  name?: string;
  toolCalls?: MirrorToolCall[];
  /** For a tool result: the call it answers. */
  toolCallId?: string;
  createdAt?: string;
};

export type MirrorContentPart =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; name?: string; result: unknown }
  | { type: 'content'; value: unknown };

/** One line of a transcript file. */
export type MirrorLine = {
  id: string;
  role: string;
  name?: string;
  ts: string;
  message: { content: MirrorContentPart[] };
};

export type TranscriptCursor = {
  version: 1;
  source: string;
  conversationId: string;
  title: string | null;
  messageCount: number;
  bytes: number;
  device: string;
  inode: string;
  /** Modification time in nanoseconds: an edit that keeps the size still changes it. */
  mtimeNs: string;
  createdAt: string;
  updatedAt: string;
};

type PendingCheckpoint = {
  version: 1;
  appendOffset: number;
  device: string;
  inode: string;
  lines: string[];
  cursor: Omit<TranscriptCursor, 'bytes' | 'device' | 'inode' | 'mtimeNs'>;
};

export type AppendResult = {
  source: string;
  conversationId: string;
  appended: number;
  skipped: number;
  messageCount: number;
  bytes: number;
};

export type TranscriptSummary = Omit<TranscriptCursor, 'version' | 'device' | 'inode' | 'mtimeNs'>;

export class TranscriptMirrorError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid_input' | 'changed_outside' | 'corrupt' | 'not_found',
  ) {
    super(message);
    this.name = 'TranscriptMirrorError';
  }
}

/**
 * The folder and file name for a conversation: up to 48 readable characters of the id, then 16 hex
 * characters of its SHA-256, so two ids never share a folder and the name always fits.
 */
export function conversationKey(conversationId: string): string {
  if (typeof conversationId !== 'string' || conversationId.length === 0 || conversationId.length > MAX_CONVERSATION_ID_LENGTH) {
    throw new TranscriptMirrorError(`conversation id must be 1 to ${MAX_CONVERSATION_ID_LENGTH} characters`, 'invalid_input');
  }
  if (conversationId !== conversationId.trim() || conversationId.includes('\0')) {
    throw new TranscriptMirrorError('conversation id has surrounding spaces or a NUL', 'invalid_input');
  }
  const readable = conversationId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 48);
  const hash = createHash('sha256').update(conversationId, 'utf8').digest('hex').slice(0, 16);
  return `${readable}-${hash}`;
}

export function assertSource(source: string): void {
  if (typeof source !== 'string' || !SOURCE_PATTERN.test(source)) {
    throw new TranscriptMirrorError('source must be lowercase letters, digits, dot, dash or underscore (max 64)', 'invalid_input');
  }
}

function stripPrivate<T>(value: T): T {
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return node.includes('<') ? removeTagBlocks(node, ['private']) : node;
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, walk(child)]));
    }
    return node;
  };
  return walk(value) as T;
}

function parseArgs(args: unknown): unknown {
  if (typeof args !== 'string') return args ?? {};
  if (args.trim() === '') return {};
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

/** A message as one transcript line, in Grok Bot's envelope plus the id and tool results. */
export function toMirrorLine(message: MirrorMessage, now: string): MirrorLine {
  const content: MirrorContentPart[] = [];
  if (message.role === 'tool') {
    // Decoded before stripping: JSON can spell the tag as \u003cprivate\u003e, which only reads
    // as `<private>` once parsed.
    const result = typeof message.content === 'string' ? parseArgs(message.content) : message.content;
    content.push({
      type: 'tool_result',
      tool_use_id: message.toolCallId ?? '',
      ...(message.name ? { name: message.name } : {}),
      result: stripPrivate(result ?? null),
    });
    return lineFor(message, now, content);
  }
  const body = stripPrivate(message.content);
  if (typeof body === 'string') {
    if (body.length > 0) content.push({ type: 'text', text: body });
  } else if (Array.isArray(body)) {
    for (const part of body) {
      if (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string') {
        content.push({ type: 'text', text: (part as { text: string }).text });
      } else {
        content.push({ type: 'content', value: part });
      }
    }
  } else if (body !== undefined && body !== null) {
    content.push({ type: 'content', value: body });
  }
  for (const call of message.toolCalls ?? []) {
    content.push({ type: 'tool_use', id: call.id, name: call.name, input: stripPrivate(parseArgs(call.args)) });
  }
  return lineFor(message, now, content);
}

function lineFor(message: MirrorMessage, now: string, content: MirrorContentPart[]): MirrorLine {
  return {
    id: message.id,
    role: message.role,
    ...(message.name && message.role !== 'tool' ? { name: message.name } : {}),
    ts: message.createdAt ?? now,
    message: { content },
  };
}

function fileIdentity(stats: { size: bigint; dev: bigint; ino: bigint; mtimeNs: bigint }) {
  return { size: Number(stats.size), device: String(stats.dev), inode: String(stats.ino), mtimeNs: String(stats.mtimeNs) };
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function writeAll(handle: FileHandle, bytes: Buffer, position: number): Promise<number> {
  let written = 0;
  while (written < bytes.byteLength) {
    const result = await handle.write(bytes, written, bytes.byteLength - written, position + written);
    if (result.bytesWritten === 0) throw new TranscriptMirrorError('transcript write made no progress', 'corrupt');
    written += result.bytesWritten;
  }
  return position + written;
}

export class TranscriptMirror {
  private readonly chains = new Map<string, Promise<unknown>>();
  /** Message ids already in each file, loaded once per process. */
  private readonly seen = new Map<string, Set<string>>();

  constructor(readonly root: string) {}

  private dirFor(source: string, safeId: string): string {
    return join(this.root, source, safeId);
  }
  jsonlPathFor(source: string, conversationId: string): string {
    assertSource(source);
    const id = conversationKey(conversationId);
    return join(this.dirFor(source, id), `${id}.jsonl`);
  }
  private pendingPathFor(source: string, id: string): string {
    return join(this.dirFor(source, id), `${id}.journal-pending.json`);
  }
  private cursorPathFor(source: string, id: string): string {
    return join(this.dirFor(source, id), `${id}.journal-cursor.json`);
  }

  /** One conversation's operations run one at a time, in arrival order. */
  private serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    const settled = next.catch(() => undefined);
    this.chains.set(key, settled);
    void settled.then(() => {
      if (this.chains.get(key) === settled) this.chains.delete(key);
    });
    return next;
  }

  private async syncDir(path: string): Promise<void> {
    // Windows cannot open a folder to fsync it (atomic-json skips it the same way); NTFS journals
    // the rename itself.
    if (IS_WINDOWS_PLATFORM) return;
    const handle = await open(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  /** Creates the conversation's folder, syncing each newly made folder into its parent. */
  private async ensureDir(source: string, id: string): Promise<void> {
    const missing: string[] = [];
    for (const dir of [this.root, join(this.root, source), this.dirFor(source, id)]) {
      try {
        await stat(dir);
      } catch (error) {
        if (!isMissing(error)) throw error;
        missing.push(dir);
      }
    }
    if (missing.length === 0) return;
    await mkdir(this.dirFor(source, id), { recursive: true, mode: TRANSCRIPT_MIRROR_DIR_MODE });
    for (const dir of missing) await this.syncDir(dirname(dir));
  }

  private async installAtomicFile(path: string, content: string): Promise<void> {
    const temporary = join(dirname(path), `.transcript.${randomUUID()}.part`);
    const handle = await open(temporary, 'wx', TRANSCRIPT_MIRROR_FILE_MODE);
    try {
      await writeAll(handle, Buffer.from(content, 'utf8'), 0);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    await this.syncDir(dirname(path));
  }

  private async readJson<T>(path: string): Promise<T | null> {
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new TranscriptMirrorError(`${path} is not valid JSON`, 'corrupt');
    }
  }

  /** Writes `lines` at `offset`, cutting anything after it first. Returns the file's identity after. */
  private async writeAt(path: string, offset: number, lines: string[]) {
    const handle = await open(path, fsConstants.O_RDWR | fsConstants.O_CREAT, TRANSCRIPT_MIRROR_FILE_MODE);
    try {
      await handle.truncate(offset);
      const bytes = Buffer.from(lines.map((line) => `${line}\n`).join(''), 'utf8');
      await writeAll(handle, bytes, offset);
      await handle.sync();
      return fileIdentity(await handle.stat({ bigint: true }));
    } finally {
      await handle.close();
    }
  }

  private async commitPending(source: string, id: string, pending: PendingCheckpoint): Promise<TranscriptCursor> {
    const jsonl = join(this.dirFor(source, id), `${id}.jsonl`);
    const after = await this.writeAt(jsonl, pending.appendOffset, pending.lines);
    const cursor: TranscriptCursor = {
      ...pending.cursor,
      version: 1,
      bytes: after.size,
      device: after.device,
      inode: after.inode,
      mtimeNs: after.mtimeNs,
    };
    await this.installAtomicFile(this.cursorPathFor(source, id), JSON.stringify(cursor));
    await unlink(this.pendingPathFor(source, id)).catch((error) => {
      if (!isMissing(error)) throw error;
    });
    await this.syncDir(this.dirFor(source, id));
    return cursor;
  }

  /**
   * Finishes a write a crash interrupted, then checks the file is the one the cursor describes.
   * Returns the cursor, or null for a conversation never written.
   */
  private async recover(source: string, id: string): Promise<TranscriptCursor | null> {
    const jsonl = join(this.dirFor(source, id), `${id}.jsonl`);
    const pending = await this.readJson<PendingCheckpoint>(this.pendingPathFor(source, id));
    let current: ReturnType<typeof fileIdentity> | null = null;
    try {
      current = fileIdentity(await stat(jsonl, { bigint: true }));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (pending) {
      if (pending.version !== 1 || !Array.isArray(pending.lines) || !Number.isSafeInteger(pending.appendOffset)) {
        throw new TranscriptMirrorError('pending transcript checkpoint is invalid', 'corrupt');
      }
      const size = current?.size ?? 0;
      if (size < pending.appendOffset) {
        throw new TranscriptMirrorError('transcript is shorter than its pending checkpoint expects', 'changed_outside');
      }
      if (current && pending.appendOffset > 0 && (current.device !== pending.device || current.inode !== pending.inode)) {
        throw new TranscriptMirrorError('transcript was replaced while a write was pending', 'changed_outside');
      }
      this.seen.delete(`${source}/${id}`);
      return this.commitPending(source, id, pending);
    }
    const cursor = await this.readJson<TranscriptCursor>(this.cursorPathFor(source, id));
    if (!cursor) {
      if (current && current.size > 0) {
        throw new TranscriptMirrorError('transcript exists without its journal cursor', 'changed_outside');
      }
      return null;
    }
    if (
      !current ||
      current.size !== cursor.bytes ||
      current.device !== cursor.device ||
      current.inode !== cursor.inode ||
      current.mtimeNs !== cursor.mtimeNs
    ) {
      throw new TranscriptMirrorError('transcript changed outside the journal', 'changed_outside');
    }
    return cursor;
  }

  private async seenIds(source: string, id: string, cursor: TranscriptCursor | null): Promise<Set<string>> {
    const key = `${source}/${id}`;
    const cached = this.seen.get(key);
    if (cached) return cached;
    const ids = new Set<string>();
    if (cursor) {
      for (const line of await this.readLines(join(this.dirFor(source, id), `${id}.jsonl`))) ids.add(line.id);
    }
    this.seen.set(key, ids);
    return ids;
  }

  private async readLines(path: string): Promise<MirrorLine[]> {
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const lines: MirrorLine[] = [];
    for (const text of raw.split('\n')) {
      if (!text) continue;
      try {
        lines.push(JSON.parse(text) as MirrorLine);
      } catch {
        throw new TranscriptMirrorError(`${path} holds a line that is not JSON`, 'corrupt');
      }
    }
    return lines;
  }

  /**
   * Adds every message not already kept, in the order given, and the title when it changed.
   * A message id already in the file is skipped, so a source may resend a whole conversation.
   */
  async append(input: { source: string; conversationId: string; title?: string | null; messages: MirrorMessage[] }): Promise<AppendResult> {
    assertSource(input.source);
    const id = conversationKey(input.conversationId);
    for (const message of input.messages) {
      if (!message || typeof message.id !== 'string' || !message.id || typeof message.role !== 'string' || !message.role) {
        throw new TranscriptMirrorError('every message needs a non-empty id and role', 'invalid_input');
      }
    }
    const title = input.title === undefined ? undefined : input.title === null ? null : String(input.title).slice(0, MAX_TITLE_LENGTH);
    return this.serialize(`${input.source}/${id}`, async () => {
      await this.ensureDir(input.source, id);
      const cursor = await this.recover(input.source, id);
      if (cursor && cursor.conversationId !== input.conversationId) {
        throw new TranscriptMirrorError('this folder holds another conversation', 'corrupt');
      }
      const seen = await this.seenIds(input.source, id, cursor);
      const now = new Date().toISOString();
      const fresh: MirrorMessage[] = [];
      const batch = new Set<string>();
      for (const message of input.messages) {
        if (seen.has(message.id) || batch.has(message.id)) continue;
        batch.add(message.id);
        fresh.push(message);
      }
      const nextTitle = title === undefined ? (cursor?.title ?? null) : title;
      const result = (bytes: number, count: number): AppendResult => ({
        source: input.source,
        conversationId: input.conversationId,
        appended: fresh.length,
        skipped: input.messages.length - fresh.length,
        messageCount: count,
        bytes,
      });
      if (fresh.length === 0 && cursor && nextTitle === cursor.title) return result(cursor.bytes, cursor.messageCount);
      if (fresh.length === 0 && !cursor && nextTitle === null) return result(0, 0);

      const jsonl = join(this.dirFor(input.source, id), `${id}.jsonl`);
      let identity: { bytes: number; device: string; inode: string };
      if (cursor) {
        identity = cursor;
      } else {
        const created = await this.writeAt(jsonl, 0, []);
        identity = { bytes: 0, device: created.device, inode: created.inode };
      }
      const pending: PendingCheckpoint = {
        version: 1,
        appendOffset: identity.bytes,
        device: identity.device,
        inode: identity.inode,
        lines: fresh.map((message) => JSON.stringify(toMirrorLine(message, now))),
        cursor: {
          version: 1,
          source: input.source,
          conversationId: input.conversationId,
          title: nextTitle,
          messageCount: (cursor?.messageCount ?? 0) + fresh.length,
          createdAt: cursor?.createdAt ?? now,
          updatedAt: now,
        },
      };
      await this.installAtomicFile(this.pendingPathFor(input.source, id), JSON.stringify(pending));
      const committed = await this.commitPending(input.source, id, pending);
      for (const message of fresh) seen.add(message.id);
      return result(committed.bytes, committed.messageCount);
    });
  }

  /** The whole transcript, oldest line first. */
  async read(source: string, conversationId: string): Promise<{ summary: TranscriptSummary; lines: MirrorLine[] }> {
    assertSource(source);
    const id = conversationKey(conversationId);
    return this.serialize(`${source}/${id}`, async () => {
      let cursor: TranscriptCursor | null;
      try {
        cursor = await this.recover(source, id);
      } catch (error) {
        if (isMissing(error)) cursor = null;
        else throw error;
      }
      if (!cursor || cursor.conversationId !== conversationId) {
        throw new TranscriptMirrorError('no transcript is kept for this conversation', 'not_found');
      }
      const { version: _version, device: _device, inode: _inode, mtimeNs: _mtimeNs, ...summary } = cursor;
      return { summary, lines: await this.readLines(join(this.dirFor(source, id), `${id}.jsonl`)) };
    });
  }

  /** Every kept conversation, newest first. Cursors only; transcripts are not opened. */
  async list(source?: string): Promise<TranscriptSummary[]> {
    if (source !== undefined) assertSource(source);
    const sources = source !== undefined ? [source] : await readdir(this.root).catch((error) => (isMissing(error) ? [] : Promise.reject(error)));
    const summaries: TranscriptSummary[] = [];
    for (const name of sources) {
      if (!SOURCE_PATTERN.test(name)) continue;
      const ids = await readdir(join(this.root, name)).catch((error) => (isMissing(error) ? [] : Promise.reject(error)));
      for (const id of ids) {
        const cursor = await this.readJson<TranscriptCursor>(this.cursorPathFor(name, id)).catch(() => null);
        if (!cursor) continue;
        const { version: _version, device: _device, inode: _inode, mtimeNs: _mtimeNs, ...summary } = cursor;
        summaries.push(summary);
      }
    }
    return summaries.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  }
}
