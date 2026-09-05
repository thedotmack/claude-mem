/**
 * Per-provider quota circuit breaker (#3634).
 *
 * When a provider reports the user's inference allowance exhausted, nothing
 * stopped the worker from trying again: the generator exits, and the very next
 * captured tool call runs `ensureGeneratorRunning`, which starts a fresh
 * generator, sends one more request, and earns the same refusal. There is one
 * doomed request per observation, for the rest of the billing cycle — 11 capped
 * users produced tens of thousands of cap events in a single day, roughly a
 * hundred per successful observation.
 *
 * `ensureGeneratorRunning` already has exactly this gate for a missing Claude
 * CLI (`setup_required` + `CLAUDE_CLI_SETUP_RECHECK_COOLDOWN_MS`). This is the
 * same shape for quota, kept separate because quota is per-provider user state
 * rather than a machine-wide dependency.
 *
 * The breaker arms on a quota-exhausted generator exit, expires after a
 * cooldown so a single request can re-probe, and clears immediately on success
 * — so recovery costs at most one cooldown window, not a manual restart.
 *
 * PERSISTENCE, and the deliberate split within it.
 *
 * The armed window is written to disk beside `observer-health.json`, for the
 * reason that file's own docblock already gives: the state must survive worker
 * restarts. An in-memory-only breaker is cleared by every restart — the
 * `/api/admin/restart` endpoint (the process serving it IS the process holding
 * the Map), `npx claude-mem restart`, a reboot, a plugin-version SIGKILL, a
 * crash-and-respawn, and this repo's own documented `npm run build-and-sync`.
 * A crash-restart loop is the worst shape: crash, respawn, empty breaker,
 * doomed request, repeat — the storm again with extra steps.
 *
 * The probe claim (`probeInFlightSinceMs` / `probeClaimId`) is deliberately NOT
 * persisted, and must load as null. It is single-process concurrency state: a
 * restart kills every generator that could be holding one, so a claim restored
 * from disk would be owned by a dead process and would wedge the provider shut
 * until it went stale — the opposite of the failure this breaker prevents.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { paths } from './paths.js';
import { logger } from '../utils/logger.js';

export type QuotaProvider = 'claude' | 'gemini' | 'openrouter' | 'codex' | 'codex-setup' | 'cmem-gateway';

/** Separate from allowance exhaustion: recheck missing CLI/login after repair. */
export const CODEX_SETUP_RECHECK_COOLDOWN_MS = 5 * 60_000;

export const QUOTA_COOLDOWN_FILENAME = 'quota-cooldown.json';

/**
 * The persisted half of a breaker: the armed window only. Never the claim.
 */
interface PersistedQuotaCooldown {
  provider: QuotaProvider;
  message: string;
  window?: string;
  armedAtMs: number;
}

function defaultCooldownFilePath(): string {
  return join(paths.dataDir(), QUOTA_COOLDOWN_FILENAME);
}

let hydrated = false;

/** Read the armed windows written by a previous process, once per process. */
function hydrateFromDisk(filePath: string = defaultCooldownFilePath()): void {
  if (hydrated) return;
  hydrated = true;
  try {
    if (!existsSync(filePath)) return;
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf-8'));
    if (!Array.isArray(parsed)) return;
    for (const entry of parsed as PersistedQuotaCooldown[]) {
      if (!entry || typeof entry.provider !== 'string' || typeof entry.armedAtMs !== 'number') continue;
      cooldowns.set(entry.provider, {
        provider: entry.provider,
        message: entry.message ?? 'Provider reported the inference allowance exhausted',
        ...(entry.window ? { window: entry.window } : {}),
        armedAtMs: entry.armedAtMs,
        // Never restored: the process that could have held this is gone.
        probeInFlightSinceMs: null,
        probeClaimId: null,
      });
    }
  } catch (err) {
    // A corrupt ledger must not stop the worker; it only costs one extra
    // request to re-arm the breaker.
    logger.warn('SESSION', 'Failed to read quota-cooldown file', { filePath }, err as Error);
  }
}

