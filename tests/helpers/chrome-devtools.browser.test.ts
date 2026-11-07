import { expect, it } from 'bun:test';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { REPOSITORY_ROOT, chromeExecutablePath, connectToPage, failOnCiWithoutChrome, launchChrome, withTimeout } from './chrome-devtools';

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

(chromeExecutablePath ? it : it.skip)('the matrix content predicate waits safely for a streamed document body', async () => {
  let releaseBody = () => {};
  const server = createServer((request, response) => {
    if (request.url !== '/viewer') { response.writeHead(204).end(); return; }
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.flushHeaders();
    response.write('<!doctype html><html><head><script>window.documentHeadReady = true</script>');
    releaseBody = () => { if (!response.writableEnded) response.end('</head><body>MATRIX_FEED_INITIAL</body></html>'); };
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const browser = launchChrome('about:blank', { remoteDebugging: true });
  let page: Awaited<ReturnType<typeof connectToPage>> | undefined;
  let navigation: Promise<unknown> | undefined;
  try {
    page = await connectToPage(browser, 'about:blank');
    navigation = page.send('Page.navigate', { url: `http://127.0.0.1:${port}/viewer` });
    void navigation.catch(() => {});
    await withTimeout((async () => { while (!(await page!.evaluate('window.documentHeadReady === true'))) await Bun.sleep(10); })(), 5_000, 'Streamed head did not load');
    expect(await page.evaluate("location.pathname === '/viewer' && document.body === null")).toBe(true);
    // This is the exact pre-readiness predicate that failed the sync matrix.
    const oldFailure = await page.evaluate("(() => { try { document.body.textContent.includes('MATRIX_FEED_INITIAL'); } catch (error) { return {name:error.name,message:error.message}; } })()");
    expect(oldFailure.name).toBe('TypeError');
    expect(oldFailure.message).toContain('Cannot read properties of null');
    const predicate = "location.pathname === '/viewer' && document.body?.textContent?.includes('MATRIX_FEED_INITIAL') === true";
    expect(await page.evaluate(predicate)).toBe(false);
    releaseBody();
    await navigation;
    await withTimeout((async () => { while (!(await page.evaluate(predicate))) await Bun.sleep(10); })(), 5_000, 'Streamed body did not arrive');
    expect(await page.evaluate(predicate)).toBe(true);
    const error = await page.evaluate("(() => { throw new Error('matrix diagnostic detail'); })()").then(() => null, error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('matrix diagnostic detail');
  } finally {
    releaseBody(); page?.close(); await browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 20000);
