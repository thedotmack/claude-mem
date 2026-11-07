/**
 * One cmem.ai allowance-exhausted probe per install per day.
 *
 * The gateway emits `pro_inference_cap_exhausted` on every request that finds
 * the cap spent. After the first refusal the observer used to ask again: the
 * fallback resume is immediate, and the fallback marker lets another probe
 * through every 15 minutes. A sitting worker therefore re-sends the event for
 * as long as the cap is spent. This file remembers the refusal. Dispatch and
 * the OpenRouter client both refuse another gateway send until a day has
 * passed, which is the one probe that can see the cap lifted. A successful
 * gateway response clears it (the allowance changed). Restarts read the same
 * file, so they do not probe again.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { resolveDataDir } from './paths.js';
import { logger } from '../utils/logger.js';

export const CMEM_CAP_PROBE_FILENAME = 'cmem-cap-probe.json';
export const CMEM_CAP_PROBE_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface CapProbeFile { exhaustedAtMs: number }

let pathOverride: string | null = null;

export function __setCmemCapProbePathForTests(path: string | null): void {
  pathOverride = path;
}

function probePath(): string {
  return pathOverride ?? join(resolveDataDir(), CMEM_CAP_PROBE_FILENAME);
}

function readExhaustedAt(): number | null {
  const path = probePath();
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<CapProbeFile>;
    return typeof parsed.exhaustedAtMs === 'number' && Number.isFinite(parsed.exhaustedAtMs) ? parsed.exhaustedAtMs : null;
  } catch (error) {
    logger.warn('SESSION', 'cmem cap probe file could not be read; allowing one probe', undefined, error instanceof Error ? error : new Error(String(error)));
    return null;
  }
}

/** True when a gateway request may be sent. No file means the cap is not known spent. */
export function cmemCapProbeAllowed(now = Date.now()): boolean {
  const exhaustedAt = readExhaustedAt();
  if (exhaustedAt === null) return true;
  return now - exhaustedAt >= CMEM_CAP_PROBE_INTERVAL_MS;
}

/** Remember a gateway `allowance_exhausted`. The next day is the next probe. */
export function noteCmemCapExhausted(now = Date.now()): void {
  const path = probePath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ exhaustedAtMs: now } satisfies CapProbeFile));
    renameSync(tmp, path);
  } catch (error) {
    logger.warn('SESSION', 'cmem cap probe file could not be written', undefined, error instanceof Error ? error : new Error(String(error)));
  }
}

/** A gateway response that was served means the allowance is no longer spent. */
export function clearCmemCapProbe(): void {
  const path = probePath();
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch (error) {
    logger.warn('SESSION', 'cmem cap probe file could not be cleared', undefined, error instanceof Error ? error : new Error(String(error)));
  }
}
