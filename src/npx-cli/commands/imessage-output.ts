/** Prints one JSON line (for the app) or a plain line (for a person). */
export function emitter(json: boolean) {
  return {
    json,
    event(value: Record<string, unknown>): void {
      if (json) process.stdout.write(JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n');
    },
    info(message: string): void {
      if (json) this.event({ type: 'log', level: 'info', message });
      else console.log(message);
    },
    warn(message: string): void {
      if (json) this.event({ type: 'log', level: 'warn', message });
      else console.warn(message);
    },
  };
}

/** Probe the configured worker without starting code from a user's installation. */
export async function workerStatus() {
  const { resolveHarnessWorkerUrl } = await import('../../integrations/harness-worker.js');
  const url = resolveHarnessWorkerUrl();
  try {
    const response = await fetch(url + '/api/health', { signal: AbortSignal.timeout(3_000) });
    return { reachable: response.ok, url, ...(response.ok ? {} : { detail: `health check returned ${response.status}` }) };
  } catch (error) {
    return { reachable: false, url, detail: error instanceof Error ? error.message : String(error) };
  }
}
