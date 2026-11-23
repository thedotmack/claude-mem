import { loadDocument, settingsTarget } from '../../shared/settings-document.js';
import { normalizeRemoteTokenHost } from '../../shared/local-api-token.js';
import { isLoopbackHostname } from '../../shared/worker-url.js';
import { logger } from '../../utils/logger.js';

/**
 * Observation TV was removed. Its setting is no longer declared, so
 * SettingsDefaultsManager drops it on load; this name is kept only to find
 * installs that still carry it.
 */
const LEGACY_TV_TOKEN_KEY = 'CLAUDE_MEM_TV_TOKEN';

/**
 * Where the worker binds when a leftover TV token would otherwise open the full API.
 * An IPv6 host (`::`) falls back to `::1`, because local clients still connect to the
 * configured host and `[::]` reaches `::1`, not `127.0.0.1`.
 */
export function loopbackBindHostFor(configuredHost: string): string {
  return configuredHost.includes(':') ? '::1' : '127.0.0.1';
}

function isLoopbackBindHost(host: string): boolean {
  return isLoopbackHostname(host) || host.toLowerCase() === '::ffff:127.0.0.1';
}

/**
 * The leftover Observation TV token, from the environment or settings.json, trimmed.
 * Empty when neither has one. Reads the raw document because loadFromFile only
 * returns declared keys.
 */
export function readLegacyTvToken(settingsPath: string, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = (env[LEGACY_TV_TOKEN_KEY] ?? '').trim();
  if (fromEnv) return fromEnv;
  const loaded = loadDocument(settingsPath);
  if (!loaded.document) return '';
  const value = settingsTarget(loaded.document)[LEGACY_TV_TOKEN_KEY];
  if (typeof value === 'string') return value.trim();
  // The old settings reader (coercePersistedSettingValue) turned a saved boolean into
  // "true"/"false", which switched the TV guard on. Count it as a token here too, so such
  // an install falls back to loopback instead of exposing the full API.
  if (typeof value === 'boolean') return String(value);
  return '';
}

/**
 * The host the worker binds to.
 *
 * With Observation TV, a non-loopback CLAUDE_MEM_WORKER_HOST plus CLAUDE_MEM_TV_TOKEN
 * exposed only the read-only TV paths to the network. That guard is gone, so the same
 * config would now expose the whole worker API, provider API keys included (GET
 * /api/settings). Unless the local API token guards the API, such an install binds to
 * loopback instead and says why.
 */
export function resolveWorkerBindHost(input: {
  configuredHost: string;
  legacyTvToken: string;
  localApiTokenSet: boolean;
}): string {
  const { configuredHost, legacyTvToken, localApiTokenSet } = input;
  const configuredHostIsLoopback = isLoopbackBindHost(configuredHost);

  if (legacyTvToken) {
    if (!configuredHostIsLoopback && !localApiTokenSet) {
      const boundHost = loopbackBindHostFor(configuredHost);
      logger.error(
        'SECURITY',
        `Observation TV was removed, so CLAUDE_MEM_TV_TOKEN no longer limits network access to read-only paths. Binding to ${boundHost} instead of the configured host so the full worker API, including provider API keys, is not exposed. The local API token protects network access now: set CLAUDE_MEM_LOCAL_API_TOKEN in settings.json to use a non-loopback CLAUDE_MEM_WORKER_HOST, and remove CLAUDE_MEM_TV_TOKEN.`,
        { configuredHost, boundHost },
      );
      return boundHost;
    }
    logger.warn(
      'SECURITY',
      'CLAUDE_MEM_TV_TOKEN is set but ignored: Observation TV was removed. Remove it from settings.json and the environment.',
      { host: configuredHost },
    );
  }

  if (!configuredHostIsLoopback && !localApiTokenSet) {
    // Warn, do not refuse to bind: docs/docker.md tells people to set
    // CLAUDE_MEM_WORKER_HOST=0.0.0.0, and refusing would break that install.
    logger.warn(
      'SECURITY',
      'Worker bound to a non-loopback host with no CLAUDE_MEM_LOCAL_API_TOKEN — the full worker API, including provider API keys via GET /api/settings, is reachable from the network',
      { host: configuredHost },
    );
  }

  return configuredHost;
}

/**
 * Say so when the token would cross a plain-HTTP hop to a host that is not this one
 * (#6390). A remote client that names this worker in
 * CLAUDE_MEM_LOCAL_API_TOKEN_REMOTE_HOST sends the token in a header, and plain HTTP
 * carries headers in the clear: anyone on the path reads the token and then holds
 * the key to this worker's whole API. Warn, do not refuse, for the same reason the
 * non-loopback bind above only warns; https is the fix.
 */
export function warnOnPlainHttpRemoteTokenHost(input: {
  configuredHost: string;
  localApiTokenSet: boolean;
  remoteTokenHost: string;
  workerUrl: string;
}): void {
  const remote = normalizeRemoteTokenHost(input.remoteTokenHost);
  // The token only leaves the machine when both sides of the pair are set: an install
  // with no token sends nothing anywhere, so it has nothing to leak.
  if (!input.localApiTokenSet || !remote) return;
  if (isLoopbackHostname(input.configuredHost)) return;
  if (remote !== input.configuredHost.trim()) return;

  let url: URL;
  try {
    url = new URL(input.workerUrl);
  } catch {
    return;
  }
  if (url.protocol !== 'http:') return;
  if (isLoopbackHostname(url.hostname)) return;

  logger.warn(
    'SECURITY',
    `CLAUDE_MEM_LOCAL_API_TOKEN_REMOTE_HOST sends the local API token to ${remote} over plain HTTP, which carries the header in the clear. Anyone on the network path can read it and then reach this worker's whole API. Point CLAUDE_MEM_WORKER_URL at an https worker, or unset CLAUDE_MEM_LOCAL_API_TOKEN_REMOTE_HOST.`,
    { host: remote, workerUrl: input.workerUrl },
  );
}
