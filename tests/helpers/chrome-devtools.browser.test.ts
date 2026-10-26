import { expect, it } from 'bun:test';
import { join } from 'node:path';
import { REPOSITORY_ROOT, chromeExecutablePath, failOnCiWithoutChrome } from './chrome-devtools';

failOnCiWithoutChrome('CI requires Chrome for the Chrome teardown test');

// close() falls back to SIGKILL after 5 s. Once Chrome exits sooner, nothing
// from close() may keep the test process alive; 2 s leaves headroom for a
// loaded runner while staying well under that 5 s fallback.
const MAX_EXIT_DELAY_AFTER_CLOSE_MS = 2000;

(chromeExecutablePath ? it : it.skip)('close() leaves no timer running once Chrome has exited', async () => {
  const helperPath = join(REPOSITORY_ROOT, 'tests/helpers/chrome-devtools.ts');
  const script = `
    const { launchChrome } = await import(${JSON.stringify(helperPath)});
    const chrome = launchChrome('about:blank', { profilePrefix: 'claude-mem-close-timer-' });
    await Bun.sleep(500);
    await chrome.close();
    console.log('closed');
  `;
  const child = Bun.spawn([process.execPath, '-e', script], { cwd: REPOSITORY_ROOT, stdout: 'pipe', stderr: 'pipe' });
  const reader = child.stdout.getReader();
  let output = '';
  while (!output.includes('closed')) {
    const { value, done } = await reader.read();
    if (done) break;
    output += new TextDecoder().decode(value);
  }
  expect(output).toContain('closed');
  const closedAt = Date.now();
  const exitCode = await child.exited;
  expect(exitCode).toBe(0);
  expect(Date.now() - closedAt).toBeLessThan(MAX_EXIT_DELAY_AFTER_CLOSE_MS);
}, 20000);
