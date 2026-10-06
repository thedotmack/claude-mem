import { createHash } from 'crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync } from 'fs';
import { join } from 'path';
import { writeJsonFileAtomic } from './atomic-json.js';
import { resolveDataDir } from './paths.js';
import { normalizePlatformSource } from './platform-source.js';
import { logger } from '../utils/logger.js';

/**
 * Durable hand-off from short-lived write hooks to the worker.
 *
 * A write hook (PostToolUse observation, file edit, Stop summarize + advisor
 * calls, SessionEnd) writes ONE file per event here and exits; it never waits
 * for the worker. The worker drains the directory in order (boot, a nudge from
 * the hook, an fs.watch of the directory, and a slow safety sweep).
 *
 * Dedupe + ordering design (the simpler of the two correct options):
 * - The filename IS the deterministic key: `<kind>-<key>.json`, key =
 *   a hash of session + platform followed by `tool_use_id` when filename-safe, else
 *   sha256(kind, contentSessionId, canonical payload). A re-delivered event
 *   therefore overwrites its own file — no directory scan on the hook path,
 *   and no window where two hooks racing the same event create two files.
 * - Order lives in the body: `enqueuedAtEpochMs`, monotonic per process and
 *   preserved when an existing entry is overwritten. Readers sort by it (then
 *   by filename) — the drain reads every file anyway.
 *
 * One file per event, never a shared append-only file: concurrent hook
 * processes cannot interleave writes (Windows), and writeJsonFileAtomic makes
 * each file all-or-nothing.
 */

export const HOOK_SPOOL_KINDS = ['observation', 'file_edit', 'summarize', 'session_end', 'advisor_calls'] as const;
export type HookSpoolKind = typeof HOOK_SPOOL_KINDS[number];

export interface SpooledObservationPayload {
  contentSessionId: string;
  platformSource: string;
  toolName: string;
  toolInput: unknown;
  toolResponse: unknown;
  cwd?: string;
  agentId?: string;
  agentType?: string;
  toolUseId?: string;
}

export interface SpooledSummarizePayload {
  contentSessionId: string;
  platformSource: string;
  lastAssistantMessage: string;
  observedModel?: string;
  observedBilling?: string;
  cwd?: string;
}

export interface SpooledSessionEndPayload {
  contentSessionId: string;
  platformSource: string;
}

export interface SpooledAdvisorCall {
  toolUseId: string;
  advice: string;
  advisorModel?: string | null;
  occurredAtEpoch: number;
  lastUserMessage?: string | null;
  transcriptByteOffset?: number | null;
}

export interface SpooledAdvisorCallsPayload {
  contentSessionId: string;
  platformSource: string;
  cwd?: string;
  transcriptPath?: string;
  calls: SpooledAdvisorCall[];
}

export interface HookSpoolPayloadByKind {
  observation: SpooledObservationPayload;
  file_edit: SpooledObservationPayload;
  summarize: SpooledSummarizePayload;
  session_end: SpooledSessionEndPayload;
  advisor_calls: SpooledAdvisorCallsPayload;
}

export type HookSpoolEntry = {
  [K in HookSpoolKind]: {
    kind: K;
    payload: HookSpoolPayloadByKind[K];
    enqueuedAtEpochMs: number;
  }
}[HookSpoolKind];

/**
 * Durable record of the entries ingest irrevocably accepted (the worker's
 * hook_spool_consumed table). Makes the hand-off exactly-once across
 * restarts: see HookSpool.drain.
 */
export interface HookSpoolConsumedMarkers {
  isConsumed(entryKey: string): boolean;
  markConsumed(entryKey: string, consumedAtEpochMs: number): void;
  clearConsumed(entryKey: string): void;
  pruneConsumedBefore(epochMs: number): void;
}

export interface HookSpoolDrainResult {
  drained: number;
  retained: number;
  quarantined: number;
  expired: number;
}

const ENTRY_FILENAME = /^[a-z_]+-[A-Za-z0-9_-]+\.json$/;
const FILENAME_SAFE_TOOL_USE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const CORRUPT_DIRNAME = 'corrupt';
const EXPIRED_DIRNAME = 'expired';

/**
 * A retained entry (session never became known, ingest keeps failing) older
 * than this stops being retried: it is moved to `expired/` with an error log,
 * never silently deleted.
 */
