// SPDX-License-Identifier: Apache-2.0
//
// The magpie recordings follower (plan Phase 13 task 3): magpie's own
// recorder writes one line per exchange to
// `<magpie config>/gateway-conversations/<UTC date>/<sha256(JSON([agent, session]))>/turns.jsonl`
// (magpie internal/sessions/gateway.go:49-160, MIT, Copyright (c) 2026
// yetone); this follows those files into claude-mem's capture.
//
// - It polls every 2 s (magpie polls its session stores at the same pace,
//   usage/otel.go `OTelSessionsEvery`). No fs.watch: it misses writes on
//   macOS while a writer holds the file open (report 08, Bun #44051).
// - It reads complete lines only, at most 8 MiB per poll across all files
//   (magpie sessions/traces.go:178 `budget`), so one big session cannot hold
//   the others up. A partial last line waits for the next poll.
// - Where it got to is kept in `state/magpie-follower.json`: per file, the
//   offset of the next unread line and the file's inode. Another inode at
//   the same path (the file was replaced) or a file shorter than the offset
//   (truncated) is read again from its start.
// - With no state yet, it starts at the end of every file there is (nothing
//   recorded before claude-mem began following is replayed), unless
//   `claude-mem wire magpie enable --backfill` asked for the beginning. A
//   file that appears later is new, and read whole.
// - Only the follower writes its state. `wire magpie enable` leaves a request
//   beside it (`magpie-follower.json.pending`): start from now (each file's
//   end when enable ran) or, with --backfill, from the start. The follower
//   takes it up at its next look when it follows the folder it names, else
//   when a gateway following that folder starts. A from-now request for a
//   folder the follower already has state for changes nothing: it goes on
//   from where it got to, so no unread line is skipped. A request is claimed
//   by renaming it to `.pending.<pid>.taking`; a claim a crash left behind is
//   taken up at the next look, and the id of the request applied is written
//   with the state, so none is applied twice. A request that cannot be read
//   is reported once and left; following goes on.
// - Symlinks are not followed (a dated folder, a session folder or a
//   turns.jsonl that is one is skipped, and said once): magpie writes plain
//   folders and files, and a link could lead into claude-mem's own data.
// - Each line is decided FOREIGN_SOURCE_SETTLE_MS after the follower first
//   sees it (when that was is kept with the state), so magpie's OTLP copy of
//   the same call has arrived by then; the line is skipped when magpie's (or
//   the agent's own) spans for its agent did (foreign-capture.ts rule 3).
//   Lines first seen on a run's first look were written while claude-mem was
//   not running, and are taken at once. An agent claude-mem captures another
//   way (a wire route, its native integration) is skipped.

import { randomUUID } from 'crypto';
import { closeSync, existsSync, lstatSync, openSync, readSync, readdirSync, renameSync, statSync, unlinkSync } from 'fs';
import { basename, dirname, join, relative, resolve, sep } from 'path';
import { homedir } from 'os';
import { physicalPathOf, readJsonFileWithBom, writeJsonFileAtomic } from '../../../shared/atomic-json.js';
import { WIRE_GATEWAY_DIR, WIRE_GATEWAY_FILE_MODE, paths } from '../../../shared/paths.js';
import { logger } from '../../../utils/logger.js';
import type { WireRecorderPart } from '../ir/recorder-parts.js';
import type { WireUsage } from '../ir/types.js';
import { foreignExchangeOf, parseJsonText, type ForeignMessage, type ForeignPart } from './foreign-exchange.js';
import {
  claudeMemAgentIdOfMagpieAgent,
  type CaptureSourceRuleOptions,
  type ForeignDeliverySnapshot,
  type OtherCaptureSourceCheck,
  type RecordingSighting,
  type WireForeignCapture,
} from './foreign-capture.js';

/** How often the follower looks (plan Phase 13 task 3; magpie usage/otel.go `OTelSessionsEvery`). */
export const MAGPIE_FOLLOWER_POLL_INTERVAL_MS = 2_000;
/** The most bytes read per poll, across every file (plan Phase 13 task 3; magpie sessions/traces.go:178). */
export const MAGPIE_FOLLOWER_MAX_BYTES_PER_POLL = 8 * 1024 * 1024;
const TURNS_FILE_NAME = 'turns.jsonl';
const DATE_DIRECTORY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const STATE_VERSION = 1;

