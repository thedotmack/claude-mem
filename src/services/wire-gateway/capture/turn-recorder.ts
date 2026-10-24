// SPDX-License-Identifier: Apache-2.0
//
// The raw recorder (plan Phase 5 task 3, design Part 7): one bounded line per
// captured exchange in `recordings/<UTC date>/<sha256(JSON([agent, session]))>/turns.jsonl`,
// written only with consent. Ported from magpie (MIT, Copyright (c) 2026
// yetone): `recordConversation` (internal/gateway/conversations.go:60-92),
// `saveGatewayTurn`, `gatewayCompleteSize` and `PruneGatewayConversations`
// (internal/sessions/gateway.go:89-311).
//
// The line holds magpie's GatewayTurn core fields
// {agent, session, time, model, status, input, output, cut?} plus
// claude-mem's own; magpie's reader ignores the extra fields, so one reader
// serves both formats. Headers are never stored. Every part kept is scrubbed
// first (plan Phase 6 task 2): secrets reach the file as `[REDACTED:KIND]`.
//
// Differences from magpie, on purpose: the consent generation is re-checked
// in the same synchronous block as the write (JavaScript has no other thread
// to interleave, so that block is the lock); the store-wide soft cap and
// retention are applied by an hourly cleanup, as magpie does, while a write
// past the per-session-day cap is refused at write time. The consent file is
// changed by another process (`claude-mem wire clear`), so the generation is
// looked at once more after the write: a line that landed after a clear began
// is taken back out.

import { createHash } from 'crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeSync,
  chmodSync,
  constants as fsConstants,
} from 'fs';
import { join } from 'path';
import { WIRE_GATEWAY_DIR_MODE, WIRE_GATEWAY_FILE_MODE, wireGatewaySubdirPath } from '../../../shared/paths.js';
import { logger } from '../../../utils/logger.js';
import type { WireRecorderPart } from '../ir/recorder-parts.js';
import type { WireUsage } from '../ir/types.js';
import type { WireRequestKind } from '../identity/request-kind.js';
import { scrubWireRecorderPart } from '../privacy/secret-scrub.js';
import { utf8CutIndex } from '../../../shared/utf8-cut.js';

/** Each direction (input, output) of a line keeps at most this many bytes of part text (magpie `bound`). */
export const RECORDED_DIRECTION_BUDGET_BYTES = 64 * 1024;
/** One part keeps at most this many bytes of text. */
export const RECORDED_PART_MAX_BYTES = 64 * 1024;
/** A line longer than this is not written (magpie `gatewayTurnMax`). */
export const RECORDED_LINE_MAX_BYTES = 1024 * 1024;
/** A session's file for one day stops growing here (magpie `gatewaySessionMax`). */
export const RECORDED_SESSION_DAY_MAX_BYTES = 256 * 1024 * 1024;
/** The whole store is pruned, oldest first, down to this (magpie `gatewayStoreMax`). */
export const RECORDED_STORE_SOFT_CAP_BYTES = 256 * 1024 * 1024;
/** magpie charges each part's bookkeeping against the budget too. */
const RECORDED_PART_OVERHEAD_BYTES = 128;
const RECORDING_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const TURNS_FILE_NAME = 'turns.jsonl';
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether raw recording is allowed, and its generation (the consent file,
 * privacy/recording-consent.ts). A request takes the generation
 * when it starts and is saved only if the generation is unchanged, so turning
 * recording off (or clearing it) cannot be refilled by requests in flight.
 */
export interface WireRecordingConsent {
  isRecordingOn(): boolean;
  recordingGeneration(): number;
}

export const WIRE_RECORDING_CONSENT_OFF: WireRecordingConsent = {
  isRecordingOn: () => false,
  recordingGeneration: () => 0,
};