export const HOOK_SPOOL_RETRY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const LEGACY_SESSION_END_REPLAY_DIRNAME = 'session-end-replay';

export function resolveHookSpoolDirectory(): string {
  return join(resolveDataDir(), 'state', 'hook-spool');
}

export function resolveLegacySessionEndReplayDirectory(): string {
  return join(resolveDataDir(), 'state', LEGACY_SESSION_END_REPLAY_DIRNAME);
}

/** JSON with object keys sorted at every depth, so equal payloads hash equal. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter(key => record[key] !== undefined).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export function hookSpoolKeyFor<K extends HookSpoolKind>(kind: K, payload: HookSpoolPayloadByKind[K]): string {
  const toolUseId = (payload as { toolUseId?: unknown }).toolUseId;
  if (typeof toolUseId === 'string' && FILENAME_SAFE_TOOL_USE_ID.test(toolUseId)) {
    // Tool ids are opaque host values; some hosts number them within a
    // session. Scope the durable filename (and consumed marker) like the
    // worker dedup key, so a second session cannot overwrite the first.
    const sessionKey = createHash('sha256')
      .update(payload.contentSessionId)
      .update('\0')
      .update(normalizePlatformSource(payload.platformSource))
      .digest('hex');
    return `${sessionKey}-${toolUseId}`;
  }
  return createHash('sha256')
    .update(kind)
    .update('\0')
    .update(payload.contentSessionId)
    .update('\0')
    .update(canonicalJson(payload))
    .digest('hex');
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Returns the entry, or a reason it is corrupt. */
function parseHookSpoolEntry(raw: string): HookSpoolEntry | { corruptReason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { corruptReason: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (parsed === null || typeof parsed !== 'object') return { corruptReason: 'not an object' };
  const candidate = parsed as { kind?: unknown; payload?: unknown; enqueuedAtEpochMs?: unknown };
  if (!HOOK_SPOOL_KINDS.includes(candidate.kind as HookSpoolKind)) {
    return { corruptReason: `unknown kind ${JSON.stringify(candidate.kind)}` };
  }
  if (typeof candidate.enqueuedAtEpochMs !== 'number' || !Number.isFinite(candidate.enqueuedAtEpochMs)) {
    return { corruptReason: 'missing enqueuedAtEpochMs' };
  }
  const payload = candidate.payload as Record<string, unknown> | null;
  if (payload === null || typeof payload !== 'object' || !isNonEmptyString(payload.contentSessionId)) {
    return { corruptReason: 'payload missing contentSessionId' };
  }
  const kind = candidate.kind as HookSpoolKind;
  if ((kind === 'observation' || kind === 'file_edit') && !isNonEmptyString(payload.toolName)) {
    return { corruptReason: 'observation payload missing toolName' };
  }
  if (kind === 'summarize' && typeof payload.lastAssistantMessage !== 'string') {
    return { corruptReason: 'summarize payload missing lastAssistantMessage' };
  }
  if (kind === 'advisor_calls' && (!Array.isArray(payload.calls) || payload.calls.length === 0)) {
    return { corruptReason: 'advisor_calls payload has no calls' };
  }
  return {
    kind,
    payload: { ...payload, platformSource: normalizePlatformSource(payload.platformSource as string | undefined) },
    enqueuedAtEpochMs: candidate.enqueuedAtEpochMs,
  } as HookSpoolEntry;
}

interface HookSpoolFile {
  entry: HookSpoolEntry;
  path: string;
  filename: string;
}

// Monotonic per process: two enqueues in the same millisecond (advisor-call
// chunks then the summarize, from one Stop hook) keep their call order.
let lastEnqueuedAtEpochMs = 0;

function monotonicNowEpochMs(): number {
  lastEnqueuedAtEpochMs = Math.max(Date.now(), lastEnqueuedAtEpochMs + 1);
  return lastEnqueuedAtEpochMs;
}

export class HookSpool {
  constructor(readonly directory: string = resolveHookSpoolDirectory()) {}

  get corruptDirectory(): string {
    return join(this.directory, CORRUPT_DIRNAME);
  }

  get expiredDirectory(): string {
    return join(this.directory, EXPIRED_DIRNAME);
  }

  /**
   * Writes (or overwrites) this event's file. Returns the file path.
   * `requestedAtEpochMs` is for carrying an existing timestamp over (legacy
   * migration, tests); hooks omit it and get a per-process monotonic now.
   */
  enqueue<K extends HookSpoolKind>(
    kind: K,
    payload: HookSpoolPayloadByKind[K],
    requestedAtEpochMs?: number,
  ): string {
    const normalizedPayload = { ...payload, platformSource: normalizePlatformSource(payload.platformSource) };
    let entryPath = join(this.directory, `${kind}-${hookSpoolKeyFor(kind, normalizedPayload)}.json`);
    const toolUseId = (normalizedPayload as { toolUseId?: unknown }).toolUseId;
    if (typeof toolUseId === 'string' && FILENAME_SAFE_TOOL_USE_ID.test(toolUseId)) {
      const legacyPath = join(this.directory, `${kind}-${toolUseId}.json`);
      try {
        const legacy = parseHookSpoolEntry(readFileSync(legacyPath, 'utf8'));
        if (!('corruptReason' in legacy) && legacy.kind === kind
          && legacy.payload.contentSessionId === normalizedPayload.contentSessionId
          && legacy.payload.platformSource === normalizedPayload.platformSource) {
          // A pre-upgrade file may remain after handoff but before unlink.
          // Keep its key until removal so its durable consumed marker still
          // suppresses re-delivery; another scope must use the new key.
          entryPath = legacyPath;
        }
      } catch {
        // No legacy entry: new enqueues use the session/platform namespace.
      }
    }
    const enqueuedAtEpochMs = this.existingEnqueuedAt(entryPath) ?? requestedAtEpochMs ?? monotonicNowEpochMs();
    writeJsonFileAtomic(entryPath, { kind, payload: normalizedPayload, enqueuedAtEpochMs });
    return entryPath;
  }

  /** Readable entries in drain order. Corrupt files are quarantined as a side effect. */
  entries(): HookSpoolEntry[] {
    return this.readEntries().files.map(file => file.entry);
  }

  /**
   * Hands each entry to `accept` in order; an accepted entry is unlinked.
   *
   * With `consumedMarkers`, the hand-off is EXACTLY-ONCE AT THE HANDOFF POINT
   * across restarts. `accept` receives a synchronous `markHandedOff()` that
   * ingest calls the instant the entry is irrevocably accepted (enqueued into
   * the SessionManager / recorded in the DB) and before it kicks any async,
   * provider-bound work (ensureGeneratorRunning). markHandedOff writes the
   * entry's consumed marker to the worker DB synchronously (bun:sqlite), so no
   * provider call can precede it.
   * - Crash before markHandedOff (ingest declined, threw, or died first): no
   *   marker, the file is still there ⇒ the next drain ingests it. No loss.
   * - Crash after markHandedOff, before the unlink: the next drain finds the
   *   marker and removes the file without ingesting it again. No double paid
   *   send.
   * Once markHandedOff has run, the entry counts as accepted even if `accept`
   * later throws or returns false — retrying it would send it twice. The
   * marker is cleared once the file is gone.
   */
  async drain(
    accept: (entry: HookSpoolEntry, markHandedOff: () => void) => boolean | Promise<boolean>,
    consumedMarkers?: HookSpoolConsumedMarkers,
  ): Promise<HookSpoolDrainResult> {
    const { files, quarantined } = this.readEntries();
    let drained = 0;
    let retained = 0;
    let expired = 0;

    // A marker outlives its file only when a crash hit between unlink and clear.
    consumedMarkers?.pruneConsumedBefore(Date.now() - HOOK_SPOOL_RETRY_WINDOW_MS);

    const blockedSessions = new Set<string>();
    for (const file of files) {
      const sessionKey = JSON.stringify([file.entry.payload.contentSessionId, normalizePlatformSource(file.entry.payload.platformSource)]);
      if (blockedSessions.has(sessionKey)) { retained++; continue; }
      const entryKey = file.filename.replace(/\.json$/, '');
      if (consumedMarkers?.isConsumed(entryKey)) {
        logger.info('HOOK', 'Hook spool entry was already handed to ingest before a restart; removing it without ingesting again', {
          kind: file.entry.kind,
          contentSessionId: file.entry.payload.contentSessionId,
          file: file.filename,
        });
        if (this.unlinkEntry(file)) {
          consumedMarkers.clearConsumed(entryKey);
          drained++;
        } else {
          retained++;
        }
        continue;
      }

      let handedOff = false;
      const markHandedOff = (): void => {
        if (handedOff) return;
        handedOff = true;
        try {
          consumedMarkers?.markConsumed(entryKey, Date.now());
        } catch (error) {
          // Never throw into ingest: the entry IS enqueued and its generator
          // kick must still run. Without the marker a crash before the unlink
          // below would ingest it again — say so loudly.
          logger.error('HOOK', 'Could not record a hook spool hand-off marker; a crash before the file is removed would ingest it twice', {
            kind: file.entry.kind,
            contentSessionId: file.entry.payload.contentSessionId,
            file: file.filename,
          }, error instanceof Error ? error : new Error(String(error)));
        }
      };
      let accepted: boolean;
      try {
        accepted = await accept(file.entry, markHandedOff);
      } catch (error) {
        logger.warn('HOOK', handedOff
          ? 'Hook spool entry failed after ingest accepted it; removing it (a retry would send it twice)'
          : 'Hook spool entry failed to ingest; keeping it for the next drain', {
          kind: file.entry.kind,
          contentSessionId: file.entry.payload.contentSessionId,
          file: file.filename,
        }, error instanceof Error ? error : new Error(String(error)));
        accepted = false;
      }
      if (handedOff) accepted = true;

      if (!accepted) {
        // Never handed off (no marker was written): the next drain retries it.
        if (this.expireIfPastRetryWindow(file)) {
          expired++;
        } else {
          blockedSessions.add(sessionKey);
          retained++;
        }
        continue;
      }

      if (this.unlinkEntry(file)) {
        consumedMarkers?.clearConsumed(entryKey);
        drained++;
      } else {
        // The marker stays: the next drain removes the file without re-ingesting it.
        retained++;
      }
    }

    return { drained, retained, quarantined, expired };
  }

  /** True when the file is gone (removed here, or by a concurrent drain). */
  private unlinkEntry(file: HookSpoolFile): boolean {
    try {
      unlinkSync(file.path);
      return true;
    } catch (error) {
      // ENOENT: a concurrent drain (another worker process) already removed it.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      logger.warn('HOOK', 'Hook spool entry was ingested but could not be removed', {
        kind: file.entry.kind,
        file: file.filename,
      }, error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  /** Moves a retained entry older than HOOK_SPOOL_RETRY_WINDOW_MS to `expired/`. */
  private expireIfPastRetryWindow(file: HookSpoolFile): boolean {
    const ageMs = Date.now() - file.entry.enqueuedAtEpochMs;
    if (ageMs <= HOOK_SPOOL_RETRY_WINDOW_MS) return false;

    const details = {
      kind: file.entry.kind,
      contentSessionId: file.entry.payload.contentSessionId,
      ageHours: Math.round(ageMs / 3_600_000),
      file: file.filename,
      expiredDirectory: this.expiredDirectory,
    };
    try {
      mkdirSync(this.expiredDirectory, { recursive: true });
      renameSync(file.path, join(this.expiredDirectory, file.filename));
    } catch (error) {
      logger.error('HOOK', 'Hook spool entry is past its retry window but could not be moved to expired/; keeping it', details,
        error instanceof Error ? error : new Error(String(error)));
      return false;
    }
    logger.error('HOOK', 'Hook spool entry was never accepted within its retry window; moved to expired/', details);
    return true;
  }

  private existingEnqueuedAt(entryPath: string): number | null {
    if (!existsSync(entryPath)) return null;
    try {
      const existing = parseHookSpoolEntry(readFileSync(entryPath, 'utf-8'));
      return 'corruptReason' in existing ? null : existing.enqueuedAtEpochMs;
    } catch (error) {
      // The drain may unlink it between existsSync and readFileSync; a fresh
      // timestamp is then correct.
      logger.debug('HOOK', 'Could not read existing hook spool entry; writing a fresh one', { entryPath },
        error instanceof Error ? error : new Error(String(error)));
      return null;
    }
  }

  private quarantine(filename: string, reason: string): boolean {
    const source = join(this.directory, filename);
    try {
      mkdirSync(this.corruptDirectory, { recursive: true });
      renameSync(source, join(this.corruptDirectory, filename));
      logger.error('HOOK', 'Quarantined corrupt hook spool entry', {
        file: filename,
        reason,
        corruptDirectory: this.corruptDirectory,
      });
      return true;
    } catch (error) {
      logger.error('HOOK', 'Corrupt hook spool entry could not be quarantined; leaving it in place', {
        file: filename,
        reason,
      }, error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  private readEntries(): { files: HookSpoolFile[]; quarantined: number } {
    if (!existsSync(this.directory)) return { files: [], quarantined: 0 };

    let filenames: string[];
    try {
      filenames = readdirSync(this.directory).filter(filename => ENTRY_FILENAME.test(filename));
    } catch (error) {
      logger.warn('HOOK', 'Could not list hook spool entries', { directory: this.directory },
        error instanceof Error ? error : new Error(String(error)));
      return { files: [], quarantined: 0 };
    }

    const files: HookSpoolFile[] = [];
    let quarantined = 0;
    for (const filename of filenames) {
      const entryPath = join(this.directory, filename);
      let raw: string;
      try {
        raw = readFileSync(entryPath, 'utf-8');
      } catch (error) {
        // ENOENT: drained by a concurrent pass after the listing. Anything
        // else is retried on the next pass.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          logger.warn('HOOK', 'Could not read hook spool entry; will retry', { file: filename },
            error instanceof Error ? error : new Error(String(error)));
        }
        continue;
      }
      const parsed = parseHookSpoolEntry(raw);
      if ('corruptReason' in parsed) {
        if (this.quarantine(filename, parsed.corruptReason)) quarantined++;
        continue;
      }
      files.push({ entry: parsed, path: entryPath, filename });
    }

    files.sort((a, b) => a.entry.enqueuedAtEpochMs - b.entry.enqueuedAtEpochMs || a.filename.localeCompare(b.filename));
    return { files, quarantined };
  }
}

/**
 * One-time boot migration from the retired DeferredSessionEndQueue
 * (`state/session-end-replay/<sha256>.json` holding
 * `{contentSessionId, platformSource, requestedAtEpoch}`): each readable entry
 * becomes a `session_end` spool entry, malformed ones are quarantined into the
 * spool's corrupt directory, and the legacy directory is removed.
 */
export function migrateLegacySessionEndReplay(
  spool: HookSpool,
  legacyDirectory: string = resolveLegacySessionEndReplayDirectory(),
): number {
  if (!existsSync(legacyDirectory)) return 0;

  let migrated = 0;
  for (const filename of readdirSync(legacyDirectory)) {
    if (!filename.endsWith('.json') || filename.startsWith('.')) continue;
    const legacyPath = join(legacyDirectory, filename);
    let entry: { contentSessionId?: unknown; platformSource?: unknown; requestedAtEpoch?: unknown } | null = null;
    try {
      entry = JSON.parse(readFileSync(legacyPath, 'utf-8'));
    } catch (error) {
      logger.error('HOOK', 'Legacy SessionEnd replay entry is unreadable', { file: legacyPath },
        error instanceof Error ? error : new Error(String(error)));
    }
    if (entry && isNonEmptyString(entry.contentSessionId)) {
      spool.enqueue('session_end', {
        contentSessionId: entry.contentSessionId,
        platformSource: normalizePlatformSource(typeof entry.platformSource === 'string' ? entry.platformSource : undefined),
      }, typeof entry.requestedAtEpoch === 'number' && Number.isFinite(entry.requestedAtEpoch) ? entry.requestedAtEpoch : Date.now());
      unlinkSync(legacyPath);
      migrated++;
      continue;
    }
    mkdirSync(spool.corruptDirectory, { recursive: true });
    renameSync(legacyPath, join(spool.corruptDirectory, `legacy-session-end-${filename}`));
    logger.error('HOOK', 'Quarantined malformed legacy SessionEnd replay entry', {
      file: filename,
      corruptDirectory: spool.corruptDirectory,
    });
  }

  // Everything meaningful was migrated or quarantined above; what remains is
  // at most an interrupted atomic-write temp file.
  rmSync(legacyDirectory, { recursive: true, force: true });
  if (migrated > 0) {
    logger.info('HOOK', 'Migrated legacy SessionEnd replay entries into the hook spool', { count: migrated });
  }
  return migrated;
}