/** Where magpie keeps its recordings: `$XDG_CONFIG_HOME/magpie` (when absolute) else `~/.config/magpie` (magpie internal/appdir/appdir.go:226-234), then `gateway-conversations`. */
export function defaultMagpieRecordingsDirectory(environment: { env: NodeJS.ProcessEnv; home: string } = { env: process.env, home: homedir() }): string {
  const xdgConfigHome = environment.env.XDG_CONFIG_HOME;
  const configDirectory = xdgConfigHome && resolve(xdgConfigHome) === xdgConfigHome
    ? join(xdgConfigHome, 'magpie')
    : join(environment.home, '.config', 'magpie');
  return join(configDirectory, 'gateway-conversations');
}

/** Throws when `directory` is claude-mem's own wire-gateway data: following it would capture claude-mem's own recordings again. */
export function assertNotClaudeMemRecordings(directory: string, wireGatewayDirectory: string = WIRE_GATEWAY_DIR): void {
  // Physical paths: a symlink to (or into) claude-mem's data is that data.
  const resolved = physicalPathOf(resolve(directory));
  const own = physicalPathOf(resolve(wireGatewayDirectory));
  if (resolved === own || resolved.startsWith(own + sep) || own.startsWith(resolved + sep)) {
    throw new Error(`${directory} holds claude-mem's own wire recordings; the magpie follower reads magpie's gateway-conversations folder only`);
  }
}

interface SeenRegion {
  /** The file's size when these bytes were first seen: every line ending at or before it was seen by `at`. */
  end: number;
  /** When (ms). */
  at: number;
  /** Written while claude-mem was not running, or asked for by --backfill: taken without waiting (foreign-capture.ts rule 3). */
  unattended?: true;
}

interface FollowedFileState {
  /** As a decimal string: an inode can pass 2^53 (statSync bigint). */
  inode: string;
  offset: number;
  /** A line longer than a whole poll's budget is being skipped up to its newline. */
  discardingUntilNewline?: boolean;
  /** Bytes past `offset` seen but not yet decided, oldest first (the follower waits the settle time before deciding a line). */
  seen?: SeenRegion[];
}

interface MagpieFollowerStateFile {
  version: number;
  directory: string;
  /** Keyed by the path relative to the directory. */
  files: Record<string, FollowedFileState>;
  /** The last `wire magpie enable` request taken up, so one taken up already is never applied twice. */
  takenRequestId?: string;
  /** When magpie's (and agents' own) OTLP spans arrived, as far back as an undecided line needs: lines seen before a restart are decided as they would have been. */
  deliveries?: ForeignDeliverySnapshot;
}

/** What `wire magpie enable` asks of the follower (`magpie-follower.json.pending`). */
interface MagpieFollowerRequestFile {
  version: number;
  requestId: string;
  directory: string;
  /** Start every file from its beginning. Without it, the request only says where a follower that has no state for the folder starts. */
  backfill: boolean;
  /** Without backfill: each file's end when enable ran, where a new follower starts. */
  files: Record<string, { inode: string; offset: number }>;
}

/** Symlinks met under the folder, said once each (they are not followed). */
const reportedSymlinks = new Set<string>();

/** Whether `path` is a plain folder (or file); a symlink is reported once and is neither. */
function isPlain(path: string, kind: 'directory' | 'file'): boolean {
  const stats = lstatSync(path, { throwIfNoEntry: false });
  if (!stats) return false;
  if (stats.isSymbolicLink()) {
    if (!reportedSymlinks.has(path)) {
      reportedSymlinks.add(path);
      magpieFollowerActivity.symlinksSkipped++;
      logger.warn('WIRE', 'magpie recordings: a symlink is not followed (magpie writes plain folders and files)', { path });
    }
    return false;
  }
  return kind === 'directory' ? stats.isDirectory() : stats.isFile();
}

