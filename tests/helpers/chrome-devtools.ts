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

/**
 * Tells Chrome it has a mouse, so a desktop walk runs on the desktop it describes on every platform. Headless Chrome on
 * Linux finds no pointing device: it reports `(hover: none)` and `(pointer: none)`, so styles kept inside
 * `@media (hover: hover)` or `(pointer: fine)` never apply, and a CDP mouse move gives a button `:hover` without its
 * hover looks (CI on PRs 6210 and 6233; Chrome 157 and Chromium 156 on Linux, 2026-11-16). Chrome on macOS reports a
 * mouse already. The values are Blink's hover type "hover" (2) and pointer type "fine" (4), the setting Playwright 1.66
 * passes to every headless Chromium it launches.
 */
export const DESKTOP_MOUSE_FLAGS = ['--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4'];

const esbuildBinary = createRequire(import.meta.url).resolve(
  `@esbuild/${process.platform}-${process.arch}/${process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild'}`,
);

/**
 * Bundles TSX fixture source (resolved from the repository root) into one
 * browser IIFE. The one-shot compiler exits before Chrome starts, so no shared
 * esbuild service handle stays alive while the browser runs. A fixture that
 * mounts a whole page passes `extraEsbuildArguments` for the page's own asset
 * imports (for example `--loader:.webp=empty`).
 */
export function compileBrowserFixture(fixtureSource: string, extraEsbuildArguments: readonly string[] = []): string {
  return execFileSync(esbuildBinary, [
    '--bundle', '--loader=tsx', '--platform=browser', '--format=iife',
    '--define:process.env.NODE_ENV="production"', '--log-level=error', ...extraEsbuildArguments,
  ], { cwd: REPOSITORY_ROOT, input: fixtureSource, encoding: 'utf8', timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
}

export const FIXTURE_PAGE_HTML = '<div id="root"></div><script src="/fixture.js"></script>';

/**
 * My Work's font files for a fixture page that loads the app's compiled stylesheet. Its @font-face rules ask for
 * `./files/<face>-<subset>-wght-<style>.woff2`, from each package index.css imports: Geist for the text and Geist Mono
 * for the terminal lines; the file name says which. Null for any other path, so the server can answer it.
 */
export function myWorkFontResponse(path: string): Response | null {
  const font = /^\/files\/((geist-mono|geist)-[a-z0-9-]+\.woff2)$/.exec(path);
  if (!font) return null;
  const file = join(REPOSITORY_ROOT, 'src/ui/my-work/node_modules/@fontsource-variable', font[2], 'files', font[1]);
  return new Response(Bun.file(file), { headers: { 'Content-Type': 'font/woff2' } });
}
/**
 * A classic scrollbar, 15px wide, for a fixture page whose address asks for one (`scrollbar=classic`): Chrome on Linux
 * (CI) and Windows draws one in every box that scrolls, and headless Chrome on a Mac draws none (overlay scrollbars).
 * One rule before the app's stylesheet gave CI's exact widths on a Mac (PR #6210 watch, 2026-11-17: 753 at a 768px
 * window; the List's title column 175.5px at 1366; the drawer's reply row 509px at 1440). Width-sensitive tests run
 * with and without it, so a Mac run shows what CI and Windows show.
 */
export const CLASSIC_SCROLLBAR_STYLE = '<style>::-webkit-scrollbar{width:15px;height:15px}</style>';
/** The classic scrollbar's style when the fixture page's address asks for it, else nothing. */
export const scrollbarStyleFor = (requestUrl: string) => new URL(requestUrl).searchParams.get('scrollbar') === 'classic' ? CLASSIC_SCROLLBAR_STYLE : '';
/** The width a classic scrollbar takes from the page: CLASSIC_SCROLLBAR_STYLE's, and Chrome's own on Linux and Windows. */
export const CLASSIC_SCROLLBAR_PX = 15;
/**
 * The page's clock pinned to one instant, as bun:test's setSystemTime pins the test process's, for a fixture page whose
 * address asks for it (`clock=<an ISO instant>`): Date.now() and new Date() read that instant (dates built from parts,
 * Date.parse and Date.UTC are as they were; timers and performance.now() run on). For a test whose words depend on the
 * day: My Work says a time from another day of this year "Oct 20, 1:17 pm" and one from another year "Oct 20, 2026,
 * 1:17 pm" (display-time.ts clockTime), so a test of fixed instants that reads the real clock passes only in the year it
 * was written. Serve it first in the page, before any script reads the time. Nothing when the address does not ask.
 */
export function pinnedClockFor(requestUrl: string): string {
  const instant = new URL(requestUrl).searchParams.get('clock');
  if (instant === null) return '';
  const pinned = Date.parse(instant);
  if (!Number.isFinite(pinned)) throw new Error(`clock=${instant} is not an ISO instant`);
  return `<script>(() => { const RealDate = Date; function PinnedDate(...parts) { if (!new.target) return new RealDate(${pinned}).toString(); return parts.length ? new RealDate(...parts) : new RealDate(${pinned}); }
    PinnedDate.prototype = RealDate.prototype; PinnedDate.now = () => ${pinned}; PinnedDate.parse = RealDate.parse; PinnedDate.UTC = RealDate.UTC; window.Date = PinnedDate; })();</script>`;
}
/**
 * For "nothing scrolls sideways, at the width the test names": the window's width (`window`), the page's (`page`, the
 * window less a scrollbar where one is drawn) and how wide the page's content runs (`scrolled`). Read it with
 * `page.evaluate(PAGE_WIDTHS)` and check it with pageFitsTheWindow, so the run proves the width it claims as well as
 * no sideways scroll (Phase 6 fix AP-L6: comparing the page with its own width alone proved no width at all).
 */
export const PAGE_WIDTHS = '({ window: innerWidth, page: document.documentElement.clientWidth, scrolled: document.documentElement.scrollWidth })';
/**
 * What PAGE_WIDTHS should read at a `width` window: the window that wide, the page that wide or a classic scrollbar
 * narrower (a touch phone draws overlay scrollbars, so there it is the window's width), and nothing past the page.
 * Answers the reading as found, with each check true or false, so a failure shows the numbers.
 */
export function pageFitsTheWindow(reading: { window: number; page: number; scrolled: number }, width: number, { touch = false } = {}) {
  const pageWidths = touch ? [width] : [width, width - CLASSIC_SCROLLBAR_PX];
  return { ...reading, windowIsTheWidth: reading.window === width, pageIsTheWindowLessAScrollbar: pageWidths.includes(reading.page), nothingSideways: reading.scrolled === reading.page };
}
/** What pageFitsTheWindow answers when the page fits. */
export const FITS_THE_WINDOW = { windowIsTheWidth: true, pageIsTheWindowLessAScrollbar: true, nothingSideways: true };
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
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  return {
    send, evaluate,
    settle: () => evaluate('new Promise(async resolve => { for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame); resolve(true); })'),
    close: () => socket.close(),
  };
}
