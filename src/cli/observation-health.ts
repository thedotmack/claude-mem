/**
 * Observation Health Tracking
 *
 * Tracks PostToolUse observation failures in a temp file so that
 * UserPromptSubmit can report them to Claude at the next natural checkpoint.
 * Self-heals: any successful observation clears the failure counter.
 */

import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { DATA_DIR, getPackageRoot } from '../shared/paths.js';
import { join } from 'path';

const HEALTH_FILE = join(DATA_DIR, '.obs-health');

function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(getPackageRoot(), 'package.json'), 'utf8')) as { version: string };
    return pkg.version;
  } catch {
    return 'unknown';
  }
}

interface ObservationHealth {
  failures: number;
  lastError: string;
  since: string;
  version: string;
}

export function recordObservationFailure(error: string): void {
  try {
    let health: ObservationHealth;
    try {
      health = JSON.parse(readFileSync(HEALTH_FILE, 'utf8')) as ObservationHealth;
      health.failures += 1;
      health.lastError = error;
    } catch {
      health = { failures: 1, lastError: error, since: new Date().toISOString(), version: getVersion() };
    }
    writeFileSync(HEALTH_FILE, JSON.stringify(health));
  } catch {
    // Best-effort — don't let health tracking itself cause failures
  }
}

export function recordObservationSuccess(): void {
  try {
    unlinkSync(HEALTH_FILE);
  } catch {
    // File may not exist — that's fine
  }
}

export function readAndClearObservationHealth(): ObservationHealth | null {
  try {
    const raw = readFileSync(HEALTH_FILE, 'utf8');
    const health = JSON.parse(raw) as ObservationHealth;
    unlinkSync(HEALTH_FILE);
    return health;
  } catch {
    return null;
  }
}
