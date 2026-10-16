// SPDX-License-Identifier: Apache-2.0

import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';

/**
 * Bun 1.3.6 fixed a memory leak when proxying streamed responses through
 * Bun.serve (plan D10, report 08 §Q2). The gateway refuses to start on less.
 */
export const WIRE_GATEWAY_MINIMUM_BUN_VERSION = '1.3.6';

/**
 * Throws when the running Bun is older than the gateway's floor. Called first
 * in the daemon's start. The version is a parameter so tests can stub it.
 * Bun.semver.satisfies: https://bun.sh/docs/api/semver (bun-types bun.d.ts).
 */
export function assertWireGatewayBun(
  bunVersion: string | undefined = typeof Bun !== 'undefined' ? Bun.version : undefined,
): void {
  if (!bunVersion || !Bun.semver.satisfies(bunVersion, `>=${WIRE_GATEWAY_MINIMUM_BUN_VERSION}`)) {
    throw new Error(
      `claude-mem wire gateway needs Bun ≥ ${WIRE_GATEWAY_MINIMUM_BUN_VERSION} (found ${bunVersion ?? 'no Bun'}). Run: bun upgrade`,
    );
  }
}

// Loopback mode only. The shared team gateway (plan D15, Phase 16) is the one
// way the gateway ever listens off loopback.
const LOOPBACK_HOST_PATTERN = /^(127\.0\.0\.1|::1|localhost)$/;

/**
 * Same rules as the worker's port/host checks (SettingsRoutes validateSettings),
 * except the host must be loopback: the gateway never binds all interfaces.
 * Returns an error message, or null when valid. Used by the settings route and
 * by the daemon at start.
 */
export function validateWireGatewayListenSettings(settings: {
  CLAUDE_MEM_WIRE_GATEWAY_PORT?: string;
  CLAUDE_MEM_WIRE_GATEWAY_HOST?: string;
  CLAUDE_MEM_WIRE_GATEWAY_DRAIN_TIMEOUT_MS?: string;
  CLAUDE_MEM_WIRE_GATEWAY_MAX_REQUEST_BYTES?: string;
  CLAUDE_MEM_WIRE_GATEWAY_RETENTION_DAYS?: string;
  CLAUDE_MEM_WIRE_GATEWAY_OUTBOUND_REDACTION?: string;
}): string | null {
  if (settings.CLAUDE_MEM_WIRE_GATEWAY_PORT) {
    const port = parseInt(settings.CLAUDE_MEM_WIRE_GATEWAY_PORT, 10);
    if (isNaN(port) || port < 1024 || port > 65535) {
      return 'CLAUDE_MEM_WIRE_GATEWAY_PORT must be between 1024 and 65535';
    }
  }
  if (settings.CLAUDE_MEM_WIRE_GATEWAY_HOST && !LOOPBACK_HOST_PATTERN.test(settings.CLAUDE_MEM_WIRE_GATEWAY_HOST)) {
    return 'CLAUDE_MEM_WIRE_GATEWAY_HOST must be a loopback address (127.0.0.1, ::1, localhost)';
  }
  if (settings.CLAUDE_MEM_WIRE_GATEWAY_DRAIN_TIMEOUT_MS !== undefined
    && !/^\d+$/.test(settings.CLAUDE_MEM_WIRE_GATEWAY_DRAIN_TIMEOUT_MS)) {
    return 'CLAUDE_MEM_WIRE_GATEWAY_DRAIN_TIMEOUT_MS must be a whole number of milliseconds';
  }
  if (settings.CLAUDE_MEM_WIRE_GATEWAY_MAX_REQUEST_BYTES !== undefined
    && (!/^\d+$/.test(settings.CLAUDE_MEM_WIRE_GATEWAY_MAX_REQUEST_BYTES) || Number(settings.CLAUDE_MEM_WIRE_GATEWAY_MAX_REQUEST_BYTES) < 1)) {
    return 'CLAUDE_MEM_WIRE_GATEWAY_MAX_REQUEST_BYTES must be a whole number of bytes above 0';
  }
  if (settings.CLAUDE_MEM_WIRE_GATEWAY_RETENTION_DAYS !== undefined
    && (!/^\d+$/.test(settings.CLAUDE_MEM_WIRE_GATEWAY_RETENTION_DAYS) || Number(settings.CLAUDE_MEM_WIRE_GATEWAY_RETENTION_DAYS) < 1)) {
    return 'CLAUDE_MEM_WIRE_GATEWAY_RETENTION_DAYS must be a whole number of days above 0';
  }
  if (settings.CLAUDE_MEM_WIRE_GATEWAY_OUTBOUND_REDACTION !== undefined
    && settings.CLAUDE_MEM_WIRE_GATEWAY_OUTBOUND_REDACTION !== 'true' && settings.CLAUDE_MEM_WIRE_GATEWAY_OUTBOUND_REDACTION !== 'false') {
    return 'CLAUDE_MEM_WIRE_GATEWAY_OUTBOUND_REDACTION must be "true" or "false"';
  }
  return null;
}

export interface WireGatewayConfig {
  host: string;
  port: number;
  autostart: boolean;
  drainTimeoutMs: number;
  /** Largest request body the relay reads (and decodes for capture); larger ones get a 413. */
  maxRequestBytes: number;
  /** Days of raw recordings kept (CLAUDE_MEM_WIRE_GATEWAY_RETENTION_DAYS). */
  retentionDays: number;
  /** CLAUDE_MEM_WIRE_GATEWAY_RECORDING=false: raw recording is off whatever consent.json says. Nothing turns it on. */
  recordingForcedOff: boolean;
  /** Whether a route without its own `features.outboundRedaction` gets it (CLAUDE_MEM_WIRE_GATEWAY_OUTBOUND_REDACTION). */
  outboundRedaction: boolean;
}

/**
 * The gateway's settings from settings.json with env overrides. Throws on an
 * invalid value instead of falling back (fail fast).
 */
export function loadWireGatewayConfig(settingsPath: string = USER_SETTINGS_PATH): WireGatewayConfig {
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  const error = validateWireGatewayListenSettings(settings);
  if (error) {
    throw new Error(`Invalid wire gateway setting: ${error}`);
  }
  // 'localhost' can resolve IPv6-first while the client dials IPv4 (#2992,
  // SettingsDefaultsManager.normalizeWorkerHost): pin the IPv4 loopback.
  const host = settings.CLAUDE_MEM_WIRE_GATEWAY_HOST === 'localhost' ? '127.0.0.1' : settings.CLAUDE_MEM_WIRE_GATEWAY_HOST;
  return {
    host,
    port: parseInt(settings.CLAUDE_MEM_WIRE_GATEWAY_PORT, 10),
    autostart: settings.CLAUDE_MEM_WIRE_GATEWAY_AUTOSTART !== 'false',
    drainTimeoutMs: parseInt(settings.CLAUDE_MEM_WIRE_GATEWAY_DRAIN_TIMEOUT_MS, 10),
    maxRequestBytes: parseInt(settings.CLAUDE_MEM_WIRE_GATEWAY_MAX_REQUEST_BYTES, 10),
    retentionDays: parseInt(settings.CLAUDE_MEM_WIRE_GATEWAY_RETENTION_DAYS, 10),
    recordingForcedOff: settings.CLAUDE_MEM_WIRE_GATEWAY_RECORDING === 'false',
    outboundRedaction: settings.CLAUDE_MEM_WIRE_GATEWAY_OUTBOUND_REDACTION === 'true',
  };
}