function turnsFilesUnder(directory: string): string[] {
  const relativePaths: string[] = [];
  for (const dateName of readdirSync(directory).sort()) {
    if (!DATE_DIRECTORY_PATTERN.test(dateName)) continue;
    const dateDirectory = join(directory, dateName);
    if (!isPlain(dateDirectory, 'directory')) continue;
    for (const sessionName of readdirSync(dateDirectory).sort()) {
      const sessionDirectory = join(dateDirectory, sessionName);
      if (!isPlain(sessionDirectory, 'directory')) continue;
      const turnsPath = join(sessionDirectory, TURNS_FILE_NAME);
      if (isPlain(turnsPath, 'file')) relativePaths.push(relative(directory, turnsPath));
    }
  }
  return relativePaths;
}

function inodeOf(filePath: string): { inode: string; size: number } {
  const stats = statSync(filePath, { bigint: true });
  return { inode: stats.ino.toString(), size: Number(stats.size) };
}

/** Each file's end now (its complete lines'), where a follower that starts from now begins. */
function endsOfFilesIn(directory: string): Record<string, { inode: string; offset: number }> {
  const files: Record<string, { inode: string; offset: number }> = {};
  if (!existsSync(directory)) return files;
  for (const relativePath of turnsFilesUnder(directory)) {
    const { inode, size } = inodeOf(join(directory, relativePath));
    files[relativePath] = { inode, offset: completeLinesEndOf(join(directory, relativePath), size) };
  }
  return files;
}

/** A follower state that reads every file there is from its end, or (backfill) from its start: every file is new to an empty state. */
export function startingMagpieFollowerState(directory: string, backfill: boolean): MagpieFollowerStateFile {
  return { version: STATE_VERSION, directory: resolve(directory), files: backfill ? {} : endsOfFilesIn(directory) };
}

export function writeMagpieFollowerState(state: MagpieFollowerStateFile, statePath: string = paths.wireGatewayMagpieFollowerState()): void {
  writeJsonFileAtomic(statePath, state, { mode: WIRE_GATEWAY_FILE_MODE });
}

/** Where `wire magpie enable` puts its request: beside the follower's own state, which only the follower writes. */
export function pendingMagpieFollowerStatePath(statePath: string = paths.wireGatewayMagpieFollowerState()): string {
  return `${statePath}.pending`;
}

/** What `wire magpie enable` asks: start from now (each file's end now), or from the start (backfill). */
export function magpieFollowerRequest(directory: string, backfill: boolean): MagpieFollowerRequestFile {
  return { version: STATE_VERSION, requestId: randomUUID(), directory: resolve(directory), backfill, files: backfill ? {} : endsOfFilesIn(directory) };
}

/** `wire magpie enable`: leave the request for the follower (at its next look, or when a gateway following that folder starts). */
export function requestMagpieFollowerState(request: MagpieFollowerRequestFile, statePath: string = paths.wireGatewayMagpieFollowerState()): void {
  writeJsonFileAtomic(pendingMagpieFollowerStatePath(statePath), request, { mode: WIRE_GATEWAY_FILE_MODE });
}

/** The follower's state file, checked. Throws on one that is not a follower state: unreadable state is reported, never read as empty. */
function readMagpieFollowerStateFile(filePath: string): MagpieFollowerStateFile {
  const stored = readJsonFileWithBom<Partial<MagpieFollowerStateFile>>(filePath);
  if (stored?.version !== STATE_VERSION || typeof stored.files !== 'object' || stored.files === null || typeof stored.directory !== 'string') {
    throw new Error(`${filePath} is not a magpie follower state (version ${STATE_VERSION}); fix or delete it (deleting starts at the end of every file)`);
  }
  return stored as MagpieFollowerStateFile;
}

/** A request file, checked. Throws, saying what to do about this file, on one `wire magpie enable` did not write. */
function readMagpieFollowerRequestFile(filePath: string): MagpieFollowerRequestFile {
  const stored = readJsonFileWithBom<Partial<MagpieFollowerRequestFile>>(filePath);
  if (stored?.version !== STATE_VERSION || typeof stored.requestId !== 'string' || typeof stored.directory !== 'string'
    || typeof stored.backfill !== 'boolean' || typeof stored.files !== 'object' || stored.files === null) {
    throw new Error(`${filePath} is not a request from \`claude-mem wire magpie enable\` (version ${STATE_VERSION}); the follower goes on from where it is and leaves the file alone. Run \`claude-mem wire magpie enable\` again to replace it, or delete it`);
  }
  return stored as MagpieFollowerRequestFile;
}

