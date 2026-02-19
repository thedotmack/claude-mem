/**
 * Timing constants in milliseconds
 * All timeout and interval durations used throughout the UI
 */
export const TIMING = {
  /** SSE reconnection base delay after connection error */
  SSE_RECONNECT_DELAY_MS: 3000,

  /** SSE reconnection maximum delay cap */
  SSE_RECONNECT_MAX_DELAY_MS: 60000,

  /** SSE reconnection backoff multiplier per retry */
  SSE_RECONNECT_BACKOFF_FACTOR: 2,

  /** Stats refresh interval for worker status polling */
  STATS_REFRESH_INTERVAL_MS: 10000,

  /** Duration to display save status message before clearing */
  SAVE_STATUS_DISPLAY_DURATION_MS: 3000,
} as const;