function persistToDisk(filePath: string = defaultCooldownFilePath()): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    if (cooldowns.size === 0) {
      if (existsSync(filePath)) unlinkSync(filePath);
      return;
    }
    const rows: PersistedQuotaCooldown[] = [...cooldowns.values()].map((state) => ({
      provider: state.provider,
      message: state.message,
      ...(state.window ? { window: state.window } : {}),
      armedAtMs: state.armedAtMs,
    }));
    const tmp = `${filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(rows, null, 2), 'utf-8');
    // Atomic swap, so a reader never sees a half-written ledger.
    renameSync(tmp, filePath);
  } catch (err) {
    logger.warn('SESSION', 'Failed to write quota-cooldown file', { filePath }, err as Error);
  }
}

/**
 * How long to withhold requests after a provider reports the allowance spent.
 * Long enough that a capped user stops generating traffic, short enough that a
 * reset window (or a plan upgrade) is picked up without restarting the worker.
 */
export const QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS = 30 * 60_000;

/**
 * How long a claimed probe may stay unresolved before another caller may take
 * it. A generator that dies without reaching any completion path would
 * otherwise hold the claim forever and wedge the provider permanently — the
 * opposite failure to the one this breaker exists to prevent.
 */
export const QUOTA_PROBE_STALE_MS = 5 * 60_000;

export interface QuotaCooldownState {
  provider: QuotaProvider;
  /** Provider-reported reason, already free of any user prompt text. */
  message: string;
  /** Window the provider named, when it named one (e.g. 'weekly'). */
  window?: string;
  armedAtMs: number;
  /**
   * When the single post-expiry probe was claimed, or null when none is in
   * flight. Without this the expiry check is a bare read: every concurrent
   * session passes it at once and they all hit the provider together, which on
   * a busy machine (#3800 saw 28-69 live sessions) turns "one probe per window"
   * back into a burst.
   */
  probeInFlightSinceMs: number | null;
  /**
   * Identifies the claim currently in flight, so only the caller that took it
   * can release it. A generator admitted while no breaker existed holds no
   * claim at all; without this id its exit would clear whatever probe a later
   * session had since started, readmitting a third session while the real
   * probe is still running.
   */
  probeClaimId: number | null;
}

/**
 * The result of an admission attempt. `claimId` is null on an admission that
 * took no claim — there was no breaker to claim against — and releasing must be
 * keyed on it rather than on "I was admitted", because such a generator can
 * outlive a later session's real probe.
 */
export interface QuotaProbeAdmission {
  admitted: boolean;
  claimId: number | null;
}

const cooldowns = new Map<QuotaProvider, QuotaCooldownState>();

/**
 * Monotonic id for probe claims, only ever compared for equality. A claim's
 * timestamp cannot double as its identity: the testing seams admit repeat
 * claims inside a single millisecond, and two claims sharing an id would
 * reintroduce exactly the cross-session release this exists to prevent.
 */
let nextProbeClaimId = 1;

/** Arm the breaker for `provider`. Re-arming restamps the cooldown. */
export function recordQuotaExhausted(
  provider: QuotaProvider,
  message: string,
  window?: string,
  /**
   * When the window was armed. Defaults to now for a real refusal; passed
   * explicitly only when reviving a window that was armed before a restart,
   * so a reload cannot restamp it and hold the provider shut for a fresh full
   * cooldown on every restart.
   */
  armedAtMs: number = Date.now(),
): QuotaCooldownState {
  hydrateFromDisk();
  const state: QuotaCooldownState = {
    provider,
    message,
    ...(window ? { window } : {}),
    armedAtMs,
    // Re-arming ends whatever probe was in flight: this IS that probe failing.
    probeInFlightSinceMs: null,
    probeClaimId: null,
  };
  cooldowns.set(provider, state);
  persistToDisk();
  return state;
}

/** Clear the breaker — call on any successful generation for that provider. */
export function clearQuotaCooldown(provider: QuotaProvider): void {
  hydrateFromDisk();
  cooldowns.delete(provider);
  persistToDisk();
}

export function getQuotaCooldown(provider: QuotaProvider): QuotaCooldownState | null {
  hydrateFromDisk();
  return cooldowns.get(provider) ?? null;
}

/**
 * True while requests to `provider` should be withheld. Read-only — it never
 * claims the probe, so it is safe for logging and diagnostics.
 *
 * Callers deciding whether to actually send must use `tryAdmitQuotaProbe`
 * instead: this returning false only means the window elapsed, and on a machine
 * with many live sessions every one of them observes that at the same instant.
 */
export function isQuotaCooldownActive(
  provider: QuotaProvider,
  nowMs: number = Date.now(),
  cooldownMs: number = QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS,
): boolean {
  hydrateFromDisk();
  const state = cooldowns.get(provider);
  if (!state) return false;
  return nowMs - state.armedAtMs < cooldownMs;
}

/**
 * Decide whether this caller may send to `provider`, claiming the single
 * post-expiry probe if so.
 *
 * Admits when there is no breaker at all, or when the window has elapsed and no
 * probe is currently in flight. The claim is taken synchronously, so among
 * concurrent callers on this single-threaded worker exactly one wins and the
 * rest are withheld until that probe resolves — success clears the breaker,
 * failure re-arms it, and `releaseQuotaProbe` covers every other exit.
 *
 * An admission with no breaker in place carries a null `claimId`: it owns no
 * probe, and passing that null back to `releaseQuotaProbe` is what stops such a
 * generator from clearing a probe some later session claimed while it ran.
 */
export function tryAdmitQuotaProbe(
  provider: QuotaProvider,
  nowMs: number = Date.now(),
  cooldownMs: number = QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS,
): QuotaProbeAdmission {
  // A breaker armed before a restart is still armed. Without this the first
  // call in a fresh process finds an empty Map, admits, and takes no claim —
  // the herd returns at exactly the moment the breaker should be strongest.
  hydrateFromDisk();
  const state = cooldowns.get(provider);
  if (!state) return { admitted: true, claimId: null };

  if (nowMs - state.armedAtMs < cooldownMs) {
    return { admitted: false, claimId: null };
  }

  const inFlight = state.probeInFlightSinceMs;
  if (inFlight !== null && nowMs - inFlight < QUOTA_PROBE_STALE_MS) {
    return { admitted: false, claimId: null };
  }

  // A stale takeover mints a fresh id, so the abandoned owner's late release
  // finds a claim it does not own and leaves this one alone.
  const claimId = nextProbeClaimId++;
  state.probeInFlightSinceMs = nowMs;
  state.probeClaimId = claimId;
  return { admitted: true, claimId };
}

/**
 * Release the probe this run claimed, without deciding the breaker's fate.
 *
 * Called on every generator exit: if the probe succeeded the breaker is already
 * gone, and if it earned another refusal `recordQuotaExhausted` already re-armed
 * and cleared the claim. This covers the remaining exits (abort, crash, an
 * unrelated error) so a claim can never outlive the request that took it.
 *
 * `claimId` scopes that to the caller's own claim. Generators overlap freely —
 * one admitted before any breaker existed can exit long after a later session
 * claimed the sole post-cooldown probe — so an unscoped release would clear a
 * probe still in flight and admit a third session behind it.
 */
export function releaseQuotaProbe(provider: QuotaProvider, claimId: number | null): void {
  // Admitted with no breaker armed: this run never owned a probe, and any probe
  // in flight now belongs to a different session.
  if (claimId === null) return;
  hydrateFromDisk();

  const state = cooldowns.get(provider);
  if (state && state.probeClaimId === claimId) {
    state.probeInFlightSinceMs = null;
    state.probeClaimId = null;
  }
}

export function resetQuotaCooldownsForTesting(): void {
  cooldowns.clear();
  // The latch must drop too, or a test that wrote a ledger would leak its
  // armed windows into the next test through a stale "already hydrated".
  hydrated = false;
  try {
    const filePath = defaultCooldownFilePath();
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch {
    // Nothing to clean up.
  }
}
