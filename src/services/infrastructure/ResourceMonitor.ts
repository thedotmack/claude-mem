/**
 * ResourceMonitor - Token & Memory Leak Detection
 *
 * Periodically samples process.memoryUsage() and per-session token rates,
 * maintains a bounded ring buffer of historical snapshots, detects anomalous
 * growth trends, and exposes diagnostics via getResourceDiagnostics().
 *
 * Follows the same module-level state + function exports pattern as ProcessRegistry.ts.
 */

import { logger } from '../../utils/logger.js';

// ============================================================================
// Configuration
// ============================================================================

const SAMPLE_INTERVAL_MS = 30_000;        // Sample every 30 seconds
const MAX_SNAPSHOTS = 120;                // Keep 1 hour of history at 30s interval
const MEMORY_GROWTH_WINDOW = 10;          // Check last 10 samples for monotonic growth
const MEMORY_HIGH_WATERMARK_MB = 512;     // Alert if RSS exceeds 512MB
const TOKEN_RATE_THRESHOLD = 50_000;      // Alert if >50k tokens/min for a session
const ACTIVE_ALERTS_MAX = 20;             // Cap stored alerts
const ALERT_DEDUP_WINDOW_MS = 5 * 60_000; // Suppress same alert type within 5 minutes
const TOKEN_RUNAWAY_MIN_AGE_MS = 2 * 60_000; // Only alert for sessions running > 2 min

// ============================================================================
// Types
// ============================================================================

interface MemorySnapshot {
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
}

export interface SessionTokenSnapshot {
  sessionDbId: number;
  project: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  ageMs: number;
  tokensPerMinute: number;
}

interface ResourceSnapshot {
  timestamp: number;
  memory: MemorySnapshot;
  sessions: SessionTokenSnapshot[];
  processCount: number;
  totalTokensAllSessions: number;
}

interface ResourceAlert {
  type: 'memory_leak' | 'token_runaway' | 'high_memory';
  severity: 'warn' | 'error';
  message: string;
  details: Record<string, unknown>;
  timestamp: number;
}

// ============================================================================
// Module State
// ============================================================================

let snapshots: ResourceSnapshot[] = [];
let activeAlerts: ResourceAlert[] = [];
let sampleInterval: ReturnType<typeof setInterval> | null = null;

// ============================================================================
// Public API
// ============================================================================

/**
 * Start periodic resource sampling.
 * Returns a cleanup function that stops the interval.
 */
export function startResourceMonitor(
  getSessionSnapshots: () => SessionTokenSnapshot[],
  getProcessCount: () => number
): () => void {
  // Take initial snapshot immediately
  takeSnapshot(getSessionSnapshots, getProcessCount);

  sampleInterval = setInterval(() => {
    try {
      takeSnapshot(getSessionSnapshots, getProcessCount);
    } catch (error) {
      logger.error('MONITOR', 'Failed to take resource snapshot', {}, error as Error);
    }
  }, SAMPLE_INTERVAL_MS);

  // Don't prevent process exit
  sampleInterval.unref();

  return () => {
    if (sampleInterval) {
      clearInterval(sampleInterval);
      sampleInterval = null;
    }
    snapshots = [];
    activeAlerts = [];
  };
}

/**
 * Take a single resource snapshot and run anomaly detection.
 */
export function takeSnapshot(
  getSessionSnapshots: () => SessionTokenSnapshot[],
  getProcessCount: () => number
): ResourceSnapshot {
  const mem = process.memoryUsage();
  const sessions = getSessionSnapshots();
  const processCount = getProcessCount();

  const snapshot: ResourceSnapshot = {
    timestamp: Date.now(),
    memory: {
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
      externalBytes: mem.external
    },
    sessions,
    processCount,
    totalTokensAllSessions: sessions.reduce((sum, s) => sum + s.totalTokens, 0)
  };

  // Ring buffer: push and cap
  snapshots.push(snapshot);
  if (snapshots.length > MAX_SNAPSHOTS) {
    snapshots.shift();
  }

  // Run anomaly detection
  detectAnomalies();

  return snapshot;
}

