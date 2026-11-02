/**
 * Cuts worker/plugin PostHog volume without dropping the fields saved insights
 * read.
 *
 * High-volume events are summed into one event per install per UTC day and sent
 * when that day closes (the next capture on a later day, including after a
 * restart). `worker_started` / `worker_stopped` are the same shape, with
 * `restart_count`. Failures are one event per error type per day, with `count`.
 * `work_view_opened` is not a daily rollup: at most one per view per install
 * per minute. The file is the source of truth, so a restart does not zero it.
 *
 * Install, auth, trial, checkout, subscription and pageview events are not in
 * this gate. Tests set CLAUDE_MEM_TELEMETRY_IMMEDIATE=1 to observe each capture
 * at the call, which is what the existing suite asserts.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { resolveDataDir } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import { isErrorTelemetryEnabled } from './consent.js';

export const TELEMETRY_DAILY_FILENAME = 'telemetry-daily.json';
export const WORK_VIEW_OPEN_INTERVAL_MS = 60_000;

const DAILY_ROLLUP_EVENTS = new Set([
  'observer_turn_rollup',
  'work_state_usage_rollup',
  'context_injected_rollup',
  'search_performed',
  'skill_invoked',
]);

const DAILY_LIFECYCLE_EVENTS = new Set(['worker_started', 'worker_stopped']);

const DAILY_ERROR_EVENTS = new Set(['worker_start_failed', 'hook_failed', '$exception']);

/** Averages are weighted by `count` (or 1). Timestamps and sequences are not sums. */
const WEIGHTED_AVERAGE_KEYS = new Set(['avg_duration_ms', 'avg_compression_ms', 'avg_tokens']);

export interface PendingTelemetryEvent {
  event: string;
  properties: Record<string, unknown>;
}

interface ModeCount { [value: string]: number }

interface RollupBucket {
  events: number;
  /** Sum of incoming `count` when any event carried one; otherwise unused. */
  counted: number | null;
  sums: Record<string, number>;
  weighted: Record<string, number>;
  weight: number;
  min: Record<string, number>;
  max: Record<string, number>;
  modes: Record<string, ModeCount>;
}

interface CountedProps {
  count: number;
  props: Record<string, unknown>;
}

interface DailyFile {
  day: string;
  rollups: Record<string, RollupBucket>;
  lifecycle: Record<string, CountedProps>;
  errors: Record<string, CountedProps>;
  /** view → epoch ms of the last forwarded work_view_opened. Survives the day roll. */
  openedAt: Record<string, number>;
}

let clock: () => number = () => Date.now();
let filePathOverride: string | null = null;

export function telemetryVolumeIsImmediate(): boolean {
  return process.env.CLAUDE_MEM_TELEMETRY_IMMEDIATE === '1';
}

export function __setTelemetryVolumeClockForTests(now: (() => number) | null): void {
  clock = now ?? (() => Date.now());
}

export function __setTelemetryVolumePathForTests(path: string | null): void {
  filePathOverride = path;
}

export function __resetTelemetryVolumeForTests(): void {
  clock = () => Date.now();
  filePathOverride = null;
}

function volumeNow(): number {
  return clock();
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function statePath(): string {
  return filePathOverride ?? join(resolveDataDir(), TELEMETRY_DAILY_FILENAME);
}

function emptyState(day: string, openedAt: Record<string, number> = {}): DailyFile {
  return { day, rollups: {}, lifecycle: {}, errors: {}, openedAt };
}

function readState(now: number): DailyFile {
  const path = statePath();
  try {
    if (!existsSync(path)) return emptyState(utcDay(now));
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<DailyFile>;
    if (!parsed || typeof parsed !== 'object') return emptyState(utcDay(now));
    return {
      day: typeof parsed.day === 'string' ? parsed.day : utcDay(now),
      rollups: parsed.rollups && typeof parsed.rollups === 'object' ? parsed.rollups : {},
      lifecycle: parsed.lifecycle && typeof parsed.lifecycle === 'object' ? parsed.lifecycle : {},
      errors: parsed.errors && typeof parsed.errors === 'object' ? parsed.errors : {},
      openedAt: parsed.openedAt && typeof parsed.openedAt === 'object' ? parsed.openedAt : {},
    };
  } catch (error) {
    logger.warn('SYSTEM', 'Telemetry daily file could not be read; starting a fresh day', undefined, error instanceof Error ? error : new Error(String(error)));
    return emptyState(utcDay(now));
  }
}

function writeState(state: DailyFile): void {
  const path = statePath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, path);
  } catch (error) {
    logger.warn('SYSTEM', 'Telemetry daily file could not be written', undefined, error instanceof Error ? error : new Error(String(error)));
  }
}

function plainProps(props: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('$')) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') copy[key] = value;
  }
  return copy;
}

function emptyBucket(): RollupBucket {
  return { events: 0, counted: null, sums: {}, weighted: {}, weight: 0, min: {}, max: {}, modes: {} };
}

function mergeRollup(bucket: RollupBucket, props: Record<string, unknown>): void {
  const weight = typeof props.count === 'number' && Number.isFinite(props.count) && props.count > 0 ? props.count : 1;
  bucket.events += 1;
  bucket.weight += weight;
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (key === 'count') {
        bucket.counted = (bucket.counted ?? 0) + value;
      } else if (key === 'window_start_ts') {
        bucket.min[key] = bucket.min[key] === undefined ? value : Math.min(bucket.min[key], value);
      } else if (key === 'window_seq') {
        bucket.max[key] = bucket.max[key] === undefined ? value : Math.max(bucket.max[key], value);
      } else if (WEIGHTED_AVERAGE_KEYS.has(key)) {
        bucket.weighted[key] = (bucket.weighted[key] ?? 0) + value * weight;
      } else {
        bucket.sums[key] = (bucket.sums[key] ?? 0) + value;
      }
    } else if (typeof value === 'string' || typeof value === 'boolean') {
      const mode = bucket.modes[key] ?? {};
      const label = String(value);
      mode[label] = (mode[label] ?? 0) + weight;
      bucket.modes[key] = mode;
    }
  }
}

