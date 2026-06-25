// src/services/worker/agents/respawn-policy.ts
import { join } from 'path';
import { logger } from '../../../utils/logger.js';
import type { ObserverOutputClass } from '../../../sdk/output-classifier.js';
import { SettingsDefaultsManager } from '../../../shared/SettingsDefaultsManager.js';

/**
 * Output classes that MAY be configured exempt from the respawn window.
 * 'xml' is valid (never reaches the counter); 'poisoned' is always-immediate
 * and is intentionally NOT exemptable.
 */
export const EXEMPTABLE_CLASSES = ['idle', 'prose'] as const satisfies readonly ObserverOutputClass[];
export type ExemptableClass = typeof EXEMPTABLE_CLASSES[number];

const EXEMPTABLE_SET = new Set<string>(EXEMPTABLE_CLASSES);

/** Sole string→ExemptableClass narrowing site (parse-don't-validate). */
export function isExemptableClass(x: string): x is ExemptableClass {
  return EXEMPTABLE_SET.has(x);
}

// Bounds + defaults (no-hardcoded-magic-numbers). Defaults mirror SettingsDefaults.
export const RESPAWN_THRESHOLD_BOUNDS = { min: 1, max: 100 } as const;
export const RESPAWN_WINDOW_MS_BOUNDS = { min: 1000, max: 3_600_000 } as const;
export const DEFAULT_RESPAWN_THRESHOLD = 3;          // was INVALID_OUTPUT_RESPAWN_THRESHOLD (#2485)
export const DEFAULT_RESPAWN_WINDOW_MS = 60_000;     // 1 min — trips ~1-bad/15s wedge in ~45s; lets blips decay
export const DEFAULT_EXEMPT_CLASSES: readonly ExemptableClass[] = ['idle'];

export interface RespawnPolicy {
  readonly exemptClasses: ReadonlySet<ExemptableClass>;
  readonly threshold: number;
  readonly windowMs: number;
}

export interface FailureWindow {
  windowStart: number;
  badCount: number;
}

export function freshWindow(): FailureWindow {
  // windowStart: 0 is a placeholder; it is never read for an expiry decision —
  // the first non-exempt output re-anchors it via the `badCount === 0` branch in evaluateRespawn.
  return { windowStart: 0, badCount: 0 };
}

function parseBoundedInt(
  raw: string,
  bounds: { min: number; max: number },
  fallback: number,
  name: string,
): number {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < bounds.min || n > bounds.max) {
    logger.warn('SYSTEM', `Invalid ${name}, using default`, {
      value: raw, min: bounds.min, max: bounds.max, fallback,
    });
    return fallback;
  }
  return n;
}

export function parseRespawnPolicy(
  exemptRaw: string,
  thresholdRaw: string,
  windowMsRaw: string,
): RespawnPolicy {
  const tokens = exemptRaw.split(',').map(t => t.trim()).filter(Boolean);
  const exemptClasses = new Set<ExemptableClass>();
  for (const tok of tokens) {
    if (isExemptableClass(tok)) {
      exemptClasses.add(tok);
    } else {
      logger.warn('SYSTEM', `Unknown exempt output class "${tok}" — ignored`, { value: tok });
    }
  }
  // `exemptClasses` is typed ReadonlySet (compile-time immutability). We do not
  // Object.freeze it: freezing a Set blocks property writes but NOT Set.add/
  // delete (they mutate internal slots), so it would give false runtime
  // confidence. For this internal, freshly-constructed value the structural
  // ReadonlySet guarantee is sufficient and intentional (design §9).
  return {
    exemptClasses: exemptClasses.size > 0
      ? exemptClasses
      : new Set<ExemptableClass>(DEFAULT_EXEMPT_CLASSES),
    threshold: parseBoundedInt(
      thresholdRaw, RESPAWN_THRESHOLD_BOUNDS, DEFAULT_RESPAWN_THRESHOLD,
      'CLAUDE_MEM_INVALID_OUTPUT_RESPAWN_THRESHOLD',
    ),
    windowMs: parseBoundedInt(
      windowMsRaw, RESPAWN_WINDOW_MS_BOUNDS, DEFAULT_RESPAWN_WINDOW_MS,
      'CLAUDE_MEM_INVALID_OUTPUT_WINDOW_MS',
    ),
  };
}

function assertNeverClass(x: never): never {
  throw new Error(`Unhandled ObserverOutputClass: ${String(x)}`);
}

/**
 * Decide whether an observer output should trigger a session respawn,
 * using a time-windowed burst counter (systemd StartLimitBurst / Erlang OTP
 * intensity-period). `poisoned` → immediate; exempt classes → invisible; all
 * other classes accumulate within `windowMs` until `threshold`. Pure; `now` is
 * injected for testability. The window is anchored at the first bad output
 * (badCount===0) and re-anchored when it expires.
 */
export function evaluateRespawn(
  cls: ObserverOutputClass,
  window: FailureWindow,
  policy: RespawnPolicy,
  now: number,
): { window: FailureWindow; shouldRespawn: boolean } {
  switch (cls) {
    case 'poisoned':
      return { window: freshWindow(), shouldRespawn: true };
    case 'idle':
    case 'prose':
    case 'xml': {
      // Exempt classes are invisible to the window. ('xml' is never exemptable,
      // so an xml-tagged-but-unparseable output still counts — preserving the
      // prior recovery behavior for malformed observation blocks.)
      if (isExemptableClass(cls) && policy.exemptClasses.has(cls)) {
        return { window, shouldRespawn: false };
      }
      const startFresh = window.badCount === 0 || (now - window.windowStart > policy.windowMs);
      const base = startFresh ? { windowStart: now, badCount: 0 } : window;
      const badCount = base.badCount + 1;
      const shouldRespawn = badCount >= policy.threshold;
      return {
        window: shouldRespawn ? freshWindow() : { windowStart: base.windowStart, badCount },
        shouldRespawn,
      };
    }
    default:
      return assertNeverClass(cls);
  }
}

let cachedPolicy: RespawnPolicy | null = null;

function respawnSettingsPath(): string {
  // Call-time resolution (mirrors worker-utils.getWorkerSettingsPath) so test
  // isolation via CLAUDE_MEM_DATA_DIR and runtime env overrides both work.
  return join(SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR'), 'settings.json');
}

/**
 * Resolve the respawn policy once from settings (env → settings.json, mirroring
 * worker-utils' settings-backed timeout). Cached; call clearRespawnPolicyCache()
 * in tests or after a settings change.
 */
export function getRespawnPolicy(): RespawnPolicy {
  if (cachedPolicy !== null) {
    return cachedPolicy;
  }
  const s = SettingsDefaultsManager.loadFromFile(respawnSettingsPath());
  cachedPolicy = parseRespawnPolicy(
    s.CLAUDE_MEM_INVALID_OUTPUT_EXEMPT_CLASSES,
    s.CLAUDE_MEM_INVALID_OUTPUT_RESPAWN_THRESHOLD,
    s.CLAUDE_MEM_INVALID_OUTPUT_WINDOW_MS,
  );
  return cachedPolicy;
}

export function clearRespawnPolicyCache(): void {
  cachedPolicy = null;
}
