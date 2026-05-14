
import path from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { logger } from '../utils/logger.js';
import { DATA_DIR } from './paths.js';
import { loadFromFileOnce } from './hook-settings.js';

// Circuit breaker states
export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN' | 'OPEN_PERMANENT';

interface BreakerPersistentState {
  state: BreakerState;
  consecutiveFailures: number;
  lifetimeFailures: number;
  openedAt: number | null;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
  lastTrippedAt: number | null;
}

function getStateDir(): string {
  return path.join(DATA_DIR, 'state');
}

function getBreakerStatePath(): string {
  return path.join(getStateDir(), 'circuit-breaker.json');
}

/** Exported for testing only — returns the path of the circuit breaker state file. */
export function getBreakerStatePathForTesting(): string {
  return getBreakerStatePath();
}

function readBreakerState(): BreakerPersistentState {
  try {
    const raw = readFileSync(getBreakerStatePath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<BreakerPersistentState>;
    const validStates: BreakerState[] = ['CLOSED', 'OPEN', 'HALF_OPEN', 'OPEN_PERMANENT'];
    return {
      state: validStates.includes(parsed.state as BreakerState)
        ? (parsed.state as BreakerState)
        : 'CLOSED',
      consecutiveFailures:
        typeof parsed.consecutiveFailures === 'number' && Number.isFinite(parsed.consecutiveFailures)
          ? Math.max(0, Math.floor(parsed.consecutiveFailures))
          : 0,
      lifetimeFailures:
        typeof parsed.lifetimeFailures === 'number' && Number.isFinite(parsed.lifetimeFailures)
          ? Math.max(0, Math.floor(parsed.lifetimeFailures))
          : 0,
      openedAt: typeof parsed.openedAt === 'number' ? parsed.openedAt : null,
      lastFailureAt: typeof parsed.lastFailureAt === 'number' ? parsed.lastFailureAt : null,
      lastSuccessAt: typeof parsed.lastSuccessAt === 'number' ? parsed.lastSuccessAt : null,
      lastTrippedAt: typeof parsed.lastTrippedAt === 'number' ? parsed.lastTrippedAt : null,
    };
  } catch {
    // Attempt to migrate from old hook-failures.json format
    return migrateFromLegacyHookFailures();
  }
}

function migrateFromLegacyHookFailures(): BreakerPersistentState {
  const legacyPath = path.join(getStateDir(), 'hook-failures.json');
  try {
    const raw = readFileSync(legacyPath, 'utf-8');
    const parsed = JSON.parse(raw) as { consecutiveFailures?: number; lastFailureAt?: number };
    const consecutiveFailures =
      typeof parsed.consecutiveFailures === 'number' && Number.isFinite(parsed.consecutiveFailures)
        ? Math.max(0, Math.floor(parsed.consecutiveFailures))
        : 0;
    return {
      state: 'CLOSED',
      consecutiveFailures,
      lifetimeFailures: consecutiveFailures,
      openedAt: null,
      lastFailureAt:
        typeof parsed.lastFailureAt === 'number' ? parsed.lastFailureAt : null,
      lastSuccessAt: null,
      lastTrippedAt: null,
    };
  } catch {
    return {
      state: 'CLOSED',
      consecutiveFailures: 0,
      lifetimeFailures: 0,
      openedAt: null,
      lastFailureAt: null,
      lastSuccessAt: null,
      lastTrippedAt: null,
    };
  }
}

function writeBreakerStateAtomic(state: BreakerPersistentState): void {
  const stateDir = getStateDir();
  const dest = getBreakerStatePath();
  const tmp = `${dest}.tmp`;
  try {
    if (!existsSync(stateDir)) {
      mkdirSync(stateDir, { recursive: true });
    }
    writeFileSync(tmp, JSON.stringify(state), 'utf-8');
    renameSync(tmp, dest);
  } catch (error: unknown) {
    logger.debug('SYSTEM', 'Failed to persist circuit-breaker state', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function readEnvInt(
  name: string,
  defaultVal: number,
  bounds: { min: number; max: number }
): number {
  // Check process.env first (highest priority)
  const envVal = process.env[name];
  if (envVal !== undefined) {
    const parsed = parseInt(envVal, 10);
    if (Number.isFinite(parsed) && parsed >= bounds.min && parsed <= bounds.max) {
      return parsed;
    }
  }

  // Then check settings file
  try {
    const settings = loadFromFileOnce();
    const raw = (settings as Record<string, string>)[name];
    if (raw !== undefined) {
      const parsed = parseInt(raw, 10);
      if (Number.isFinite(parsed) && parsed >= bounds.min && parsed <= bounds.max) {
        return parsed;
      }
    }
  } catch {
    // settings unreadable
  }
  return defaultVal;
}

/**
 * CircuitBreaker — prevents runaway hook loops from hammering an unreachable
 * worker. State machine:
 *
 *   CLOSED       ─[N consecutive failures]──> OPEN
 *   OPEN         ─[reset timeout elapsed]───> HALF_OPEN
 *   HALF_OPEN    ─[1 success]──────────────> CLOSED
 *   HALF_OPEN    ─[1 failure]──────────────> OPEN (timer reset)
 *   ANY          ─[lifetime > cap]──────────> OPEN_PERMANENT
 *
 * All state is persisted to ~/.claude-mem/state/circuit-breaker.json so that
 * the counter survives across hook invocations (each hook is a separate process).
 */
export class CircuitBreaker {
  private static _instance: CircuitBreaker | null = null;

  /** Return the singleton instance (used by executeWithWorkerFallback). */
  static getInstance(): CircuitBreaker {
    if (!CircuitBreaker._instance) {
      CircuitBreaker._instance = new CircuitBreaker();
    }
    return CircuitBreaker._instance;
  }

  /** Reset singleton (for tests). */
  static resetInstance(): void {
    CircuitBreaker._instance = null;
  }

  private get failureThreshold(): number {
    return readEnvInt('CLAUDE_MEM_BREAKER_FAILURE_THRESHOLD', 5, { min: 1, max: 50 });
  }

  private get resetTimeoutMs(): number {
    return readEnvInt('CLAUDE_MEM_BREAKER_RESET_TIMEOUT_MS', 30000, {
      min: 1000,
      max: 600000,
    });
  }

  private get lifetimeCap(): number {
    return readEnvInt('CLAUDE_MEM_BREAKER_LIFETIME_CAP', 50, { min: 0, max: 10000 });
  }

  /**
   * Returns true if the caller is allowed to attempt a worker request.
   * When false the caller should immediately fall back without making HTTP.
   */
  canAttempt(): boolean {
    const s = readBreakerState();

    if (s.state === 'OPEN_PERMANENT') {
      return false;
    }

    if (s.state === 'OPEN') {
      if (s.openedAt === null) {
        // openedAt missing — stay open until a valid timestamp is available
        return false;
      }
      const elapsed = Date.now() - s.openedAt;
      if (elapsed >= this.resetTimeoutMs) {
        // Transition to HALF_OPEN — write the new state so next call sees it
        const next: BreakerPersistentState = { ...s, state: 'HALF_OPEN' };
        writeBreakerStateAtomic(next);
        logger.info('SYSTEM', 'CircuitBreaker: transitioned OPEN -> HALF_OPEN (probe allowed)', {
          consecutiveFailures: s.consecutiveFailures,
          lifetimeFailures: s.lifetimeFailures,
          elapsedMs: elapsed,
        });
        return true;
      }
      return false;
    }

    return true; // CLOSED or HALF_OPEN
  }

  /**
   * Called when a worker request fails (unreachable or hard error).
   */
  recordFailure(reason?: string): void {
    const s = readBreakerState();
    const now = Date.now();
    const newConsecutive = s.consecutiveFailures + 1;
    const newLifetime = s.lifetimeFailures + 1;

    // Check lifetime cap (0 = no cap)
    const cap = this.lifetimeCap;
    if (cap > 0 && newLifetime >= cap) {
      const next: BreakerPersistentState = {
        ...s,
        state: 'OPEN_PERMANENT',
        consecutiveFailures: newConsecutive,
        lifetimeFailures: newLifetime,
        lastFailureAt: now,
        lastTrippedAt: now,
      };
      writeBreakerStateAtomic(next);
      logger.error('SYSTEM', 'CircuitBreaker: OPEN_PERMANENT — too many lifetime failures', {
        lifetime: newLifetime,
        cap,
        reason,
      });
      process.stderr.write(
        `claude-mem: ${newLifetime} lifetime worker failures detected. Memory hooks suspended until reset. POST http://127.0.0.1:${process.env.CLAUDE_MEM_WORKER_PORT ?? '37777'}/api/admin/breaker/reset to resume.\n`
      );
      return;
    }

    const threshold = this.failureThreshold;
    let newState: BreakerState = s.state;
    let openedAt = s.openedAt;
    let lastTrippedAt = s.lastTrippedAt;

    // Determine whether this failure should open (or re-open) the breaker:
    //   - CLOSED: open once consecutive failures reach the threshold
    //   - HALF_OPEN: a probe failure immediately re-opens
    //   - OPEN: already open; counter increments but state stays OPEN
    const triggersOpen =
      (s.state === 'CLOSED' && newConsecutive >= threshold) || s.state === 'HALF_OPEN';

    if (triggersOpen) {
      newState = 'OPEN';
      openedAt = now;
      lastTrippedAt = now;
      logger.warn('SYSTEM', 'CircuitBreaker: OPEN — worker unreachable', {
        consecutiveFailures: newConsecutive,
        lifetimeFailures: newLifetime,
        reason,
      });
      const retryInSec = Math.round(this.resetTimeoutMs / 1000);
      process.stderr.write(
        `claude-mem worker unreachable; circuit breaker OPEN; will retry in ${retryInSec}s\n`
      );
    }

    const next: BreakerPersistentState = {
      ...s,
      state: newState,
      consecutiveFailures: newConsecutive,
      lifetimeFailures: newLifetime,
      openedAt,
      lastFailureAt: now,
      lastTrippedAt,
    };
    writeBreakerStateAtomic(next);
  }

  /**
   * Called when a worker request succeeds.
   */
  recordSuccess(): void {
    const s = readBreakerState();
    if (s.consecutiveFailures === 0 && s.state === 'CLOSED') return;

    const wasRecovering = s.state !== 'CLOSED';
    const recoveredAfterMs = wasRecovering && s.openedAt ? Date.now() - s.openedAt : 0;

    const next: BreakerPersistentState = {
      ...s,
      state: 'CLOSED',
      consecutiveFailures: 0,
      openedAt: null,
      lastSuccessAt: Date.now(),
    };
    writeBreakerStateAtomic(next);

    if (wasRecovering) {
      logger.info('SYSTEM', 'CircuitBreaker: CLOSED — worker recovered', {
        recoveredAfterMs,
        lifetimeFailures: s.lifetimeFailures,
      });
    }
  }

  /**
   * Force-reset the circuit breaker to CLOSED state (e.g. via admin API).
   */
  forceReset(): void {
    const s = readBreakerState();
    const next: BreakerPersistentState = {
      ...s,
      state: 'CLOSED',
      consecutiveFailures: 0,
      openedAt: null,
      lastSuccessAt: Date.now(),
    };
    writeBreakerStateAtomic(next);
    logger.warn('SYSTEM', 'CircuitBreaker: force-reset to CLOSED', {
      previousState: s.state,
      lifetimeFailures: s.lifetimeFailures,
    });
  }

  /** Read current persistent state (for diagnostics/API). */
  getState(): BreakerPersistentState {
    return readBreakerState();
  }
}
