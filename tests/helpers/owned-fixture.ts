import { expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export async function runOwnedFixture(path: string, options: {
  prefix: string;
  timeoutMs?: number;
  args?: string[];
  env?: (dataDir: string) => Record<string, string>;
}): Promise<string> {
  const dataDir = mkdtempSync(join(tmpdir(), options.prefix));
  const timeoutMs = options.timeoutMs ?? 8000;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    child = Bun.spawn([process.execPath, path, ...(options.args ?? [])], {
      env: { ...process.env, CLAUDE_MEM_GROK_BOT_INJECT_ENABLED: 'false', CLAUDE_MEM_DATA_DIR: dataDir, ...options.env?.(dataDir) },
      stdout: 'pipe', stderr: 'pipe',
    });
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const exitCode = await Promise.race([child.exited, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${path} exceeded ${timeoutMs}ms`)), timeoutMs);
    })]);
    const text = (await output).join('');
    expect(exitCode, text).toBe(0);
    return text;
  } finally {
    if (timer) clearTimeout(timer);
    if (child && child.exitCode === null) { child.kill(); await child.exited; }
    rmSync(dataDir, { recursive: true, force: true });
  }
}
