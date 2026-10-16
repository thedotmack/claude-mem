// SPDX-License-Identifier: Apache-2.0
//
// Recording consent (plan Phase 6 task 1): `<DATA_DIR>/wire-gateway/consent.json`
// {recording, generation, decidedAt}. Raw recording (turns.jsonl) is off until
// the user turns it on, and only two things turn it on: `claude-mem wire
// consent --record` at a terminal, or the viewer's consent card (Phase 15).
// CLAUDE_MEM_WIRE_GATEWAY_RECORDING=false can only force it off. Every change
// bumps the generation, so a request that started before it is never saved
// after it (turn-recorder.ts). Cloud sync never reads or writes this file.
//
// Every change holds `consent.json.lock` (edit/file-lock.ts) across its read
// of the generation and its write, so two processes (a `consent --off` and a
// `clear`) can neither hand out the same generation nor write back a decision
// the other just replaced.
//
// The daemon reads the file on every check rather than caching it: the CLI
// that changes it is another process, and a clear must take effect for the
// very next save.

import { existsSync, readFileSync, rmSync } from 'fs';
import { writeJsonFileAtomic } from '../../../shared/atomic-json.js';
import { WIRE_GATEWAY_FILE_MODE, paths, wireGatewaySubdirPath } from '../../../shared/paths.js';
import { logger } from '../../../utils/logger.js';
import { withExclusiveFileLock } from '../edit/file-lock.js';
import type { WireRecordingConsent } from '../capture/turn-recorder.js';

export interface WireRecordingConsentFile {
  recording: boolean;
  /** Bumped by every change and by every clear. */
  generation: number;
  decidedAt: string;
}

/**
 * The consent file, or null when there is none (no decision: recording off).
 * Throws when the file exists but is not a consent file: an unreadable
 * decision is never read as a "yes".
 */
export function readWireRecordingConsentFile(consentFilePath: string = paths.wireGatewayConsent()): WireRecordingConsentFile | null {
  if (!existsSync(consentFilePath)) return null;
  const parsed = JSON.parse(readFileSync(consentFilePath, 'utf-8')) as Partial<WireRecordingConsentFile> | null;
  if (!parsed || typeof parsed.recording !== 'boolean' || !Number.isSafeInteger(parsed.generation)) {
    throw new Error(`${consentFilePath} is not a wire recording consent file (needs "recording" true/false and a whole-number "generation")`);
  }
  return { recording: parsed.recording, generation: parsed.generation as number, decidedAt: typeof parsed.decidedAt === 'string' ? parsed.decidedAt : '' };
}

function writeWireRecordingConsentFile(consent: WireRecordingConsentFile, consentFilePath: string): void {
  writeJsonFileAtomic(consentFilePath, consent, { mode: WIRE_GATEWAY_FILE_MODE });
}

/** The generation after the one on disk; an unreadable file is replaced, starting past any generation it could have held. */
function nextGeneration(consentFilePath: string): { previous: WireRecordingConsentFile | null; generation: number } {
  try {
    const previous = readWireRecordingConsentFile(consentFilePath);
    return { previous, generation: (previous?.generation ?? 0) + 1 };
  } catch (error) {
    logger.warn('WIRE', 'Replacing an unreadable wire recording consent file', { consentFilePath },
      error instanceof Error ? error : new Error(String(error)));
    return { previous: null, generation: Date.now() };
  }
}

/** Record the user's decision. Callers enforce how a "yes" may be given (a terminal, the viewer's own origin). */
export function setWireRecordingConsent(recording: boolean, consentFilePath: string = paths.wireGatewayConsent()): WireRecordingConsentFile {
  return withExclusiveFileLock(consentFilePath, () => {
    const consent: WireRecordingConsentFile = {
      recording,
      generation: nextGeneration(consentFilePath).generation,
      decidedAt: new Date().toISOString(),
    };
    writeWireRecordingConsentFile(consent, consentFilePath);
    return consent;
  });
}

/**
 * Delete every raw recording. The generation is bumped FIRST, so a save that
 * is in flight when the files go is refused (or taken back) instead of
 * refilling the store. The recording decision itself is kept. Memories that
 * capture already created stay in claude-mem; this deletes recordings only.
 * (Phase 13's live-feed bodies join this when they exist.)
 */
export function clearWireRecordings(options: { consentFilePath?: string; recordingsDirectory?: string } = {}): WireRecordingConsentFile {
  const consentFilePath = options.consentFilePath ?? paths.wireGatewayConsent();
  const consent = withExclusiveFileLock(consentFilePath, () => {
    const { previous, generation } = nextGeneration(consentFilePath);
    const bumped: WireRecordingConsentFile = {
      recording: previous?.recording ?? false,
      generation,
      decidedAt: previous?.decidedAt ?? new Date().toISOString(),
    };
    writeWireRecordingConsentFile(bumped, consentFilePath);
    return bumped;
  });
  rmSync(options.recordingsDirectory ?? wireGatewaySubdirPath('recordings'), { recursive: true, force: true });
  return consent;
}

export interface FileWireRecordingConsentOptions {
  /** CLAUDE_MEM_WIRE_GATEWAY_RECORDING=false: recording is off whatever the file says. */
  recordingForcedOff: boolean;
  /** Test seam; defaults to <DATA_DIR>/wire-gateway/consent.json. */
  consentFilePath?: string;
}

/** The daemon's view of the consent file (WireRecordingConsent). */
export class FileWireRecordingConsent implements WireRecordingConsent {
  private readonly consentFilePath: string;
  private readonly recordingForcedOff: boolean;
  private warnedUnreadable = false;

  constructor(options: FileWireRecordingConsentOptions) {
    this.consentFilePath = options.consentFilePath ?? paths.wireGatewayConsent();
    this.recordingForcedOff = options.recordingForcedOff;
  }

  private readDecision(): WireRecordingConsentFile | null {
    try {
      const consent = readWireRecordingConsentFile(this.consentFilePath);
      this.warnedUnreadable = false;
      return consent;
    } catch (error) {
      // Unknown is not "yes": recording stays off until the file is fixed.
      if (!this.warnedUnreadable) {
        this.warnedUnreadable = true;
        logger.warn('WIRE', 'Wire recording consent file is unreadable; recording is off', { consentFilePath: this.consentFilePath },
          error instanceof Error ? error : new Error(String(error)));
      }
      return null;
    }
  }

  isRecordingOn(): boolean {
    return !this.recordingForcedOff && this.readDecision()?.recording === true;
  }

  recordingGeneration(): number {
    return this.readDecision()?.generation ?? 0;
  }
}