/** Where a file's complete lines end at `size` (a partial last line is read once it is whole). */
function completeLinesEndOf(filePath: string, size: number): number {
  if (size === 0) return 0;
  const fileDescriptor = openSync(filePath, 'r');
  try {
    // Scan back for the last newline in bounded steps.
    const step = 64 * 1024; // a read size, not a limit: the scan continues until a newline or the start
    let end = size;
    const buffer = Buffer.alloc(step);
    while (end > 0) {
      const start = Math.max(0, end - step);
      const length = end - start;
      readSync(fileDescriptor, buffer, 0, length, start);
      const newline = buffer.subarray(0, length).lastIndexOf(0x0a);
      if (newline >= 0) return start + newline + 1;
      end = start;
    }
    return 0;
  } finally {
    closeSync(fileDescriptor);
  }
}

/** Content-free counters for `wire status`. */
export const magpieFollowerActivity = { polls: 0, linesRead: 0, linesMalformed: 0, linesSkippedHelper: 0, oversizedLinesSkipped: 0, filesRestarted: 0, symlinksSkipped: 0, statesTakenUp: 0, requestsUnreadable: 0 };

/** A magpie line: magpie's GatewayTurn (internal/sessions/gateway.go:37-46), or claude-mem's own superset of it (capture/turn-recorder.ts). */
interface MagpieGatewayTurnLine {
  agent: string;
  session: string;
  time?: string;
  model?: string;
  status?: number;
  input: WireRecorderPart[];
  output: WireRecorderPart[];
  cut?: boolean;
  kind?: string;
  usage?: WireUsage;
}

function isRecorderPart(value: unknown): value is WireRecorderPart {
  if (!value || typeof value !== 'object') return false;
  const part = value as Record<string, unknown>;
  return typeof part.role === 'string' && typeof part.kind === 'string' && typeof part.text === 'string';
}

function readGatewayTurnLine(value: unknown): MagpieGatewayTurnLine | string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'not a JSON object';
  const line = value as Record<string, unknown>;
  if (typeof line.agent !== 'string' || line.agent === '') return 'no agent';
  if (typeof line.session !== 'string' || line.session === '') return 'no session';
  if (!Array.isArray(line.input) || !line.input.every(isRecorderPart)) return 'input is not a list of parts';
  if (!Array.isArray(line.output) || !line.output.every(isRecorderPart)) return 'output is not a list of parts';
  return line as unknown as MagpieGatewayTurnLine;
}

/** Each direction's budget in magpie's recorder, and what each part is charged beyond its text (magpie internal/sessions/gateway.go:83-105 `bound`). */
const MAGPIE_DIRECTION_BUDGET_BYTES = 64 * 1024;
const MAGPIE_PART_OVERHEAD_BYTES = 128;

/**
 * Whether the line's reply was cut. magpie sets one `cut` for the whole
 * line, whether its history was cut to fit the input's 64 KiB budget (most
 * long conversations) or its reply was; so `cut` counts against the reply
 * only when the input was not cut to fit, and a reply part cut short always does.
 */
function replyWasCut(turn: MagpieGatewayTurnLine): boolean {
  if (turn.output.some(part => (part.cut ?? 0) > 0)) return true;
  if (turn.cut !== true) return false;
  const inputCharged = turn.input.reduce((bytes, part) => bytes + Buffer.byteLength(part.text) + Buffer.byteLength(part.name ?? '') + MAGPIE_PART_OVERHEAD_BYTES, 0);
  const inputWasBounded = turn.input.some(part => (part.cut ?? 0) > 0) || inputCharged >= MAGPIE_DIRECTION_BUDGET_BYTES;
  return !inputWasBounded;
}

function foreignPartOf(part: WireRecorderPart): ForeignPart | null {
  switch (part.kind) {
    case 'text':
    case 'context':
      return { kind: part.kind, text: part.text };
    case 'thinking':
      return { kind: 'thinking', text: part.text };
    case 'image':
      return { kind: 'image' };
    case 'tool_use':
      return { kind: 'tool_call', name: part.name ?? '', argsJson: part.text || '{}' };
    case 'tool_result': {
      const hasImages = part.text.endsWith('\n[image]');
      return { kind: 'tool_result', ...(part.name ? { name: part.name } : {}), text: hasImages ? part.text.slice(0, -'\n[image]'.length) : part.text, ...(hasImages ? { hasImages } : {}) };
    }
    default:
      return null;
  }
}

