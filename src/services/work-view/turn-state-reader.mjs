// Finds a conversation's transcript under the agent tools' own folders and reads its turn state from the last bytes.
// Read-only and bounded: one stat per conversation per snapshot, a tail read only when the file changed, and nothing
// kept but the state. Paths are built from these roots and a UUID, never from recorded text.
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import zlib from 'node:zlib';
import { TURN_PLATFORMS, closedTurn, turnStateFromTail } from './turn-state.mjs';

const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A turn's closing records are small; one long final message still fits. */
export const TRANSCRIPT_TAIL_BYTES = 256 * 1024;
// Codex compresses a finished rollout whole, so its end is only reachable by decompressing all of it.
const MAX_COMPRESSED_BYTES = 32 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES = 256 * 1024 * 1024;
// A transcript that is not there yet (or was moved) is looked for again after this long.
const LOCATE_AGAIN_AFTER_MS = 30_000;
const MAX_CACHED_CONVERSATIONS = 2000;
const DAY_MS = 86_400_000;

const listing = (directory) => { try { return readdirSync(directory); } catch { return []; } };

/** The end of a transcript as text, or null when it cannot be read here. */
function tailText(path, size) {
  if (path.endsWith('.zst')) {
    // zlib.zstdDecompressSync exists only on newer runtimes (Node 22.15+, recent Bun). A named import would stop this
    // module loading on an older one, so it is looked up at call time, as transcripts/zstd-frames.ts does. Without
    // it a compressed rollout is skipped; plain transcripts read as before.
    const decompress = zlib.zstdDecompressSync;
    if (typeof decompress !== 'function' || size > MAX_COMPRESSED_BYTES) return null;
    const whole = decompress(readFileSync(path), { maxOutputLength: MAX_DECOMPRESSED_BYTES });
    return whole.subarray(Math.max(0, whole.length - TRANSCRIPT_TAIL_BYTES)).toString('utf8');
  }
  const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
  const buffer = Buffer.alloc(length);
  const file = openSync(path, 'r');
  try { return buffer.subarray(0, readSync(file, buffer, 0, length, size - length)).toString('utf8'); }
  finally { closeSync(file); }
}

export class TurnStateReader {
  constructor({
    claudeProjectsDir = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects'),
    codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'),
  } = {}) {
    this.claudeProjectsDir = claudeProjectsDir;
    this.codexHome = codexHome;
    // Codex moves a rollout here when the owner archives the chat, and back when they take it out.
    this.codexArchiveDir = join(codexHome, 'archived_sessions');
    this.cache = new Map();
  }

  /** Claude keeps one folder per project, each holding `<session id>.jsonl`. */
  locateClaude(sessionId) {
    for (const project of listing(this.claudeProjectsDir)) {
      const path = join(this.claudeProjectsDir, project, `${sessionId}.jsonl`);
      try { if (statSync(path).isFile()) return path; } catch { /* not in this project */ }
    }
    return null;
  }

  /** Codex files a rollout under the local day it started, later compresses it, and moves it on archive. A session id
   * is a UUIDv7, so its first 48 bits give that day to within the time zone. */
  locateCodex(sessionId) {
    const startedAt = parseInt(sessionId.replace(/-/g, '').slice(0, 12), 16);
    const days = [-DAY_MS, 0, DAY_MS].map((shift) => new Date(startedAt + shift).toISOString().slice(0, 10).split('-'));
    const directories = [...days.map((day) => join(this.codexHome, 'sessions', ...day)), this.codexArchiveDir];
    const suffixes = [`-${sessionId}.jsonl`, `-${sessionId}.jsonl.zst`];
    for (const directory of directories) {
      const name = listing(directory).find((entry) => entry.startsWith('rollout-') && suffixes.some((suffix) => entry.endsWith(suffix)));
      if (name) return join(directory, name);
    }
    return null;
  }

  /**
   * The turn state of one conversation, or null when it cannot be told. After `deadline` (epoch ms) nothing new is
   * read from disk: the last known state stands until a later call.
   */
  read(platform, sessionId, { deadline = Infinity } = {}) {
    if (!TURN_PLATFORMS.includes(platform) || typeof sessionId !== 'string' || !SESSION_UUID.test(sessionId)) return null;
    const key = `${platform}:${sessionId.toLowerCase()}`;
    let entry = this.cache.get(key);
    const now = Date.now();
    if (!entry?.path) {
      if (entry && now - entry.lookedAt < LOCATE_AGAIN_AFTER_MS) return null;
      if (now > deadline) return null;
      if (this.cache.size >= MAX_CACHED_CONVERSATIONS) this.cache.clear();
      entry = { path: platform === 'claude' ? this.locateClaude(sessionId) : this.locateCodex(sessionId.toLowerCase()), lookedAt: now, signature: null, state: null };
      this.cache.set(key, entry);
      if (!entry.path) return null;
    }
    let stat;
    try { stat = statSync(entry.path); }
    catch {
      // Compressed or archived since: look for it again on the next call.
      this.cache.delete(key);
      return null;
    }
    const signature = `${stat.size}:${stat.mtimeMs}`;
    if (signature === entry.signature) return entry.state;
    if (now > deadline) return entry.state;
    let state = null;
    try {
      const tail = tailText(entry.path, stat.size);
      state = tail === null ? null : turnStateFromTail(platform, tail);
    } catch { state = null; }
    // Where the rollout is filed says the chat is closed, whatever it ended on and even when its end cannot be read.
    if (platform === 'codex' && dirname(entry.path) === this.codexArchiveDir) state = closedTurn(state);
    // A record without a time of its own is dated by the file's last write.
    entry.state = state && state.atEpoch === null ? { ...state, atEpoch: Math.round(stat.mtimeMs) } : state;
    entry.signature = signature;
    return entry.state;
  }

  /** The turn state of the conversation a key names (`["conversation", "<platform>", "<session id>"]`). */
  readConversation(conversationKey, options) {
    let key;
    try { key = JSON.parse(conversationKey); } catch { return null; }
    return Array.isArray(key) && key[0] === 'conversation' && key.length === 3 ? this.read(key[1], key[2], options) : null;
  }
}