/** One recorded exchange (magpie GatewayTurn plus claude-mem fields). */
export interface WireGatewayTurn {
  agent: string;
  session: string;
  /** When the request began, ISO 8601. */
  time: string;
  model: string;
  status: number;
  input: WireRecorderPart[];
  output: WireRecorderPart[];
  cut?: boolean;
  routeId: string;
  kind: WireRequestKind;
  subagent?: string;
  parentSession?: string;
  workDir?: string;
  usage?: WireUsage;
  requestId?: string;
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** `text` cut to at most `maxBytes` of UTF-8 on a character boundary, and how many characters were left off. */
function cutUtf8(text: string, maxBytes: number): { kept: string; charactersLeftOff: number } {
  const bytes = utf8Encoder.encode(text);
  const end = utf8CutIndex(bytes, Math.max(0, maxBytes));
  const kept = utf8Decoder.decode(bytes.subarray(0, end));
  return { kept, charactersLeftOff: [...text].length - [...kept].length };
}

/**
 * Bound one direction's parts (magpie `bound`): each direction has its own
 * 64 KiB budget, so history cannot crowd out the reply; one part keeps at
 * most 64 KiB. `prepare` (the scrub) runs on each part that is kept, before
 * it is cut, so a secret is never cut in half and left unrecognised. Returns
 * the parts and whether anything was cut.
 */
export function boundRecorderParts(
  parts: WireRecorderPart[],
  prepare: (part: WireRecorderPart) => WireRecorderPart = part => ({ ...part }),
): { parts: WireRecorderPart[]; cut: boolean } {
  let budgetLeft = RECORDED_DIRECTION_BUDGET_BYTES;
  let cut = false;
  const bounded: WireRecorderPart[] = [];
  for (const part of parts) {
    if (budgetLeft <= 0) {
      cut = true;
      break;
    }
    const boundedPart: WireRecorderPart = prepare(part);
    const allowedBytes = Math.min(budgetLeft, RECORDED_PART_MAX_BYTES);
    if (utf8ByteLength(boundedPart.text) > allowedBytes) {
      const { kept, charactersLeftOff } = cutUtf8(boundedPart.text, allowedBytes);
      boundedPart.text = kept;
      boundedPart.cut = (boundedPart.cut ?? 0) + charactersLeftOff;
      cut = true;
    }
    budgetLeft -= utf8ByteLength(boundedPart.text) + utf8ByteLength(boundedPart.name ?? '') + RECORDED_PART_OVERHEAD_BYTES;
    bounded.push(boundedPart);
  }
  return { parts: bounded, cut };
}

/** The folder name of one (agent, session): hex(sha256(JSON([agent, session]))) (magpie `gatewayIdentity`). */
export function recordedSessionFolderName(agent: string, session: string): string {
  return createHash('sha256').update(JSON.stringify([agent, session])).digest('hex');
}

function utcDateOf(isoTime: string): string {
  return isoTime.slice(0, 10);
}

/**
 * Where a file's complete lines end: a write cut off mid-line (a crash) is
 * dropped, never left to poison the lines after it (magpie `gatewayCompleteSize`).
 */
function completeLinesEnd(fileDescriptor: number, size: number): number {
  if (size === 0) return 0;
  const lastByte = Buffer.alloc(1);
  readSync(fileDescriptor, lastByte, 0, 1, size - 1);
  if (lastByte[0] === 0x0a) return size;
  const tailLength = Math.min(size, RECORDED_LINE_MAX_BYTES + 1);
  const tail = Buffer.alloc(tailLength);
  readSync(fileDescriptor, tail, 0, tailLength, size - tailLength);
  const lastNewline = tail.lastIndexOf(0x0a);
  if (lastNewline >= 0) return size - tailLength + lastNewline + 1;
  if (tailLength === size) return 0;
  throw new Error('unreadable wire recording: its last line is longer than a recorded line can be');
}

function ensurePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: WIRE_GATEWAY_DIR_MODE });
  if (process.platform !== 'win32') chmodSync(directory, WIRE_GATEWAY_DIR_MODE);
}

export interface WireTurnRecorderOptions {
  consent?: WireRecordingConsent;
  retentionDays: number;
  /** Test seam; defaults to <DATA_DIR>/wire-gateway/recordings. */
  recordingsDirectory?: string;
  /** Test seam: how often old days and the soft cap are applied; 0 runs cleanup only when asked. */
  cleanupIntervalMs?: number;
  now?: () => number;
}