/** The line's input as messages: parts of one role in a row are one message; the system prompt is system; the Tools listing is left out. */
function messagesOfInput(input: WireRecorderPart[]): { system: string[]; messages: ForeignMessage[] } {
  const system: string[] = [];
  const messages: ForeignMessage[] = [];
  for (const part of input) {
    if (part.role === 'system') {
      // magpie writes the system prompt and the tool definitions as system context (conversations.go:155-163).
      if (part.name !== 'Tools') system.push(part.text);
      continue;
    }
    const foreignPart = foreignPartOf(part);
    if (!foreignPart) continue;
    const role = part.role === 'tool' ? 'tool' : part.role === 'assistant' ? 'assistant' : 'user';
    const previous = messages.at(-1);
    if (previous && previous.role === role) previous.parts.push(foreignPart);
    else messages.push({ role, parts: [foreignPart] });
  }
  return { system, messages };
}

export interface MagpieRecordingsFollowerOptions {
  directory: string;
  capture: WireForeignCapture;
  /** Test seams. */
  statePath?: string;
  pollIntervalMs?: number;
  maxBytesPerPoll?: number;
  captureSourceRule?: CaptureSourceRuleOptions;
}

/** The suffix a request is renamed to while it is taken up; one left behind by a crash is taken up at the next look. */
const TAKING_SUFFIX = '.taking';

export class MagpieRecordingsFollower {
  readonly directory: string;
  private readonly statePath: string;
  private readonly maxBytesPerPoll: number;
  private readonly pollIntervalMs: number;
  private state: MagpieFollowerStateFile | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private warnedMissingDirectory = false;
  private warnedPendingForOtherDirectory = false;
  /** The request file last reported unreadable (path, size, mtime), so it is said once, not every poll. */
  private reportedUnreadableRequest: string | null = null;
  /** Bytes first seen on this run's first read were written while claude-mem was not running; so are those after a --backfill take-up. */
  private nextReadUnattended = true;
  /** Files the last poll's budget ran out on before a whole line: read first next poll, so a line too long for any poll is found and reported. */
  private budgetStarvedFiles = new Set<string>();

  constructor(private readonly options: MagpieRecordingsFollowerOptions) {
    assertNotClaudeMemRecordings(options.directory);
    this.directory = resolve(options.directory);
    this.statePath = options.statePath ?? paths.wireGatewayMagpieFollowerState();
    this.maxBytesPerPoll = options.maxBytesPerPoll ?? MAGPIE_FOLLOWER_MAX_BYTES_PER_POLL;
    this.pollIntervalMs = options.pollIntervalMs ?? MAGPIE_FOLLOWER_POLL_INTERVAL_MS;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.pollAndLog(), this.pollIntervalMs);
    this.timer.unref?.();
    this.pollAndLog();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private pollAndLog(): void {
    try {
      this.poll();
    } catch (error) {
      logger.error('WIRE', 'magpie recordings follower poll failed; it tries again next poll', { directory: this.directory },
        error instanceof Error ? error : new Error(String(error)));
    }
  }

  /** The state for this folder, from memory or disk; null when there is none (none on disk, or it is for another folder). */
  private existingState(): MagpieFollowerStateFile | null {
    if (this.state) return this.state;
    if (!existsSync(this.statePath)) return null;
    const stored = readMagpieFollowerStateFile(this.statePath);
    if (resolve(stored.directory) !== this.directory) {
      logger.info('WIRE', 'magpie follower state is for another folder; this one starts afresh', { stateDirectory: stored.directory, directory: this.directory });
      return null;
    }
    this.state = stored;
    this.options.capture.deliveries.restore(stored.deliveries);
    return this.state;
  }

