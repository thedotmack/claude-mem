import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Shared plumbing for the `*.browser.test.ts` files: find Chrome, compile a
 * TSX fixture, run it in an owned headless Chrome, and (when a test needs
 * native input) drive that page over the DevTools protocol.
 */

const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export const chromeExecutablePath: string | null = Bun.which('google-chrome') ?? Bun.which('chromium')
  ?? (existsSync(MAC_CHROME) ? MAC_CHROME : null);

export const REPOSITORY_ROOT = resolve(import.meta.dir, '../..');

/** CI must not silently skip the native browser regressions. */
export function failOnCiWithoutChrome(message: string): void {
  if (process.env.CI && !chromeExecutablePath) throw new Error(message);
}

/** Keeps a page's timers and rAF on schedule on a loaded runner. */
export const UNTHROTTLED_TIMER_FLAGS = ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'];

const esbuildBinary = createRequire(import.meta.url).resolve(
  `@esbuild/${process.platform}-${process.arch}/${process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild'}`,
);

/**
 * Bundles TSX fixture source (resolved from the repository root) into one
 * browser IIFE. The one-shot compiler exits before Chrome starts, so no shared
 * esbuild service handle stays alive while the browser runs.
 */
export function compileBrowserFixture(fixtureSource: string): string {
  return execFileSync(esbuildBinary, [
    '--bundle', '--loader=tsx', '--platform=browser', '--format=iife',
    '--define:process.env.NODE_ENV="production"', '--log-level=error',
  ], { cwd: REPOSITORY_ROOT, input: fixtureSource, encoding: 'utf8', timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
}

export const FIXTURE_PAGE_HTML = '<div id="root"></div><script src="/fixture.js"></script>';
export const htmlResponse = (html: string) => new Response(html, { headers: { 'Content-Type': 'text/html' } });
export const scriptResponse = (script: string) => new Response(script, { headers: { 'Content-Type': 'application/javascript' } });

/** The real viewer page; it loads its bundle from `/viewer-bundle.js`. */
export function readViewerTemplateHtml(): string {
  return readFileSync(join(REPOSITORY_ROOT, 'src/ui/viewer-template.html'), 'utf8');
}

/** The viewer template's stylesheet, for fixtures that render one component. */
export function readViewerTemplateStyles(): string {
  const styles = readViewerTemplateHtml().match(/<style>([\s\S]*?)<\/style>/)?.[1];
  if (styles === undefined) throw new Error('viewer-template.html has no <style> block');
  return styles;
}

export interface OwnedChrome {
  readonly process: ReturnType<typeof Bun.spawn>;
  readonly profileDirectory: string;
  /** Kills Chrome (SIGKILL if SIGTERM is ignored) and removes its profile. Safe to call twice. */
  close(): Promise<void>;
}

export function launchChrome(pageUrl: string, options: {
  profilePrefix?: string; extraFlags?: string[]; remoteDebugging?: boolean;
} = {}): OwnedChrome {
  if (!chromeExecutablePath) throw new Error('Chrome is not installed');
  const profileDirectory = mkdtempSync(join(tmpdir(), options.profilePrefix ?? 'claude-mem-browser-'));
  const child = Bun.spawn([chromeExecutablePath, '--headless', '--no-sandbox', '--disable-gpu',
    '--disable-background-networking', '--no-first-run', ...(options.extraFlags ?? []),
    ...(options.remoteDebugging ? ['--remote-debugging-port=0'] : []),
    `--user-data-dir=${profileDirectory}`, pageUrl], { stdout: 'ignore', stderr: 'ignore' });
  return {
    process: child, profileDirectory,
    async close() {
      child.kill();
      // SIGKILL after 5 s if Chrome ignores SIGTERM. The timer is cleared once
      // Chrome exits so it never keeps the test process alive.
      let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
      const exitedInTime = await Promise.race([
        child.exited.then(() => true),
        new Promise<boolean>(resolveTimeout => { sigkillTimer = setTimeout(() => resolveTimeout(false), 5000); }),
      ]);
      clearTimeout(sigkillTimer);
      if (!exitedInTime) { child.kill('SIGKILL'); await child.exited; }
      rmSync(profileDirectory, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

/** Resolves with `promise`, or rejects with `message` after `milliseconds`. */
export async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

export interface DevToolsPage {
  send(method: string, params?: object): Promise<any>;
  /** Runtime.evaluate by value, awaiting promises; throws on a page exception. */
  evaluate(expression: string): Promise<any>;
  /** Waits four animation frames in the page. */
  settle(): Promise<void>;
  close(): void;
}

/** Connects to the page Chrome opened at `pageUrl`; Chrome must have been launched with `remoteDebugging`. */
export async function connectToPage(chrome: OwnedChrome, pageUrl: string): Promise<DevToolsPage> {
  const deadline = Date.now() + 10000;
  const portFile = join(chrome.profileDirectory, 'DevToolsActivePort');
  let port = '';
  while (!/^\d+$/.test(port)) {
    if (Date.now() > deadline) throw new Error('Owned browser did not start');
    if (existsSync(portFile)) port = readFileSync(portFile, 'utf8').split('\n')[0];
    if (!/^\d+$/.test(port)) await Bun.sleep(10);
  }
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find((entry: any) => entry.type === 'page' && entry.url === pageUrl);
  if (!target) throw new Error('Owned browser page was not found');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolveOpen, rejectOpen) => {
    socket.addEventListener('open', () => resolveOpen(), { once: true });
    socket.addEventListener('error', () => rejectOpen(new Error('CDP connection failed')), { once: true });
  });
  let lastRequestId = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  socket.addEventListener('message', event => {
    const data = JSON.parse(String(event.data));
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    if (data.error) request.reject(new Error(data.error.message));
    else request.resolve(data.result);
  });
  const send = (method: string, params: object = {}) => new Promise<any>((resolveSend, rejectSend) => {
    const id = ++lastRequestId;
    pending.set(id, { resolve: resolveSend, reject: rejectSend });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression: string) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  return {
    send, evaluate,
    settle: () => evaluate('new Promise(async resolve => { for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame); resolve(true); })'),
    close: () => socket.close(),
  };
}
