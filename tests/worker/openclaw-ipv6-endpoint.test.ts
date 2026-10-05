import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// The fixture binds the same Bun listener as this probe. IPv4 still runs on
// hosts without IPv6 loopback support.
const ipv6Available = (() => {
  try {
    const server = Bun.serve({ hostname: '::1', port: 0, fetch: () => new Response('owned probe') });
    server.stop(true);
    return true;
  } catch (error) {
    if (['EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EPROTONOSUPPORT'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  }
})();

for (const scenario of ['ipv6', 'ipv6-bracketed-control', 'ipv4-control']) {
  it.skipIf(scenario !== 'ipv4-control' && !ipv6Available)(`connects OpenClaw worker hooks over ${scenario}`, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'owned-openclaw-ipv6-'));
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      child = Bun.spawn([process.execPath, 'tests/fixtures/openclaw/ipv6-endpoint.ts', scenario], {
        env: { ...process.env, CLAUDE_MEM_DATA_DIR: dataDir }, stdout: 'pipe', stderr: 'pipe',
      });
      const exit = await Promise.race([
        child.exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Owned OpenClaw fixture exceeded 8 seconds')), 8000);
        }),
      ]);
      const output = await new Response(child.stdout).text() + await new Response(child.stderr).text();
      expect(exit, output).toBe(0);
    } finally {
      if (timer) clearTimeout(timer);
      if (child && child.exitCode === null) { child.kill(); await child.exited; }
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 10000);
}