export type WireTurnSaveOutcome =
  | 'saved'
  | 'recording_off'
  | 'generation_changed'
  | 'too_old'
  | 'line_too_long'
  | 'session_day_full'
  | 'failed';

export class WireTurnRecorder {
  readonly recordingsDirectory: string;
  /** Read when a request starts (its generation) and again before its turn is saved. */
  readonly consent: WireRecordingConsent;
  private readonly retentionDays: number;
  private readonly now: () => number;
  private readonly cleanupTimer: ReturnType<typeof setInterval> | null;

  constructor(options: WireTurnRecorderOptions) {
    this.consent = options.consent ?? WIRE_RECORDING_CONSENT_OFF;
    this.retentionDays = options.retentionDays;
    this.recordingsDirectory = options.recordingsDirectory ?? wireGatewaySubdirPath('recordings');
    this.now = options.now ?? Date.now;
    const cleanupIntervalMs = options.cleanupIntervalMs ?? RECORDING_CLEANUP_INTERVAL_MS;
    this.cleanupTimer = cleanupIntervalMs > 0 ? setInterval(() => this.pruneRecordings(), cleanupIntervalMs) : null;
    this.cleanupTimer?.unref?.();
  }

  /**
   * Bound and append one turn. Never throws: a failure is logged and the
   * reply, long gone to the client, is never touched.
   */
  save(turn: WireGatewayTurn, generationAtStart: number): WireTurnSaveOutcome {
    try {
      return this.saveOrThrow(turn, generationAtStart);
    } catch (error) {
      logger.warn('WIRE', 'Wire recording save failed', { agentId: turn.agent, routeId: turn.routeId },
        error instanceof Error ? error : new Error(String(error)));
      return 'failed';
    }
  }

  private saveOrThrow(turn: WireGatewayTurn, generationAtStart: number): WireTurnSaveOutcome {
    if (!this.consent.isRecordingOn() || this.consent.recordingGeneration() !== generationAtStart) {
      return this.consent.isRecordingOn() ? 'generation_changed' : 'recording_off';
    }
    if (Date.parse(turn.time) < this.now() - this.retentionDays * DAY_MS) return 'too_old';

    const input = boundRecorderParts(turn.input, scrubWireRecorderPart);
    const output = boundRecorderParts(turn.output, scrubWireRecorderPart);
    const boundedTurn: WireGatewayTurn = { ...turn, input: input.parts, output: output.parts };
    if (input.cut || output.cut || turn.cut) boundedTurn.cut = true;
    else delete boundedTurn.cut;
    const line = Buffer.from(`${JSON.stringify(boundedTurn)}\n`, 'utf8');
    if (line.length - 1 > RECORDED_LINE_MAX_BYTES) {
      logger.warn('WIRE', 'Wire recording line is over its size limit; not saved', { agentId: turn.agent, lineBytes: line.length });
      return 'line_too_long';
    }

    // From here to the write nothing yields, so the consent check below and
    // the append are one step: a consent change cannot land between them.
    if (!this.consent.isRecordingOn() || this.consent.recordingGeneration() !== generationAtStart) return 'generation_changed';
    const sessionDirectory = join(this.recordingsDirectory, utcDateOf(turn.time), recordedSessionFolderName(turn.agent, turn.session));
    ensurePrivateDirectory(this.recordingsDirectory);
    ensurePrivateDirectory(join(this.recordingsDirectory, utcDateOf(turn.time)));
    ensurePrivateDirectory(sessionDirectory);
    const turnsPath = join(sessionDirectory, TURNS_FILE_NAME);
    // Not O_APPEND: a cut-off last line is truncated away first, and the
    // line is written where the complete lines end (magpie saveGatewayTurn).
    const fileDescriptor = openSync(turnsPath, fsConstants.O_CREAT | fsConstants.O_RDWR, WIRE_GATEWAY_FILE_MODE);
    let lineTakenBack = false;
    try {
      if (process.platform !== 'win32') chmodSync(turnsPath, WIRE_GATEWAY_FILE_MODE);
      const size = fstatSync(fileDescriptor).size;
      const end = completeLinesEnd(fileDescriptor, size);
      if (end + line.length > RECORDED_SESSION_DAY_MAX_BYTES) {
        logger.warn('WIRE', 'Wire recording for this session and day is full; not saved', { agentId: turn.agent });
        return 'session_day_full';
      }
      if (end !== size) ftruncateSync(fileDescriptor, end);
      writeSync(fileDescriptor, line, 0, line.length, end);
      // A clear (another process) may have begun between the check above and
      // this write: take the line back out, so a clear is never refilled.
      if (!this.consent.isRecordingOn() || this.consent.recordingGeneration() !== generationAtStart) {
        ftruncateSync(fileDescriptor, end);
        lineTakenBack = true;
      }
    } finally {
      closeSync(fileDescriptor);
    }
    if (!lineTakenBack) return 'saved';
    // Removed after the close: Windows cannot unlink a file that is still open.
    if (statSync(turnsPath, { throwIfNoEntry: false })?.size === 0) {
      unlinkSync(turnsPath);
      removeDirectoryIfEmpty(sessionDirectory);
      removeDirectoryIfEmpty(join(sessionDirectory, '..'));
    }
    return 'generation_changed';
  }