/**
 * Get resource diagnostics for the HTTP endpoint.
 */
export function getResourceDiagnostics(): {
  current: ResourceSnapshot | null;
  history: {
    count: number;
    oldestTimestamp: number | null;
    newestTimestamp: number | null;
  };
  trends: {
    memoryTrend: 'stable' | 'growing' | 'shrinking';
    rssChangePercent: number;
  };
  alerts: ResourceAlert[];
  config: {
    sampleIntervalMs: number;
    maxSnapshots: number;
    memoryHighWatermarkMb: number;
    tokenRateThreshold: number;
  };
} {
  const current = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;

  return {
    current,
    history: {
      count: snapshots.length,
      oldestTimestamp: snapshots.length > 0 ? snapshots[0].timestamp : null,
      newestTimestamp: current?.timestamp ?? null
    },
    trends: calculateMemoryTrend(),
    alerts: [...activeAlerts],
    config: {
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      maxSnapshots: MAX_SNAPSHOTS,
      memoryHighWatermarkMb: MEMORY_HIGH_WATERMARK_MB,
      tokenRateThreshold: TOKEN_RATE_THRESHOLD
    }
  };
}

/**
 * Run anomaly detection against current snapshot history.
 */
export function detectAnomalies(): ResourceAlert[] {
  const newAlerts: ResourceAlert[] = [];

  const memoryLeakAlert = detectMemoryLeak();
  if (memoryLeakAlert) newAlerts.push(memoryLeakAlert);

  const highMemoryAlert = detectHighMemory();
  if (highMemoryAlert) newAlerts.push(highMemoryAlert);

  const tokenAlerts = detectTokenRunaway();
  newAlerts.push(...tokenAlerts);

  // Store alerts (deduplicated, capped)
  for (const alert of newAlerts) {
    if (!isDuplicateAlert(alert)) {
      activeAlerts.push(alert);
      // Log the alert
      if (alert.severity === 'error') {
        logger.error('MONITOR', alert.message, alert.details);
      } else {
        logger.warn('MONITOR', alert.message, alert.details);
      }
    }
  }

  // Cap alerts
  while (activeAlerts.length > ACTIVE_ALERTS_MAX) {
    activeAlerts.shift();
  }

  return newAlerts;
}

// ============================================================================
// Detection Algorithms
// ============================================================================

/**
 * Detect monotonic RSS growth over the last MEMORY_GROWTH_WINDOW samples.
 * Triggers if RSS increased in 80%+ of samples AND total growth > 20%.
 */
function detectMemoryLeak(): ResourceAlert | null {
  if (snapshots.length < MEMORY_GROWTH_WINDOW) return null;

  const window = snapshots.slice(-MEMORY_GROWTH_WINDOW);
  let increases = 0;

  for (let i = 1; i < window.length; i++) {
    if (window[i].memory.rssBytes > window[i - 1].memory.rssBytes) {
      increases++;
    }
  }

  const firstRss = window[0].memory.rssBytes;
  const lastRss = window[window.length - 1].memory.rssBytes;
  const growthPercent = firstRss > 0 ? ((lastRss - firstRss) / firstRss) * 100 : 0;

  // 80% of transitions are increases AND total growth > 20%
  const threshold = Math.floor((MEMORY_GROWTH_WINDOW - 1) * 0.8);
  if (increases >= threshold && growthPercent > 20) {
    return {
      type: 'memory_leak',
      severity: 'warn',
      message: `Potential memory leak: RSS grew ${growthPercent.toFixed(1)}% over ${MEMORY_GROWTH_WINDOW} samples`,
      details: {
        firstRssMb: Math.round(firstRss / 1024 / 1024),
        lastRssMb: Math.round(lastRss / 1024 / 1024),
        growthPercent: Math.round(growthPercent),
        increaseSamples: increases,
        totalSamples: MEMORY_GROWTH_WINDOW - 1
      },
      timestamp: Date.now()
    };
  }

  return null;
}