  /**
   * Take up what `wire magpie enable` asked, when it is for this folder. The
   * request is claimed by renaming it, so one written meanwhile waits for the
   * next look; a claimed one a crash left behind is taken up first. Applying
   * one records its id in the state in the same write, so a request is never
   * applied twice and never lost.
   */
  private takeUpRequestedState(): void {
    const pendingPath = pendingMagpieFollowerStatePath(this.statePath);
    const stateDirectory = dirname(this.statePath);
    const claimedPrefix = `${basename(pendingPath)}.`;
    const leftBehind = existsSync(stateDirectory)
      ? readdirSync(stateDirectory).filter(name => name.startsWith(claimedPrefix) && name.endsWith(TAKING_SUFFIX)).map(name => join(stateDirectory, name))
      : [];
    for (const claimedPath of leftBehind.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)) {
      if (!this.takeUpClaimed(claimedPath, pendingPath)) return;
    }
    if (!existsSync(pendingPath)) return;
    const request = this.readRequestOrReport(pendingPath);
    if (!request) return;
    if (resolve(request.directory) !== this.directory) {
      if (!this.warnedPendingForOtherDirectory) {
        this.warnedPendingForOtherDirectory = true;
        logger.warn('WIRE', 'wire magpie enable asked to follow another folder; that takes effect when the gateway restarts (claude-mem wire restart)', { pendingPath, directory: this.directory });
      }
      return;
    }
    const claimedPath = `${pendingPath}.${process.pid}${TAKING_SUFFIX}`;
    renameSync(pendingPath, claimedPath);
    this.takeUpClaimed(claimedPath, pendingPath);
  }

  /** A request file that cannot be read is reported once (a new one is reported again) and left alone; the follower goes on as it was. */
  private readRequestOrReport(requestPath: string): MagpieFollowerRequestFile | null {
    try {
      const request = readMagpieFollowerRequestFile(requestPath);
      this.reportedUnreadableRequest = null;
      return request;
    } catch (error) {
      const stats = statSync(requestPath, { throwIfNoEntry: false });
      const identity = `${requestPath}:${stats?.size}:${stats?.mtimeMs}`;
      if (this.reportedUnreadableRequest !== identity) {
        this.reportedUnreadableRequest = identity;
        magpieFollowerActivity.requestsUnreadable++;
        logger.error('WIRE', 'magpie follower: the wire magpie enable request cannot be read; following goes on from where it is', { requestPath },
          error instanceof Error ? error : new Error(String(error)));
      }
      return null;
    }
  }

  /** Take up one claimed request. Returns false when it must wait (unreadable, or for another folder with a newer request already there). */
  private takeUpClaimed(claimedPath: string, pendingPath: string): boolean {
    const request = this.readRequestOrReport(claimedPath);
    if (!request) return false;
    if (resolve(request.directory) !== this.directory) {
      // Replaced between the look and the claim by a request for another folder: put it back unless a newer one is already there.
      if (existsSync(pendingPath)) unlinkSync(claimedPath);
      else renameSync(claimedPath, pendingPath);
      return true;
    }
    const current = this.existingState();
    if (current?.takenRequestId === request.requestId) {
      // Applied already; the crash came before the request file was removed.
      unlinkSync(claimedPath);
      return true;
    }
    if (!request.backfill && current) {
      // Already following this folder: it goes on from where it got to, so no line it has not read yet is skipped.
      current.takenRequestId = request.requestId;
      this.saveState(current);
      unlinkSync(claimedPath);
      logger.info('WIRE', 'wire magpie enable for the folder the follower already follows: it goes on from where it got to', { directory: this.directory });
      return true;
    }
    const files: Record<string, FollowedFileState> = {};
    for (const [relativePath, file] of Object.entries(request.files)) files[relativePath] = { inode: file.inode, offset: file.offset };
    this.state = { version: STATE_VERSION, directory: this.directory, files, takenRequestId: request.requestId };
    this.budgetStarvedFiles.clear();
    // What --backfill asks for is taken as written while nothing followed; from-now lines were written after enable ran, while no follower read them.
    this.nextReadUnattended = true;
    this.saveState(this.state);
    unlinkSync(claimedPath);
    this.warnedPendingForOtherDirectory = false;
    magpieFollowerActivity.statesTakenUp++;
    logger.info('WIRE', 'magpie follower took up the start wire magpie enable asked for', { directory: this.directory, backfill: request.backfill, files: Object.keys(files).length });
    return true;
  }

  /** The state on disk, or the one that starts at the end of every file now there. Unreadable state is reported, never read as empty. */
  private loadState(): MagpieFollowerStateFile {
    const existing = this.existingState();
    if (existing) return existing;
    this.state = startingMagpieFollowerState(this.directory, false);
    this.saveState(this.state);
    return this.state;
  }

  /** Save the state with the OTLP deliveries its undecided lines still need. */
  private saveState(state: MagpieFollowerStateFile): void {
    const deliveries = this.options.capture.deliveries;
    const undecidedSince = Object.values(state.files).flatMap(file => (file.seen ?? []).map(region => region.at));
    deliveries.prune(Math.min(this.options.capture.now(), ...undecidedSince));
    state.deliveries = deliveries.snapshot();
    writeMagpieFollowerState(state, this.statePath);
  }

  /** One poll. Returns how many lines were read. */
  poll(): number {
    if (!existsSync(this.directory)) {
      if (!this.warnedMissingDirectory) {
        this.warnedMissingDirectory = true;
        logger.warn('WIRE', 'magpie recordings folder does not exist; the follower keeps looking for it', { directory: this.directory });
      }
      // Nothing was there while claude-mem was down; what appears from now on is written while it runs.
      this.nextReadUnattended = false;
      return 0;
    }
    this.warnedMissingDirectory = false;
    this.takeUpRequestedState();
    const state = this.loadState();
    magpieFollowerActivity.polls++;
    const now = this.options.capture.now();
    const settleMs = this.options.capture.deliveries.settleMs;
    const unattended = this.nextReadUnattended;
    this.nextReadUnattended = false;
    const otherCaptureSource = this.options.capture.checkForBatch(this.options.captureSourceRule);
    let budget = this.maxBytesPerPoll;
    let linesRead = 0;
    let changed = false;
    const present = new Set<string>();
    const turnsFiles = turnsFilesUnder(this.directory);
    const starvedLastPoll = this.budgetStarvedFiles;
    this.budgetStarvedFiles = new Set<string>();
    // Files the budget ran out on last poll go first, so each gets a whole poll's budget in turn.
    const inReadOrder = [...turnsFiles.filter(path => starvedLastPoll.has(path)), ...turnsFiles.filter(path => !starvedLastPoll.has(path))];
    for (const relativePath of inReadOrder) {
      present.add(relativePath);
      const filePath = join(this.directory, relativePath);
      const { inode, size } = inodeOf(filePath);
      let fileState: FollowedFileState | undefined = state.files[relativePath];
      if (fileState && (fileState.inode !== inode || size < fileState.offset)) {
        logger.info('WIRE', 'magpie recording was replaced or truncated; reading it from its start', { file: relativePath });
        magpieFollowerActivity.filesRestarted++;
        fileState = undefined;
      }
      if (!fileState) {
        fileState = { inode, offset: 0 };
        state.files[relativePath] = fileState;
        changed = true;
      }
      // Note when bytes past what is known were first seen: each line is decided once it has been seen for the settle time.
      const seen = (fileState.seen ??= []);
      const knownEnd = Math.max(fileState.offset, seen.at(-1)?.end ?? 0);
      if (size > knownEnd) {
        seen.push(unattended ? { end: size, at: now, unattended: true } : { end: size, at: now });
        changed = true;
      }
      if (seen.length === 0) delete fileState.seen;
      let decidableEnd = fileState.offset;
      for (const region of seen) {
        if (!region.unattended && region.at + settleMs > now) break;
        decidableEnd = Math.min(region.end, size);
      }
      if (decidableEnd <= fileState.offset) continue;
      if (budget <= 0) {
        this.budgetStarvedFiles.add(relativePath);
        continue;
      }
      const toRead = Math.min(decidableEnd - fileState.offset, budget);
      const startOffset = fileState.offset;
      const bytes = Buffer.alloc(toRead);
      const fileDescriptor = openSync(filePath, 'r');
      try {
        readSync(fileDescriptor, bytes, 0, toRead, startOffset);
      } finally {
        closeSync(fileDescriptor);
      }
      budget -= toRead;
      let consumedStart = 0;
      if (fileState.discardingUntilNewline) {
        const newline = bytes.indexOf(0x0a);
        if (newline < 0) {
          this.advance(fileState, startOffset + toRead);
          changed = true;
          continue;
        }
        consumedStart = newline + 1;
        delete fileState.discardingUntilNewline;
      }
      const lastNewline = bytes.lastIndexOf(0x0a);
      if (lastNewline < consumedStart) {
        // No whole line yet. A full poll's budget with no newline is a line no recorder writes (magpie caps a line at 1 MiB): skip it, loudly.
        // Less than a full budget because files before it used some: it goes first next poll, where it gets the whole budget.
        if (consumedStart === 0 && toRead < this.maxBytesPerPoll && toRead < decidableEnd - startOffset) this.budgetStarvedFiles.add(relativePath);
        if (consumedStart === 0 && toRead === this.maxBytesPerPoll) {
          logger.error('WIRE', 'magpie recording line is longer than a whole poll can read; skipping it', { file: relativePath, maxBytesPerPoll: this.maxBytesPerPoll });
          magpieFollowerActivity.oversizedLinesSkipped++;
          this.advance(fileState, startOffset + toRead);
          fileState.discardingUntilNewline = true;
          changed = true;
        } else if (consumedStart > 0) {
          this.advance(fileState, startOffset + consumedStart);
          changed = true;
        }
        continue;
      }
      let lineStart = consumedStart;
      while (lineStart <= lastNewline) {
        const newline = bytes.indexOf(0x0a, lineStart);
        const line = bytes.subarray(lineStart, newline).toString('utf8');
        const lineEnd = startOffset + newline + 1;
        lineStart = newline + 1;
        if (line.trim() === '') continue;
        linesRead++;
        // The region the line's newline was first seen in says when, and whether it came while claude-mem was not running.
        const region = seen.find(candidate => candidate.end >= lineEnd)!;
        this.ingestLine(line, relativePath, otherCaptureSource, { seenAt: region.at, unattended: region.unattended === true });
      }
      this.advance(fileState, startOffset + lastNewline + 1);
      changed = true;
    }
    for (const relativePath of Object.keys(state.files)) {
      if (!present.has(relativePath)) {
        delete state.files[relativePath];
        changed = true;
      }
    }
    // While lines wait to be decided, the OTLP deliveries they will be decided by are saved with them (a restart keeps both).
    if (changed || Object.values(state.files).some(file => file.seen)) this.saveState(state);
    magpieFollowerActivity.linesRead += linesRead;
    return linesRead;
  }

  /** Move a file's offset, forgetting the seen regions now wholly behind it. */
  private advance(fileState: FollowedFileState, offset: number): void {
    fileState.offset = offset;
    const seen = (fileState.seen ?? []).filter(region => region.end > offset);
    if (seen.length > 0) fileState.seen = seen;
    else delete fileState.seen;
  }

  private ingestLine(line: string, relativePath: string, otherCaptureSource: OtherCaptureSourceCheck, sighting: RecordingSighting): void {
    const parsed = parseJsonText(line);
    const turn = parsed.ok ? readGatewayTurnLine(parsed.value) : parsed.error;
    if (typeof turn === 'string') {
      magpieFollowerActivity.linesMalformed++;
      logger.warn('WIRE', 'magpie recording line skipped: it is not a recorded exchange', { file: relativePath, reason: turn });
      return;
    }
    if (turn.kind?.startsWith('helper:')) {
      magpieFollowerActivity.linesSkippedHelper++;
      return;
    }
    const agentId = claudeMemAgentIdOfMagpieAgent(turn.agent);
    const status = typeof turn.status === 'number' && turn.status >= 100 ? turn.status : 200;
    const { system, messages } = messagesOfInput(turn.input);
    const output = turn.output.map(foreignPartOf).filter((part): part is ForeignPart => part !== null);
    const exchange = foreignExchangeOf({
      system,
      messages,
      output,
      model: turn.model ?? '',
      status,
      cut: replyWasCut(turn),
      ...(turn.usage ? { usage: turn.usage } : {}),
      callIdScope: [agentId, turn.session],
      callIdPrefix: 'magpie',
    });
    this.options.capture.observeExchange({
      source: 'magpie',
      channel: 'magpie_recording',
      agentId,
      sessionId: turn.session,
      request: exchange.request,
      reply: exchange.reply,
      replyIsWhole: exchange.replyIsWhole,
      finalReply: exchange.replyIsWhole && exchange.reply !== null && exchange.reply.toolCalls.length === 0,
      sighting,
    }, otherCaptureSource);
  }
}