  /**
   * Remove days past retention, then the oldest files while the store is
   * over its soft cap (magpie PruneGatewayConversations). Runs hourly, and
   * even while recording is off.
   */
  pruneRecordings(): void {
    try {
      this.pruneRecordingsOrThrow();
    } catch (error) {
      logger.warn('WIRE', 'Wire recording cleanup failed', { directory: this.recordingsDirectory },
        error instanceof Error ? error : new Error(String(error)));
    }
  }

  private pruneRecordingsOrThrow(): void {
    if (!existsSync(this.recordingsDirectory)) return;
    const generation = this.consent.recordingGeneration();
    const cutoff = this.now() - this.retentionDays * DAY_MS;
    interface RecordedFile { path: string; size: number; modifiedAt: number; expired: boolean }
    const files: RecordedFile[] = [];
    let totalBytes = 0;
    for (const dateName of readdirSync(this.recordingsDirectory)) {
      const dateStart = Date.parse(`${dateName}T00:00:00Z`);
      // A day is expired once all of it is older than the cutoff.
      const expired = Number.isFinite(dateStart) && dateStart + DAY_MS <= cutoff;
      const dateDirectory = join(this.recordingsDirectory, dateName);
      if (!statSync(dateDirectory).isDirectory()) continue;
      for (const sessionName of readdirSync(dateDirectory)) {
        const sessionDirectory = join(dateDirectory, sessionName);
        if (!statSync(sessionDirectory).isDirectory()) continue;
        for (const fileName of readdirSync(sessionDirectory)) {
          const filePath = join(sessionDirectory, fileName);
          const stats = statSync(filePath);
          if (!stats.isFile()) continue;
          files.push({ path: filePath, size: stats.size, modifiedAt: stats.mtimeMs, expired });
          totalBytes += stats.size;
        }
      }
    }
    files.sort((a, b) => (a.expired === b.expired ? a.modifiedAt - b.modifiedAt : a.expired ? -1 : 1));
    for (const file of files) {
      if (!file.expired && totalBytes <= RECORDED_STORE_SOFT_CAP_BYTES) continue;
      // Consent changed while this ran (a clear): its own clean-up owns the store now.
      if (this.consent.recordingGeneration() !== generation) return;
      try {
        unlinkSync(file.path);
        totalBytes -= file.size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      removeDirectoryIfEmpty(join(file.path, '..'));
      removeDirectoryIfEmpty(join(file.path, '..', '..'));
    }
  }

  dispose(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }
}

function removeDirectoryIfEmpty(directory: string): void {
  try {
    if (readdirSync(directory).length === 0) rmdirSync(directory);
  } catch {
    // Already gone, or a save just wrote into it: either way it stays as it is.
  }
}
