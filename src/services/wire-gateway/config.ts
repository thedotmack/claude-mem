// SPDX-License-Identifier: Apache-2.0

import { isAbsolute } from 'path';
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

// CLAUDE_MEM_WIRE_GATEWAY_HOST is always loopback: it is the listener that
// serves this computer without a key. The shared team gateway (plan D15,
// Phase 16) adds a second, team listener (CLAUDE_MEM_WIRE_GATEWAY_SHARED_HOST
// and _PORT), the one way the gateway ever listens off loopback, and that one
// never serves a request without a client key.
const LOOPBACK_HOST_PATTERN = /^(127\.0\.0\.1|::1|localhost)$/;
/**
 * The team listener's address: a host name (at most 253 characters, the DNS
 * limit of RFC 1035) or an IP literal (at most 45, the longest IPv6 text form,
 * IPv4-mapped included).
 */
const SHARED_HOST_PATTERN = /^(?:[A-Za-z0-9.-]{1,253}|[0-9A-Fa-f:.]{2,45})$/;

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
  CLAUDE_MEM_WIRE_GATEWAY_FORWARD_SUBSCRIPTION_SIGNINS?: string;
  CLAUDE_MEM_WIRE_GATEWAY_ENDLESS_MODE?: string;
  CLAUDE_MEM_WIRE_GATEWAY_ENDLESS_MIN_AGE_TURNS?: string;
  CLAUDE_MEM_WIRE_GATEWAY_ENDLESS_MIN_RESULT_BYTES?: string;
  CLAUDE_MEM_WIRE_GATEWAY_MEMORY_INJECTION?: string;
  CLAUDE_MEM_WIRE_GATEWAY_CONTEXT_TIMEOUT_MS?: string;
  CLAUDE_MEM_WIRE_GATEWAY_MEMORY_SEARCH_TOOL?: string;
  CLAUDE_MEM_WIRE_GATEWAY_OTLP?: string;
  CLAUDE_MEM_WIRE_GATEWAY_MAGPIE_RECORDINGS_DIR?: string;
  CLAUDE_MEM_WIRE_GATEWAY_SHARED?: string;
  CLAUDE_MEM_WIRE_GATEWAY_SHARED_HOST?: string;
  CLAUDE_MEM_WIRE_GATEWAY_SHARED_PORT?: string;
}): string | null {
  if (settings.CLAUDE_MEM_WIRE_GATEWAY_SHARED !== undefined
    && settings.CLAUDE_MEM_WIRE_GATEWAY_SHARED !== 'true' && settings.CLAUDE_MEM_WIRE_GATEWAY_SHARED !== 'false') {
    return 'CLAUDE_MEM_WIRE_GATEWAY_SHARED must be "true" or "false"';
  }
  const shared = settings.CLAUDE_MEM_WIRE_GATEWAY_SHARED === 'true';
  if (settings.CLAUDE_MEM_WIRE_GATEWAY_PORT) {
    const port = parseInt(settings.CLAUDE_MEM_WIRE_GATEWAY_PORT, 10);
    if (isNaN(port) || port < 1024 || port > 65535) {
      return 'CLAUDE_MEM_WIRE_GATEWAY_PORT must be between 1024 and 65535';
    }
  }
  if (settings.CLAUDE_MEM_WIRE_GATEWAY_HOST && !LOOPBACK_HOST_PATTERN.test(settings.CLAUDE_MEM_WIRE_GATEWAY_HOST)) {
    return shared
      ? 'CLAUDE_MEM_WIRE_GATEWAY_HOST must be a loopback address (127.0.0.1, ::1, localhost) even when shared: other computers reach the team listener (CLAUDE_MEM_WIRE_GATEWAY_SHARED_HOST and CLAUDE_MEM_WIRE_GATEWAY_SHARED_PORT)'
      : 'CLAUDE_MEM_WIRE_GATEWAY_HOST must be a loopback address (127.0.0.1, ::1, localhost)';
  }
  if (shared) {
    const sharedPortText = settings.CLAUDE_MEM_WIRE_GATEWAY_SHARED_PORT ?? '';
    const sharedPort = /^\d+$/.test(sharedPortText) ? parseInt(sharedPortText, 10) : NaN;
    if (isNaN(sharedPort) || sharedPort < 1024 || sharedPort > 65535) {
      return 'CLAUDE_MEM_WIRE_GATEWAY_SHARED_PORT must be set (1024–65535) when CLAUDE_MEM_WIRE_GATEWAY_SHARED=true: it is the team listener, the port your TLS proxy forwards to';
    }
    if (settings.CLAUDE_MEM_WIRE_GATEWAY_PORT && sharedPort === parseInt(settings.CLAUDE_MEM_WIRE_GATEWAY_PORT, 10)) {
      return 'CLAUDE_MEM_WIRE_GATEWAY_SHARED_PORT must differ from CLAUDE_MEM_WIRE_GATEWAY_PORT (the loopback listener)';
    }
    const sharedHost = settings.CLAUDE_MEM_WIRE_GATEWAY_SHARED_HOST ?? '';
    if (!SHARED_HOST_PATTERN.test(sharedHost)) {
      return 'CLAUDE_MEM_WIRE_GATEWAY_SHARED_HOST must be an IP address or a host name';
    }
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
  if (settings.CLAUDE_MEM_WIRE_GATEWAY_FORWARD_SUBSCRIPTION_SIGNINS !== undefined
    && settings.CLAUDE_MEM_WIRE_GATEWAY_FORWARD_SUBSCRIPTION_SIGNINS !== 'true' && settings.CLAUDE_MEM_WIRE_GATEWAY_FORWARD_SUBSCRIPTION_SIGNINS !== 'false') {
    return 'CLAUDE_MEM_WIRE_GATEWAY_FORWARD_SUBSCRIPTION_SIGNINS must be "true" or "false"';
  }
  if (settings.CLAUDE_MEM_WIRE_GATEWAY_ENDLESS_MODE !== undefined
    && settings.CLAUDE_MEM_WIRE_GATEWAY_ENDLESS_MODE !== 'true' && settings.CLAUDE_MEM_WIRE_GATEWAY_ENDLESS_MODE !== 'false') {
    return 'CLAUDE_MEM_WIRE_GATEWAY_ENDLESS_MODE must be "true" or "false"';
  }
  if (settings.CLAUDE_MEM_WIRE_GATEWAY_ENDLESS_MIN_AGE_TURNS !== undefined
    && !/^\d+$/.test(settings.CLAUDE_MEM_WIRE_GATEWAY_ENDLESS_MIN_AGE_TURNS)) {
    return 'CLAUDE_MEM_WIRE_GATEWAY_ENDLESS_MIN_AGE_TURNS must be a whole number of user turns';
  }
  if (settings.CLAUDE_MEM_WIRE_GATEWAY_ENDLESS_MIN_RESULT_BYTES !== undefined
    && !/^\d+$/.test(settings.CLAUDE_MEM_WIRE_GATEWAY_ENDLESS_MIN_RESULT_BYTES)) {
    return 'CLAUDE_MEM_WIRE_GATEWAY_ENDLESS_MIN_RESULT_BYTES must be a whole number of bytes';
  }
  for (const key of ['CLAUDE_MEM_WIRE_GATEWAY_MEMORY_INJECTION', 'CLAUDE_MEM_WIRE_GATEWAY_MEMORY_SEARCH_TOOL', 'CLAUDE_MEM_WIRE_GATEWAY_OTLP'] as const) {
    if (settings[key] !== undefined && settings[key] !== 'true' && settings[key] !== 'false') {
      return `${key} must be "true" or "false"`;
    }
  }
  if (settings.CLAUDE_MEM_WIRE_GATEWAY_CONTEXT_TIMEOUT_MS !== undefined
    && (!/^\d+$/.test(settings.CLAUDE_MEM_WIRE_GATEWAY_CONTEXT_TIMEOUT_MS) || Number(settings.CLAUDE_MEM_WIRE_GATEWAY_CONTEXT_TIMEOUT_MS) < 1)) {
    return 'CLAUDE_MEM_WIRE_GATEWAY_CONTEXT_TIMEOUT_MS must be a whole number of milliseconds above 0';
  }
  const magpieRecordingsDirectory = settings.CLAUDE_MEM_WIRE_GATEWAY_MAGPIE_RECORDINGS_DIR?.trim();
  if (magpieRecordingsDirectory && !isAbsolute(magpieRecordingsDirectory)) {
    return 'CLAUDE_MEM_WIRE_GATEWAY_MAGPIE_RECORDINGS_DIR must be an absolute path (magpie\'s gateway-conversations folder) or empty';
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
  /** CLAUDE_MEM_WIRE_GATEWAY_FORWARD_SUBSCRIPTION_SIGNINS=true: subscription sign-ins are forwarded, not refused (D4 lifted locally). */
  forwardSubscriptionSignIns: boolean;
  /** CLAUDE_MEM_WIRE_GATEWAY_OTLP: POST /v1/traces takes OTLP/HTTP JSON spans into capture (plan Phase 13 task 2). */
  otlp: boolean;
  /** CLAUDE_MEM_WIRE_GATEWAY_MAGPIE_RECORDINGS_DIR: magpie's gateway-conversations folder to follow; null when off (plan Phase 13 task 3). */
  magpieRecordingsDirectory: string | null;
  /** CLAUDE_MEM_WIRE_GATEWAY_SHARED: the shared team gateway (plan Phase 16). */
  shared: boolean;
  /** The team listener (shared mode only): where other computers (and any proxy) connect, a client key always required. */
  sharedHost: string;
  /** 0 when not shared. */
  sharedPort: number;
  /** CLAUDE_MEM_WIRE_GATEWAY_ALLOW_IPS as written (read by shared/allow-list.ts; a malformed entry lets nothing in). */
  allowIps: string;
  /** Every setting (settings.json with env overrides), handed to the rewrite stages as `context.settings`. */
  rewriteSettings: Readonly<Record<string, string>>;
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
    forwardSubscriptionSignIns: settings.CLAUDE_MEM_WIRE_GATEWAY_FORWARD_SUBSCRIPTION_SIGNINS === 'true',
    otlp: settings.CLAUDE_MEM_WIRE_GATEWAY_OTLP !== 'false',
    magpieRecordingsDirectory: settings.CLAUDE_MEM_WIRE_GATEWAY_MAGPIE_RECORDINGS_DIR.trim() || null,
    shared: settings.CLAUDE_MEM_WIRE_GATEWAY_SHARED === 'true',
    sharedHost: settings.CLAUDE_MEM_WIRE_GATEWAY_SHARED_HOST,
    sharedPort: settings.CLAUDE_MEM_WIRE_GATEWAY_SHARED === 'true' ? parseInt(settings.CLAUDE_MEM_WIRE_GATEWAY_SHARED_PORT, 10) : 0,
    allowIps: settings.CLAUDE_MEM_WIRE_GATEWAY_ALLOW_IPS,
    rewriteSettings: { ...settings },
  };
}