function dominant(mode: ModeCount): string | boolean | undefined {
  let best: string | undefined;
  let bestCount = -1;
  for (const [label, count] of Object.entries(mode)) {
    if (count > bestCount) {
      best = label;
      bestCount = count;
    }
  }
  if (best === undefined) return undefined;
  if (best === 'true') return true;
  if (best === 'false') return false;
  return best;
}

function rollupProperties(bucket: RollupBucket): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    count: bucket.counted ?? bucket.events,
  };
  for (const [key, value] of Object.entries(bucket.sums)) properties[key] = value;
  for (const [key, value] of Object.entries(bucket.min)) properties[key] = value;
  for (const [key, value] of Object.entries(bucket.max)) properties[key] = value;
  if (bucket.weight > 0) {
    for (const [key, value] of Object.entries(bucket.weighted)) properties[key] = value / bucket.weight;
  }
  for (const [key, mode] of Object.entries(bucket.modes)) {
    const value = dominant(mode);
    if (value !== undefined) properties[key] = value;
  }
  return properties;
}

function errorIdentity(event: string, props: Record<string, unknown>): string {
  const text = (key: string) => typeof props[key] === 'string' && props[key] ? String(props[key]) : 'unknown';
  if (event === 'worker_start_failed') return `worker_start_failed:${text('error_category')}`;
  if (event === 'hook_failed') return `hook_failed:${text('hook_type')}:${text('error_mode')}`;
  return `$exception:${text('error_type') || text('$exception_type')}`;
}

function closedEvents(state: DailyFile): PendingTelemetryEvent[] {
  const pending: PendingTelemetryEvent[] = [];
  for (const [event, bucket] of Object.entries(state.rollups)) {
    if (bucket.events <= 0) continue;
    pending.push({ event, properties: rollupProperties(bucket) });
  }
  for (const [event, entry] of Object.entries(state.lifecycle)) {
    if (entry.count <= 0) continue;
    pending.push({ event, properties: { ...entry.props, restart_count: entry.count } });
  }
  for (const [key, entry] of Object.entries(state.errors)) {
    if (entry.count <= 0) continue;
    const event = key.startsWith('$exception:') ? '$exception' : key.startsWith('hook_failed:') ? 'hook_failed' : 'worker_start_failed';
    const properties: Record<string, unknown> = { ...entry.props, count: entry.count };
    if (event === '$exception') properties.occurrence_count = entry.count;
    pending.push({ event, properties });
  }
  return pending;
}

/**
 * Fold one scrubbed event into today's file. `forward` means send it now.
 * `closed` is yesterday's (or older) daily events, which the caller sends once.
 */
export function observeTelemetryVolume(
  event: string,
  properties: Record<string, unknown>,
  now = volumeNow(),
): { forward: boolean; closed: PendingTelemetryEvent[] } {
  if (telemetryVolumeIsImmediate()) return { forward: true, closed: [] };

  const state = readState(now);
  const today = utcDay(now);
  let closed: PendingTelemetryEvent[] = [];
  let dayRolled = false;
  if (state.day !== today) {
    // Checked at send time, for the worker and the CLI alike: the row may have been saved before the person opted out.
    closed = closedEvents(state).filter(item => item.event !== '$exception' || isErrorTelemetryEnabled(process.env));
    const openedAt = { ...state.openedAt };
    const fresh = emptyState(today, openedAt);
    state.day = fresh.day;
    state.rollups = fresh.rollups;
    state.lifecycle = fresh.lifecycle;
    state.errors = fresh.errors;
    state.openedAt = openedAt;
    dayRolled = true;
  }

  const props = plainProps(properties);

  if (event === 'work_view_opened') {
    const view = typeof props.view === 'string' ? props.view : 'unknown';
    const last = state.openedAt[view] ?? 0;
    if (now - last < WORK_VIEW_OPEN_INTERVAL_MS) {
      writeState(state);
      return { forward: false, closed };
    }
    state.openedAt[view] = now;
    writeState(state);
    return { forward: true, closed };
  }

  if (DAILY_ROLLUP_EVENTS.has(event)) {
    const bucket = state.rollups[event] ?? emptyBucket();
    mergeRollup(bucket, props);
    state.rollups[event] = bucket;
    writeState(state);
    return { forward: false, closed };
  }

  if (DAILY_LIFECYCLE_EVENTS.has(event)) {
    const previous = state.lifecycle[event];
    const count = (previous?.count ?? 0) + 1;
    state.lifecycle[event] = { count, props: { ...props, restart_count: count } };
    writeState(state);
    return { forward: false, closed };
  }

  if (DAILY_ERROR_EVENTS.has(event)) {
    const key = errorIdentity(event, props);
    const previous = state.errors[key];
    const count = (previous?.count ?? 0) + 1;
    // Keep the first occurrence's text so a later message cannot replace a
    // redacted sample the day already stored. The count still moves.
    state.errors[key] = { count, props: previous?.props ?? props };
    writeState(state);
    return { forward: false, closed };
  }

  if (dayRolled) writeState(state);
  return { forward: true, closed };
}

/** Test seam: delete the daily file so the next observe starts clean. */
export function __clearTelemetryVolumeFileForTests(): void {
  const path = statePath();
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // A missing file is the state the next test wants.
  }
}