/**
 * Alert if RSS exceeds high watermark.
 */
function detectHighMemory(): ResourceAlert | null {
  if (snapshots.length === 0) return null;

  const current = snapshots[snapshots.length - 1];
  const rssMb = current.memory.rssBytes / 1024 / 1024;

  if (rssMb > MEMORY_HIGH_WATERMARK_MB) {
    return {
      type: 'high_memory',
      severity: 'warn',
      message: `High memory usage: RSS at ${rssMb.toFixed(0)}MB (threshold: ${MEMORY_HIGH_WATERMARK_MB}MB)`,
      details: {
        rssMb: Math.round(rssMb),
        heapUsedMb: Math.round(current.memory.heapUsedBytes / 1024 / 1024),
        heapTotalMb: Math.round(current.memory.heapTotalBytes / 1024 / 1024),
        threshold: MEMORY_HIGH_WATERMARK_MB
      },
      timestamp: Date.now()
    };
  }

  return null;
}

/**
 * Detect sessions with abnormally high token consumption rates.
 */
function detectTokenRunaway(): ResourceAlert[] {
  if (snapshots.length === 0) return [];

  const current = snapshots[snapshots.length - 1];
  const alerts: ResourceAlert[] = [];

  for (const session of current.sessions) {
    if (session.ageMs < TOKEN_RUNAWAY_MIN_AGE_MS) continue;
    if (session.tokensPerMinute > TOKEN_RATE_THRESHOLD) {
      alerts.push({
        type: 'token_runaway',
        severity: 'error',
        message: `Token runaway: session ${session.sessionDbId} consuming ${Math.round(session.tokensPerMinute)} tokens/min`,
        details: {
          sessionDbId: session.sessionDbId,
          project: session.project,
          tokensPerMinute: Math.round(session.tokensPerMinute),
          totalTokens: session.totalTokens,
          inputTokens: session.inputTokens,
          outputTokens: session.outputTokens,
          ageMinutes: Math.round(session.ageMs / 60000),
          threshold: TOKEN_RATE_THRESHOLD
        },
        timestamp: Date.now()
      });
    }
  }

  return alerts;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Calculate memory trend over the last MEMORY_GROWTH_WINDOW samples.
 */
function calculateMemoryTrend(): { memoryTrend: 'stable' | 'growing' | 'shrinking'; rssChangePercent: number } {
  if (snapshots.length < 2) {
    return { memoryTrend: 'stable', rssChangePercent: 0 };
  }

  const window = snapshots.slice(-Math.min(MEMORY_GROWTH_WINDOW, snapshots.length));
  const firstRss = window[0].memory.rssBytes;
  const lastRss = window[window.length - 1].memory.rssBytes;
  const changePercent = firstRss > 0 ? ((lastRss - firstRss) / firstRss) * 100 : 0;

  let trend: 'stable' | 'growing' | 'shrinking' = 'stable';
  if (changePercent > 5) trend = 'growing';
  else if (changePercent < -5) trend = 'shrinking';

  return { memoryTrend: trend, rssChangePercent: Math.round(changePercent * 10) / 10 };
}

/**
 * Check if an alert is a duplicate of a recent one (within dedup window).
 */
function isDuplicateAlert(alert: ResourceAlert): boolean {
  const now = Date.now();
  const dedupKey = alert.type === 'token_runaway'
    ? `${alert.type}:${alert.details.sessionDbId}`
    : alert.type;

  return activeAlerts.some(existing => {
    const existingKey = existing.type === 'token_runaway'
      ? `${existing.type}:${existing.details.sessionDbId}`
      : existing.type;
    return existingKey === dedupKey && (now - existing.timestamp) < ALERT_DEDUP_WINDOW_MS;
  });
}
