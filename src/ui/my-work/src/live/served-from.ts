const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/** Served by the cloud viewer (claude-mem services/viewer-host) rather than the worker on this computer. */
export function isServedFromCloud(hostname: string | undefined): boolean {
  return typeof hostname === 'string' && hostname.length > 0 && !LOOPBACK_HOSTNAMES.has(hostname)
}
