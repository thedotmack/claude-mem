import { expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const chrome = Bun.which('google-chrome') ?? Bun.which('chromium')
  ?? (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : null);
if (process.env.CI && !chrome) throw new Error('CI requires Chrome or Chromium for the native settings-save regression tests.');

for (const [index, label, delay] of [
  [0, 'Observations', 0], [1, 'Sessions', 0], [2, 'Full Observations Count', 0],
  [2, 'Full Observations Count after delayed initial load', 1500],
] as const) {
  (chrome ? it : it.skip)(`saves the displayed fallback after clearing ${label}`, async () => {
    // Route-module mocks from other suites must not replace this native HTTP consumer.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CLAUDE_MEM_')));
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, 'settings-count-clear.fixture.ts'), String(index)], {
      env: {...env, COUNT_FIXTURE_CHROME: chrome!, COUNT_FIXTURE_LOAD_DELAY_MS: String(delay)},
      stdout: 'pipe', stderr: 'pipe',
    });
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    const code = await child.exited;
    expect({code, stderr: await stderr}).toEqual({code: 0, stderr: ''});
    expect(await stdout).toContain('"isolated":true');
  }, 60000);
}
