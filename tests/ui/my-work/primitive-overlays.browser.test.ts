import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
  REPOSITORY_ROOT, UNTHROTTLED_TIMER_FLAGS, chromeExecutablePath, compileBrowserFixture, connectToPage,
  failOnCiWithoutChrome, htmlResponse, launchChrome, scriptResponse, withTimeout, type DevToolsPage, type OwnedChrome,
} from '../../helpers/chrome-devtools';

/*
 * Phase 1 (pro-max-v16) accessibility claims for the My Work primitives that open, announce or fold things:
 * Alert's quiet default role, Progress reporting its value, Tooltip and HoverCard triggers reachable by Tab and open on
 * keyboard focus and on tap, Dialog and Sheet returning focus to a plain opener, the fold row and close buttons at
 * 44px, menu rows at 40px, a single spinner announcement, the short/long scroll area, table rows that open by key,
 * and the status marks (G11), missing next step (G3) and progress meter bits. Real Tailwind CSS, real Chrome input.
 * Phase 1 fix round: a sheet opened without a pointer starts on its panel (no tooltip over its title, one Escape
 * closes it); a keyboard-opened tooltip survives the scroll its focus causes; a dialog opened from a menu item returns
 * focus to the menu's trigger; an aria-disabled menu trigger does not open; a tooltip around a toggle group item keeps
 * the group one Tab stop; Keep editing returns to the field and a dialog its parent closed reopens without asking.
 */

failOnCiWithoutChrome('CI requires Chrome for the My Work overlay primitive regressions.');

/** Compiles the app's real stylesheet, so sizes and focus looks are the shipped ones (live-indicator test pattern). */
async function compileMyWorkStyles(): Promise<string> {
  const app = resolve(REPOSITORY_ROOT, 'src/ui/my-work');
  const appRequire = createRequire(resolve(app, 'package.json'));
  const { compile } = appRequire('@tailwindcss/node');
  const { Scanner } = appRequire('@tailwindcss/oxide');
  const css = await compile(readFileSync(resolve(app, 'src/index.css'), 'utf8'), { base: app, onDependency() {} });
  const scanner = new Scanner({ sources: [{ base: resolve(app, 'src'), pattern: '**/*.{ts,tsx}', negated: false }] });
  return css.build(scanner.scan());
}

const FIXTURE_SOURCE = `
  import React from './src/ui/my-work/node_modules/react';
  import { createRoot } from './src/ui/my-work/node_modules/react-dom/client';
  import { Alert, AlertAction, AlertDescription, AlertTitle } from './src/ui/my-work/src/components/ui/alert';
  import { Button } from './src/ui/my-work/src/components/ui/button';
  import { Collapsible, CollapsibleContent, CollapsibleFoldTrigger } from './src/ui/my-work/src/components/ui/collapsible';
  import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './src/ui/my-work/src/components/ui/dialog';
  import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './src/ui/my-work/src/components/ui/dropdown-menu';
  import { HoverCard, HoverCardContent, HoverCardTrigger } from './src/ui/my-work/src/components/ui/hover-card';
  import { Progress } from './src/ui/my-work/src/components/ui/progress';
  import { ScrollArea } from './src/ui/my-work/src/components/ui/scroll-area';
  import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from './src/ui/my-work/src/components/ui/sheet';
  import { Spinner } from './src/ui/my-work/src/components/ui/spinner';
  import { Table, TableBody, TableCell, TableRow } from './src/ui/my-work/src/components/ui/table';
  import { ToggleGroup, ToggleGroupItem } from './src/ui/my-work/src/components/ui/toggle-group';
  import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './src/ui/my-work/src/components/ui/tooltip';
  import { NextMove, ProgressMeter, StateBadge } from './src/ui/my-work/src/components/bits';
  import { NEXT_STEP_NOT_RECORDED } from './src/ui/my-work/src/live/to-work-model';
  window.React = React;
  window.rowActivations = 0;
  const reportFixtureError = (message) => fetch('/fixture-error', { method: 'POST', body: String(message) });
  window.addEventListener('error', (event) => reportFixtureError(event.error?.stack ?? event.message));
  window.addEventListener('unhandledrejection', (event) => reportFixtureError(event.reason?.stack ?? event.reason));
  // What a test tap delivers (tap() below): each pointer, touch, mouse and click event, its target and its time after
  // the tap began, so a tap that toggles nothing can say what arrived. Passive and capturing: it only watches.
  window.tapLog = { startedAt: 0, clicks: 0, events: [] };
  window.startTapLog = () => { window.tapLog = { startedAt: performance.now(), clicks: 0, events: [] }; };
  for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'touchstart', 'touchend', 'touchcancel', 'mousedown', 'mouseup', 'click']) {
    document.addEventListener(type, (event) => {
      const log = window.tapLog;
      if (type === 'click') log.clicks += 1;
      const target = event.target instanceof Element ? (event.target.id || event.target.getAttribute('data-slot') || event.target.tagName.toLowerCase()) : String(event.target);
      log.events.push(type + (event.pointerType ? '(' + event.pointerType + ')' : '') + ' on ' + target + ' +' + Math.round(performance.now() - log.startedAt) + 'ms');
    }, { capture: true, passive: true });
  }
  const STATES = ['your-move', 'needs-check', 'working', 'idle', 'shipped'];
  const finishedRequest = { state: 'shipped', estimate: null, progress: { percent: 100, readings: 2, reviewedAt: '3:25 pm', completedAt: 'Nov 14 at 9:54 pm', history: [80, 100] } };
  const unreviewedRequest = { state: 'idle', estimate: null, progress: { percent: null, readings: 0, reviewedAt: '—', history: [] } };
  function Fixture() {
    const [dialogOpen, setDialogOpen] = React.useState(false);
    const [draft, setDraft] = React.useState('');
    const [sheetOpen, setSheetOpen] = React.useState(false);
    const [renameOpen, setRenameOpen] = React.useState(false);
    // What a page does without a pointer: opens the drawer from a link or a reload, closes a dialog after a save.
    React.useEffect(() => {
      window.openSheetWithoutPointer = () => setSheetOpen(true);
      window.closeRuleDialogFromParent = () => setDialogOpen(false);
    }, []);
    return (
      <TooltipProvider delayDuration={0}>
        <main style={{ padding: 24, display: 'grid', gap: 16, maxWidth: 720 }}>
          <Alert id="alert-default"><AlertTitle>A notice</AlertTitle><AlertDescription>One line.</AlertDescription></Alert>
          <Alert id="alert-attention" variant="attention"><AlertTitle>Needs a look</AlertTitle><AlertDescription>The data is old.</AlertDescription><AlertAction><Button id="alert-retry" variant="outline">Try again</Button></AlertAction></Alert>
          <Alert id="alert-urgent" role="alert" variant="destructive"><AlertTitle>Failed</AlertTitle></Alert>
          <Progress id="progress-known" value={55} aria-label="55% complete" />
          <Progress id="progress-unknown" value={null} />
          <p><Tooltip><TooltipTrigger asChild><span id="tooltip-span-trigger" className="inline-flex size-7 items-center justify-center rounded-lg border">A</span></TooltipTrigger><TooltipContent>Agent identity</TooltipContent></Tooltip></p>
          <p><HoverCard openDelay={0} closeDelay={0}><HoverCardTrigger asChild><span id="hover-card-span-trigger" className="rounded-full border px-2">Nov 14</span></HoverCardTrigger><HoverCardContent>Quoted on Nov 14</HoverCardContent></HoverCard></p>
          <p><HoverCard openDelay={0} closeDelay={0}><HoverCardTrigger asChild><Button id="hover-card-button-trigger" variant="ghost">1 machine</Button></HoverCardTrigger><HoverCardContent>This computer</HoverCardContent></HoverCard></p>
          <Button id="open-dialog" variant="outline" onClick={() => setDialogOpen(true)}>Add rule</Button>
          <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) setDraft(''); }}>
            <DialogContent hasUnsavedText={draft.length > 0}>
              <DialogHeader><DialogTitle>Add a rule</DialogTitle><DialogDescription>Write it the way you would say it.</DialogDescription></DialogHeader>
              <input id="rule-text" aria-label="Rule" value={draft} onChange={(event) => setDraft(event.target.value)} />
              <DialogFooter showCloseButton><Button>Save rule</Button></DialogFooter>
            </DialogContent>
          </Dialog>
          <Button id="open-sheet" variant="outline" onClick={() => setSheetOpen(true)}>Open request</Button>
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <SheetContent>
              <SheetHeader className="border-b">
                <p><Tooltip><TooltipTrigger asChild><span id="sheet-agent-icon" className="inline-flex size-7 items-center justify-center rounded-lg border">A</span></TooltipTrigger><TooltipContent>Agent in the drawer</TooltipContent></Tooltip></p>
                <SheetTitle>A request</SheetTitle><SheetDescription>Details</SheetDescription>
              </SheetHeader>
              <div id="sheet-body" style={{ minHeight: 2400 }}>Long body</div>
            </SheetContent>
          </Sheet>
          <Collapsible><CollapsibleFoldTrigger id="fold-trigger" count="3 parts">Build story</CollapsibleFoldTrigger><CollapsibleContent>Story</CollapsibleContent></Collapsible>
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button id="menu-trigger" variant="outline">Change area</Button></DropdownMenuTrigger>
            <DropdownMenuContent><DropdownMenuItem>Rename</DropdownMenuItem><DropdownMenuItem id="menu-mark-done" hint="moves to Past focus">Mark done</DropdownMenuItem></DropdownMenuContent>
          </DropdownMenu>
          {/* A focus area's "…" menu: Rename opens a dialog from a menu item (focus-header.tsx AreaMenu). */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button id="area-menu-trigger" variant="ghost" size="sm" aria-label="Change Viewer">…</Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end"><DropdownMenuItem id="area-menu-rename" onSelect={() => setRenameOpen(true)}>Rename</DropdownMenuItem></DropdownMenuContent>
          </DropdownMenu>
          <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
            <DialogContent><DialogHeader><DialogTitle>Rename</DialogTitle><DialogDescription>A new name for the area.</DialogDescription></DialogHeader><input id="rename-field" aria-label="Name" /></DialogContent>
          </Dialog>
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button id="disabled-menu-trigger" variant="outline" aria-disabled="true">Change area (saving)</Button></DropdownMenuTrigger>
            <DropdownMenuContent><DropdownMenuItem>Rename</DropdownMenuItem></DropdownMenuContent>
          </DropdownMenu>
          <ToggleGroup id="tooltip-toggle-group" type="single" variant="outline" defaultValue="cards" aria-label="View">
            {['cards', 'list'].map((value) => (
              <Tooltip key={value}><TooltipTrigger asChild><ToggleGroupItem value={value}>{value}</ToggleGroupItem></TooltipTrigger><TooltipContent>{value} view</TooltipContent></Tooltip>
            ))}
          </ToggleGroup>
          <Table aria-label="Requests"><TableBody><TableRow id="table-row" onActivate={() => { window.rowActivations += 1; }}><TableCell>A request</TableCell><TableCell id="numeric-cell" numeric>55%</TableCell></TableRow></TableBody></Table>
          <div id="spinner-line"><Spinner label="Loading request detail…" /></div>
          {/* 160px is the drawer's record-list cap (QueueList's max-h-40), which two rows fit under; 37 rows of 24px
              overflow a 96px box (the review's "6 of 37 shown" case, D b15 M 312). */}
          <ScrollArea id="scroll-short" style={{ maxHeight: 160 }} overflowCaption="2 of 2 shown"><ul><li>one</li><li>two</li></ul></ScrollArea>
          <ScrollArea id="scroll-long" style={{ maxHeight: 96 }} scrollRegionLabel="Latest records" overflowCaption="6 of 37 shown"><ul>{Array.from({ length: 37 }, (_, index) => <li key={index} style={{ height: 24 }}>record {index}</li>)}</ul></ScrollArea>
          <div id="state-badges">{STATES.map((state) => <StateBadge key={state} state={state} />)}</div>
          <div id="next-legacy"><NextMove next={{ who: 'bot', text: NEXT_STEP_NOT_RECORDED }} /></div>
          <div id="next-legacy-dash"><NextMove next={{ who: 'bot', text: NEXT_STEP_NOT_RECORDED }} whenMissing="dash" /></div>
          <div id="next-human"><NextMove next={{ who: 'human', text: 'Confirm the release notes' }} /></div>
          <div id="meter-finished"><ProgressMeter request={finishedRequest} /></div>
          <div id="meter-unreviewed"><ProgressMeter request={unreviewedRequest} /></div>
          {/* A trigger far below the fold: Tab to it scrolls the page, as on a long home page. 1800px is twice the
              900px test viewport, so the trigger always starts off screen. */}
          <Button id="before-far-tooltip" variant="outline">Before the far tooltip</Button>
          <div style={{ height: 1800 }} />
          <p><Tooltip><TooltipTrigger asChild><span id="far-tooltip-trigger" className="inline-flex size-7 items-center justify-center rounded-lg border">F</span></TooltipTrigger><TooltipContent>Far identity</TooltipContent></Tooltip></p>
        </main>
      </TooltipProvider>
    );
  }
  createRoot(document.getElementById('root')).render(<Fixture />);
  fetch('/fixture-ready');
`;

const KEYS = {
  Tab: { code: 'Tab', keyCode: 9 },
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Escape: { code: 'Escape', keyCode: 27 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
} as const;

let chrome: OwnedChrome | undefined;
let page: DevToolsPage | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;

async function press(key: keyof typeof KEYS) {
  const { code, keyCode } = KEYS[key];
  const text = 'text' in KEYS[key] ? KEYS[key].text : undefined;
  await page!.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, text });
  await page!.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
  await page!.settle();
}

/**
 * Presses Tab until `predicate` (a page expression over `document.activeElement` as `active`) holds. The fixture has
 * 16 Tab stops (counted 2026-11-16 by tabbing one full lap); 60 presses is more than three laps, so a stop that is
 * missing fails here instead of looping.
 */
const MAX_TAB_PRESSES = 60;
async function tabUntil(predicate: string): Promise<number> {
  for (let presses = 1; presses <= MAX_TAB_PRESSES; presses++) {
    await press('Tab');
    if (await page!.evaluate(`(() => { const active = document.activeElement; return !!(${predicate}); })()`)) return presses;
  }
  throw new Error(`Tab never reached: ${predicate}`);
}

/**
 * Polls a page expression until it is truthy; fails after 3 seconds (exit animations here are 100 to 200ms). It polls
 * every 25ms, a quarter of the shortest animation (the dialog's 100ms), so a wait ends soon after its condition holds.
 */
async function waitFor(expression: string, label: string) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await page!.evaluate(expression)) return;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function viewport(width: number, height: number, mobile: boolean) {
  await page!.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  await page!.settle();
}

async function heightOf(selector: string): Promise<number> {
  await waitFor(`document.getAnimations().every(animation => animation.playState !== 'running' || animation.effect.getComputedTiming().endTime === Infinity)`, 'open animations to settle');
  return page!.evaluate(`document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().height`);
}

/**
 * How long a tap may take to send its click. Chrome sent it 4–55ms after the touchStart, 6 taps each in Chrome 158 on
 * macOS, Chrome 157 on Linux (amd64 under Rosetta) and Chromium 156 on Linux (2026-11-16); 2s is over 35× the slowest,
 * for a loaded CI runner.
 */
const TAP_CLICK_LIMIT_MS = 2000;
/** Polls for that click every 10ms, about the time a tap takes to send it, so the wait ends soon after it arrives. */
const TAP_POLL_MS = 10;

/**
 * A real touch tap at the middle of `selector`: one finger down and up (Input.dispatchTouchEvent, as Puppeteer and
 * Playwright tap). With touch emulation on, Chrome turns the pair into what a phone sends: pointer and touch events,
 * then mousedown, mouseup and a click. Not Input.synthesizeTapGesture: headless Chrome on Linux delivers that gesture's
 * pointer and touch events but never its click (Chrome 157 and Chromium 156, 2026-11-16: no click within 1.5s of any
 * of 16 taps, touch emulation on or off), so on CI a tap toggled nothing (PR 6210); Chrome on macOS sends it.
 * Resolves once the click has arrived, with what the tap delivered; a tap that sends no click fails, saying what it did
 * deliver.
 */
async function tap(selector: string): Promise<string> {
  const { x, y } = await page!.evaluate(`(() => { window.startTapLog(); const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })()`);
  await page!.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await page!.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const deadline = Date.now() + TAP_CLICK_LIMIT_MS;
  for (;;) {
    const { clicks, events } = await page!.evaluate('window.tapLog');
    const delivered = `a tap on ${selector} delivered: ${events.join(', ') || 'no events'}`;
    if (clicks > 0) return delivered;
    if (Date.now() > deadline) throw new Error(`No click within ${TAP_CLICK_LIMIT_MS}ms: ${delivered}`);
    await Bun.sleep(TAP_POLL_MS);
  }
}

/** Taps `selector`, then waits for `expression` to hold (waitFor); a failure also says what the tap delivered. */
async function tapThenWaitFor(selector: string, expression: string, label: string) {
  const delivered = await tap(selector);
  try {
    await waitFor(expression, label);
  } catch (error) {
    throw new Error(`${(error as Error).message}; ${delivered}`);
  }
}

/** A real left click at the middle of `selector`. */
async function click(selector: string) {
  const { x, y } = await page!.evaluate(`(() => { const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page!.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  }
  await page!.settle();
}

const describeWithChrome = chromeExecutablePath ? describe : describe.skip;

describeWithChrome('My Work overlay and status primitives in Chrome', () => {
  beforeAll(async () => {
    const styles = await compileMyWorkStyles();
    const bundle = compileBrowserFixture(FIXTURE_SOURCE);
    let markReady!: () => void;
    let failToStart!: (error: Error) => void;
    const ready = new Promise<void>((resolveReady, rejectReady) => { markReady = resolveReady; failToStart = rejectReady; });
    server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/fixture-error') { failToStart(new Error(`Overlay fixture threw: ${await request.text()}`)); return new Response('noted'); }
      if (path === '/') return htmlResponse('<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/fixture.js"></script>');
      if (path === '/fixture.js') return scriptResponse(bundle);
      if (path === '/app.css') return new Response(styles, { headers: { 'Content-Type': 'text/css' } });
      if (path === '/fixture-ready') { markReady(); return new Response('ready'); }
      return new Response('not found', { status: 404 });
    } });
    chrome = launchChrome(server.url.href, { profilePrefix: 'claude-mem-overlays-', remoteDebugging: true, extraFlags: UNTHROTTLED_TIMER_FLAGS });
    // Chrome starts and runs the fixture in 0.70–0.80s here (3 runs, 2026-11-16); 20s is about 25× that, for a cold
    // Chrome on a shared CI runner.
    await withTimeout(ready, 20_000, 'Overlay fixture did not start');
    page = await connectToPage(chrome, server.url.href);
    await viewport(1440, 900, false);
    // Compiling the stylesheet and the fixture plus the start above take 0.95–1.07s here (same runs); 60s is the same
    // kind of margin, with the stylesheet compile on a slow disk.
  }, 60_000);

  afterAll(async () => {
    page?.close();
    await chrome?.close();
    server?.stop(true);
  });

  it('Alert is a quiet status unless the caller asks for an alert, and a named kind draws its icon and word', async () => {
    const alerts = await page!.evaluate(`(() => ['alert-default', 'alert-attention', 'alert-urgent'].map(id => {
      const alert = document.getElementById(id);
      return { id, role: alert.getAttribute('role'), kindIcon: !!alert.querySelector('[data-slot=alert-kind-icon]'),
        kindWords: alert.querySelector('.sr-only')?.textContent ?? null, edge: getComputedStyle(alert).borderTopWidth };
    }))()`);
    expect(alerts).toEqual([
      { id: 'alert-default', role: 'status', kindIcon: false, kindWords: null, edge: '1px' },
      { id: 'alert-attention', role: 'status', kindIcon: true, kindWords: 'Needs attention: ', edge: '1px' },
      { id: 'alert-urgent', role: 'alert', kindIcon: true, kindWords: 'Error: ', edge: '1px' },
    ]);
    // The retry sits inside the alert, beside the message (same row band, to its right).
    const placement = await page!.evaluate(`(() => {
      const alert = document.getElementById('alert-attention').getBoundingClientRect();
      const retry = document.getElementById('alert-retry').getBoundingClientRect();
      const title = document.querySelector('#alert-attention [data-slot=alert-title]').getBoundingClientRect();
      return { inside: retry.top >= alert.top && retry.bottom <= alert.bottom && retry.right <= alert.right, rightOfMessage: retry.left > title.right };
    })()`);
    expect(placement).toEqual({ inside: true, rightOfMessage: true });
  });

  it('Progress reports its value, and an unknown value is its own look with no number', async () => {
    const bars = await page!.evaluate(`(() => ['progress-known', 'progress-unknown'].map(id => {
      const bar = document.getElementById(id);
      return { role: bar.getAttribute('role'), now: bar.getAttribute('aria-valuenow'), min: bar.getAttribute('aria-valuemin'),
        max: bar.getAttribute('aria-valuemax'), label: bar.getAttribute('aria-label'), valueState: bar.dataset.valueState,
        border: getComputedStyle(bar).borderTopWidth + ' ' + getComputedStyle(bar).borderTopStyle, indicator: !!bar.querySelector('[data-slot=progress-indicator]') };
    }))()`);
    expect(bars).toEqual([
      { role: 'progressbar', now: '55', min: '0', max: '100', label: '55% complete', valueState: 'known', border: '0px solid', indicator: true },
      { role: 'progressbar', now: null, min: '0', max: '100', label: 'Not measured yet', valueState: 'unknown', border: '1px dashed', indicator: false },
    ]);
  });

  it('Tooltip and HoverCard triggers are Tab stops that open on keyboard focus', async () => {
    await page!.evaluate('document.activeElement?.blur(); window.scrollTo(0, 0)');
    await tabUntil(`active.id === 'tooltip-span-trigger'`);
    const tooltip = await page!.evaluate(`(() => ({ tabIndex: document.activeElement.tabIndex, text: document.querySelector('[data-slot=tooltip-content]')?.textContent ?? null,
      roleTooltip: !!document.querySelector('[role=tooltip]'),
      describedBy: document.activeElement.getAttribute('aria-describedby'), outline: getComputedStyle(document.activeElement).outlineStyle }))()`);
    expect(tooltip.tabIndex).toBe(0);
    expect(tooltip.text).toContain('Agent identity');
    expect(tooltip.roleTooltip).toBe(true);
    expect(tooltip.describedBy).toBeTruthy();
    expect(tooltip.outline).toBe('solid');

    await tabUntil(`active.id === 'hover-card-span-trigger'`);
    await waitFor(`!!document.querySelector('[data-slot=hover-card-content]')`, 'the date chip card to open on focus');
    const spanCard = await page!.evaluate(`(() => { const content = document.querySelector('[data-slot=hover-card-content]');
      return { tabIndex: document.activeElement.tabIndex, text: content?.textContent ?? null, describedBy: document.activeElement.getAttribute('aria-describedby'),
        contentId: content?.id ?? null, expanded: document.activeElement.getAttribute('aria-expanded') }; })()`);
    expect(spanCard.tabIndex).toBe(0);
    expect(spanCard.text).toBe('Quoted on Nov 14');
    expect(spanCard.describedBy).toBe(spanCard.contentId);
    // aria-expanded is not allowed on a plain span; the description ties it to the card instead.
    expect(spanCard.expanded).toBeNull();

    await tabUntil(`active.id === 'hover-card-button-trigger'`);
    await waitFor(`document.querySelector('[data-slot=hover-card-content]')?.textContent === 'This computer'`, 'the machines card to open on focus');
    const buttonCard = await page!.evaluate(`(() => ({ text: document.querySelector('[data-slot=hover-card-content]')?.textContent ?? null,
      expanded: document.activeElement.getAttribute('aria-expanded'), describedBy: document.activeElement.getAttribute('aria-describedby'),
      contentId: document.querySelector('[data-slot=hover-card-content]')?.id ?? null }))()`);
    // Pressing a hover card's trigger never opens the card (the Team button switches the view), so it does not say
    // "expanded"; the description still ties it to the open card.
    expect(buttonCard.text).toBe('This computer');
    expect(buttonCard.expanded).toBeNull();
    expect(buttonCard.describedBy).toBe(buttonCard.contentId);
  });

  it('focus a script moves after a mouse click does not pop a tooltip open', async () => {
    // A mouse click on a button, then a scripted focus, as when a drawer opened by a click focuses its first control.
    await page!.evaluate(`document.getElementById('alert-retry').scrollIntoView({ block: 'center' })`);
    const { x, y } = await page!.evaluate(`(() => { const box = document.getElementById('alert-retry').getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })()`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await page!.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    }
    expect(await page!.evaluate(`document.activeElement.id`)).toBe('alert-retry');
    const scripted = await page!.evaluate(`(async () => {
      const trigger = document.getElementById('tooltip-span-trigger');
      trigger.focus();
      // A tooltip opens on the focus and shows one frame later (TooltipContent); 100ms is six frames past that.
      await new Promise(resolve => setTimeout(resolve, 100));
      return { focused: document.activeElement === trigger, keyboardFocus: trigger.matches(':focus-visible'), open: !!document.querySelector('[data-slot=tooltip-content]') };
    })()`);
    expect(scripted).toEqual({ focused: true, keyboardFocus: false, open: false });
    await page!.evaluate('document.activeElement?.blur()');
  });

  it('Dialog returns focus to a plain button opener, and asks before dropping typed text', async () => {
    await page!.evaluate('document.activeElement?.blur(); window.scrollTo(0, 0)');
    await tabUntil(`active.id === 'open-dialog'`);
    await press('Enter');
    expect(await page!.evaluate(`!!document.querySelector('[data-slot=dialog-content]')?.contains(document.activeElement)`)).toBe(true);
    const dialogLook = await page!.evaluate(`(() => { const content = document.querySelector('[data-slot=dialog-content]');
      const overlay = document.querySelector('[data-slot=dialog-overlay]');
      return { role: content.getAttribute('role'),
        named: document.getElementById(content.getAttribute('aria-labelledby'))?.textContent ?? null,
        described: document.getElementById(content.getAttribute('aria-describedby'))?.textContent ?? null,
        closeHeight: content.querySelector('[data-slot=dialog-close]').getBoundingClientRect().height,
        edge: getComputedStyle(content).borderTopWidth, blur: getComputedStyle(overlay).backdropFilter }; })()`);
    expect({ role: dialogLook.role, named: dialogLook.named, described: dialogLook.described })
      .toEqual({ role: 'dialog', named: 'Add a rule', described: 'Write it the way you would say it.' });
    expect(dialogLook.closeHeight).toBeGreaterThanOrEqual(44);
    expect(dialogLook.edge).toBe('1px');
    expect(dialogLook.blur).toBe('none');
    await press('Escape');
    await waitFor(`!document.querySelector('[data-slot=dialog-content]') && document.activeElement.id === 'open-dialog'`, 'focus back on Add rule after Escape');

    // With typed text, Escape asks first; Discard then closes and focus still returns to the opener.
    await press('Enter');
    await page!.send('Input.insertText', { text: 'look up how we did it last time' });
    await page!.settle();
    await press('Escape');
    const asking = await page!.evaluate(`(() => { const confirmation = document.querySelector('[data-slot=dialog-discard-confirmation]');
      return { open: !!document.querySelector('[data-slot=dialog-content]'), role: confirmation?.getAttribute('role') ?? null, focused: document.activeElement.textContent }; })()`);
    expect(asking).toEqual({ open: true, role: 'alert', focused: 'Keep editing' });
    await press('Tab');
    expect(await page!.evaluate('document.activeElement.textContent')).toBe('Discard');
    await press('Enter');
    await waitFor(`!document.querySelector('[data-slot=dialog-content]') && document.activeElement.id === 'open-dialog'`, 'focus back on Add rule after Discard');
  });

  it('Keep editing puts focus back in the field, and a dialog its parent closed opens again without asking', async () => {
    await page!.evaluate(`document.getElementById('open-dialog').focus()`);
    await press('Enter');
    await waitFor(`document.activeElement?.id === 'rule-text'`, 'the dialog to open on its field');
    await page!.send('Input.insertText', { text: 'look up how we did it last time' });
    await page!.settle();
    await press('Escape');
    expect(await page!.evaluate('document.activeElement.textContent')).toBe('Keep editing');
    await press('Enter');
    expect(await page!.evaluate(`({ focused: document.activeElement.id, asking: !!document.querySelector('[data-slot=dialog-discard-confirmation]') })`))
      .toEqual({ focused: 'rule-text', asking: false });

    // Asked again, then the page closes the dialog itself (as after a save): the question goes with it.
    await press('Escape');
    expect(await page!.evaluate(`!!document.querySelector('[data-slot=dialog-discard-confirmation]')`)).toBe(true);
    await page!.evaluate('window.closeRuleDialogFromParent()');
    await waitFor(`!document.querySelector('[data-slot=dialog-content]')`, 'the parent to close the dialog');
    await page!.evaluate(`document.getElementById('open-dialog').focus()`);
    await press('Enter');
    await waitFor(`!!document.querySelector('[data-slot=dialog-content]')`, 'the dialog to open again');
    expect(await page!.evaluate(`!!document.querySelector('[data-slot=dialog-discard-confirmation]')`)).toBe(false);
    // The text is still there, so closing still asks first; Discard closes it.
    await press('Escape');
    expect(await page!.evaluate(`!!document.querySelector('[data-slot=dialog-discard-confirmation]')`)).toBe(true);
    await press('Tab');
    await press('Enter');
    await waitFor(`!document.querySelector('[data-slot=dialog-content]')`, 'Discard to close the dialog');
  });

  it('Sheet keeps its header and 44px close in view while the middle scrolls, and returns focus to its opener', async () => {
    await tabUntil(`active.id === 'open-sheet'`);
    await press('Enter');
    await waitFor(`!!document.querySelector('[data-slot=sheet-content]')`, 'the sheet to open');
    // The panel slides in over 200ms (SheetContent duration-200); 300ms lets it land before it is measured.
    await page!.evaluate('new Promise(resolve => setTimeout(resolve, 300))');
    // Focus starts on the panel itself, so its first control's tooltip is not open over the title.
    expect(await page!.evaluate(`({ panel: document.activeElement?.dataset.slot, tooltip: !!document.querySelector('[data-slot=tooltip-content]') })`))
      .toEqual({ panel: 'sheet-content', tooltip: false });
    await page!.evaluate(`document.querySelector('[data-slot=sheet-content]').scrollTop = 1200`);
    await page!.settle();
    const scrolled = await page!.evaluate(`(() => { const panel = document.querySelector('[data-slot=sheet-content]');
      const panelBox = panel.getBoundingClientRect();
      const close = panel.querySelector('[data-slot=sheet-close]').getBoundingClientRect();
      const header = panel.querySelector('[data-slot=sheet-header]').getBoundingClientRect();
      return { scrollTop: panel.scrollTop, closeTop: close.top - panelBox.top, closeHeight: close.height, headerTop: header.top - panelBox.top,
        width: panelBox.width, edge: getComputedStyle(panel).borderLeftWidth }; })()`);
    expect(scrolled.scrollTop).toBeGreaterThan(1000);
    expect(scrolled.closeTop).toBeGreaterThanOrEqual(0);
    expect(scrolled.closeTop).toBeLessThan(20);
    expect(scrolled.closeHeight).toBeGreaterThanOrEqual(44);
    expect(Math.abs(scrolled.headerTop)).toBeLessThan(1);
    // One width for every side panel: max-w-xl (36rem) at the 17px desktop root.
    expect(scrolled.width).toBe(612);
    expect(scrolled.edge).toBe('1px');
    await press('Escape');
    await waitFor(`!document.querySelector('[data-slot=sheet-content]') && document.activeElement.id === 'open-sheet'`, 'focus back on the sheet opener');
  });

  it('a sheet opened without a pointer (a link, a reload) starts on its panel: no tooltip over the title, one Escape closes it', async () => {
    // The last input was a key, as after following a link or a reload, so a scripted focus counts as keyboard focus:
    // before the fix the panel's first control (a tooltip trigger) took that focus and opened its tooltip.
    await page!.evaluate('document.activeElement?.blur(); window.scrollTo(0, 0)');
    await press('Tab');
    await page!.evaluate('window.openSheetWithoutPointer()');
    await waitFor(`!!document.querySelector('[data-slot=sheet-content]')`, 'the sheet to open');
    // The panel's 200ms slide-in, as above.
    await page!.evaluate('new Promise(resolve => setTimeout(resolve, 300))');
    expect(await page!.evaluate(`({ panel: document.activeElement?.dataset.slot, tooltip: !!document.querySelector('[data-slot=tooltip-content]') })`))
      .toEqual({ panel: 'sheet-content', tooltip: false });
    await press('Escape');
    await waitFor(`!document.querySelector('[data-slot=sheet-content]')`, 'one Escape to close the sheet');

    // Tab from the panel reaches its first control, and that control's tooltip opens on that keyboard focus (G10).
    await page!.evaluate('window.openSheetWithoutPointer()');
    await waitFor(`document.activeElement?.dataset.slot === 'sheet-content'`, 'the sheet to open on its panel');
    await press('Tab');
    expect(await page!.evaluate('document.activeElement.id')).toBe('sheet-agent-icon');
    await waitFor(`document.querySelector('[data-slot=tooltip-content]')?.textContent?.includes('Agent in the drawer')`, 'the agent tooltip to open on Tab');
    // The first Escape closes the tooltip, the top layer; it keeps catching Escape until its 150ms exit ends.
    await press('Escape');
    await waitFor(`!document.querySelector('[data-slot=tooltip-content]')`, 'Escape to close the tooltip first');
    await press('Escape');
    await waitFor(`!document.querySelector('[data-slot=sheet-content]')`, 'the sheet to close');
  });

  it('the fold row is 44px or taller with its chevron turning, and opens by keyboard', async () => {
    expect(await heightOf('#fold-trigger')).toBeGreaterThanOrEqual(44);
    // At rest its edge is the ≥3:1 control edge (#8f8071 here); focused, the ring colour replaces it. (It may hold focus
    // already: the sheet above returned focus to the element its Tab reached.)
    expect(await page!.evaluate(`(() => { document.activeElement?.blur(); return getComputedStyle(document.getElementById('fold-trigger')).borderTopColor; })()`)).toBe('rgb(143, 128, 113)');
    await tabUntil(`active.id === 'fold-trigger'`);
    await press('Enter');
    expect(await page!.evaluate(`(() => { const trigger = document.getElementById('fold-trigger');
      return { expanded: trigger.getAttribute('aria-expanded'), chevron: getComputedStyle(trigger.querySelector('svg')).rotate !== 'none',
        count: trigger.querySelector('[data-slot=fold-trigger-count]').textContent, cursor: getComputedStyle(trigger).cursor }; })()`))
      .toEqual({ expanded: 'true', chevron: true, count: '3 parts', cursor: 'pointer' });
  });

  it('menu rows are 40px with a visible highlight and a hint line', async () => {
    await tabUntil(`active.id === 'menu-trigger'`);
    await press('Enter');
    await waitFor(`document.activeElement?.dataset.slot === 'dropdown-menu-item'`, 'the menu to open with its first row focused');
    const menu = await page!.evaluate(`(() => { const items = [...document.querySelectorAll('[data-slot=dropdown-menu-item]')];
      const content = document.querySelector('[data-slot=dropdown-menu-content]');
      return { heights: items.map(item => item.getBoundingClientRect().height), focusedText: document.activeElement.textContent,
        highlight: getComputedStyle(document.activeElement).backgroundColor, menu: getComputedStyle(content).backgroundColor,
        mark: getComputedStyle(document.activeElement).boxShadow,
        hint: document.querySelector('#menu-mark-done [data-slot=dropdown-menu-item-hint]')?.textContent ?? null }; })()`);
    for (const height of menu.heights) expect(height).toBeGreaterThanOrEqual(40);
    expect(menu.focusedText).toBe('Rename');
    expect(menu.highlight).not.toBe(menu.menu);
    // The highlighted row's mark: a 1px --muted-foreground edge (#75685c here), ≥3:1 on the menu (token contrast test).
    expect(menu.mark).toContain('rgb(117, 104, 92) 0px 0px 0px 1px inset');
    expect(menu.hint).toBe('moves to Past focus');
    await press('Escape');
    await waitFor(`document.activeElement.id === 'menu-trigger'`, 'focus back on the menu trigger');
  });

  for (const motion of ['allowed', 'reduced'] as const) {
    it(`a dialog opened from a menu item returns focus to the menu's trigger when it closes (${motion} motion)`, async () => {
      // Reduced motion removes the menu's exit animation, so its items leave the page in the same update the dialog
      // opens in: the case most likely to lose the opener.
      if (motion === 'reduced') await page!.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      try {
        await page!.evaluate(`document.getElementById('area-menu-trigger').focus()`);
        await press('Enter');
        await waitFor(`document.activeElement?.id === 'area-menu-rename'`, 'the menu to open on Rename');
        await press('Enter');
        await waitFor(`!!document.querySelector('[data-slot=dialog-content]')?.contains(document.activeElement)`, 'the Rename dialog to take focus');
        // The closed menu returns focus to its trigger on a 0ms timer (Radix); 50ms lets that run before Escape.
        await page!.evaluate('new Promise(resolve => setTimeout(resolve, 50))');
        expect(await page!.evaluate('document.activeElement.id')).toBe('rename-field');
        await press('Escape');
        await waitFor(`!document.querySelector('[data-slot=dialog-content]') && document.activeElement?.id === 'area-menu-trigger'`, 'focus back on the menu trigger');
      } finally {
        if (motion === 'reduced') await page!.send('Emulation.setEmulatedMedia', { features: [] });
      }
    });
  }

  it('an aria-disabled Button that triggers a menu opens it by neither pointer nor key', async () => {
    await page!.evaluate(`document.getElementById('disabled-menu-trigger').scrollIntoView({ block: 'center' })`);
    await click('#disabled-menu-trigger');
    expect(await page!.evaluate(`!!document.querySelector('[data-slot=dropdown-menu-content]')`)).toBe(false);
    expect(await page!.evaluate('document.activeElement.id')).toBe('disabled-menu-trigger');
    for (const key of ['Enter', 'ArrowDown'] as const) {
      await press(key);
      expect(await page!.evaluate(`!!document.querySelector('[data-slot=dropdown-menu-content]')`)).toBe(false);
    }
    expect(await page!.evaluate(`document.getElementById('disabled-menu-trigger').getAttribute('aria-expanded')`)).toBe('false');
  });

  it('a tooltip around a toggle group item keeps the group one Tab stop, and arrow keys move it', async () => {
    // The items are the group's buttons (a wrapping trigger's data-slot replaces the item's own).
    const stops = () => page!.evaluate(`[...document.querySelectorAll('#tooltip-toggle-group button')].map(item => item.getAttribute('tabindex'))`);
    const active = () => page!.evaluate(`({ text: document.activeElement.textContent, inGroup: document.getElementById('tooltip-toggle-group').contains(document.activeElement) })`);
    // Radix's roving focus: each item carries its own tabindex, -1, or 0 for the one that last had focus (earlier Tab
    // passes may have been through the group); the group itself is the way in. A trigger that put tabindex 0 on every
    // item made each its own Tab stop.
    const atRest = await stops();
    expect(atRest.every((stop: string | null) => stop === '-1' || stop === '0')).toBe(true);
    expect(atRest.filter((stop: string | null) => stop === '0').length).toBeLessThanOrEqual(1);
    await page!.evaluate(`document.getElementById('disabled-menu-trigger').focus()`);
    await press('Tab');
    expect(await active()).toEqual({ text: 'cards', inGroup: true });
    await press('ArrowRight');
    expect(await active()).toEqual({ text: 'list', inGroup: true });
    // The roving focus group followed the focus, so the next Tab leaves the group instead of visiting "cards".
    expect(await stops()).toEqual(['-1', '0']);
    await press('Tab');
    expect((await active()).inGroup).toBe(false);
    await page!.evaluate('document.activeElement?.blur()');
  });

  it('a tooltip opened by keyboard focus stays open when that focus scrolls its trigger into view', async () => {
    await page!.evaluate(`window.scrollTo(0, 0); document.getElementById('before-far-tooltip').focus({ preventScroll: true })`);
    const scrolledBefore = await page!.evaluate('window.scrollY');
    await press('Tab');
    expect(await page!.evaluate('document.activeElement.id')).toBe('far-tooltip-trigger');
    expect(await page!.evaluate('window.scrollY')).toBeGreaterThan(scrolledBefore);
    // Before the fix Radix closed it 12–16ms after opening, on that scroll; 250ms is about fifteen frames later.
    await page!.evaluate('new Promise(resolve => setTimeout(resolve, 250))');
    expect(await page!.evaluate(`document.querySelector('[data-slot=tooltip-content]')?.textContent ?? null`)).toContain('Far identity');
    // A scroll the person makes afterwards still closes it, as Radix intends.
    await page!.evaluate('window.scrollBy(0, -200)');
    await waitFor(`!document.querySelector('[data-slot=tooltip-content]')`, 'a later scroll to close the tooltip');
    await page!.evaluate('document.activeElement?.blur(); window.scrollTo(0, 0)');
  });

  it('a table row with an action is a Tab stop that Enter opens, and numbers are right-aligned monospace', async () => {
    await tabUntil(`active.id === 'table-row'`);
    await press('Enter');
    const row = await page!.evaluate(`(() => { const cell = getComputedStyle(document.getElementById('numeric-cell'));
      return { activations: window.rowActivations, align: cell.textAlign, mono: /mono|Menlo/i.test(cell.fontFamily), numeric: cell.fontVariantNumeric }; })()`);
    expect(row).toEqual({ activations: 1, align: 'right', mono: true, numeric: 'tabular-nums' });
  });

  it('a spinner with words is announced once; a short list is plain and a long one is a focusable box with a count', async () => {
    expect(await page!.evaluate(`(() => { const line = document.getElementById('spinner-line');
      return { statuses: line.querySelectorAll('[role=status]').length, ringHidden: line.querySelector('svg').getAttribute('aria-hidden') }; })()`))
      .toEqual({ statuses: 1, ringHidden: 'true' });
    const lists = await page!.evaluate(`(() => ['scroll-short', 'scroll-long'].map(id => {
      const area = document.getElementById(id);
      const viewport = area.querySelector('[data-slot=scroll-area-viewport]');
      return { overflowing: area.hasAttribute('data-overflowing'), tabIndex: viewport.getAttribute('tabindex'), role: viewport.getAttribute('role'),
        caption: area.nextElementSibling?.dataset.slot === 'scroll-area-caption' ? area.nextElementSibling.textContent : null,
        edge: getComputedStyle(area).borderTopWidth };
    }))()`);
    expect(lists).toEqual([
      { overflowing: false, tabIndex: null, role: null, caption: null, edge: '0px' },
      { overflowing: true, tabIndex: '0', role: 'region', caption: '6 of 37 shown', edge: '1px' },
    ]);
  });

  it('state badges carry five different marks, the legacy next-step filler is a missing step, and a finished meter checks', async () => {
    const bits = await page!.evaluate(`(() => ({
      marks: [...document.querySelectorAll('#state-badges [data-state-mark]')].map(mark => mark.dataset.stateMark),
      shapes: [...document.querySelectorAll('#state-badges [data-state-mark] > *')].map(shape => {
        const style = getComputedStyle(shape);
        return [shape.tagName, style.backgroundColor !== 'rgba(0, 0, 0, 0)', style.backgroundImage !== 'none', style.borderTopWidth, style.borderTopColor === style.borderRightColor].join(' ');
      }),
      workingSpins: getComputedStyle(document.querySelector('[data-state-mark=working] > span')).animationName,
      legacy: document.getElementById('next-legacy').innerHTML,
      legacyDash: document.getElementById('next-legacy-dash').textContent,
      humanLabel: document.querySelector('#next-human [data-next-move=human] .block').textContent,
      finished: { now: document.querySelector('#meter-finished [role=progressbar]').getAttribute('aria-valuenow'),
        label: document.querySelector('#meter-finished [role=progressbar]').getAttribute('aria-label'),
        check: !!document.querySelector('#meter-finished [data-slot=progress-finished]') },
      unreviewed: document.querySelector('#meter-unreviewed [role=progressbar]').dataset.valueState,
    }))()`);
    expect(bits.marks).toEqual(['your-move', 'needs-check', 'working', 'idle', 'shipped']);
    expect(new Set(bits.shapes).size).toBe(5);
    // Still at every motion setting (G11 as amended): a card's one activity indicator is what moves (rule 8).
    expect(bits.workingSpins).toBe('none');
    expect(bits.legacy).toBe('');
    expect(bits.legacyDash).toBe('—No next step recorded');
    expect(bits.humanLabel).toBe('Your move');
    expect(bits.finished).toEqual({ now: '100', label: '100% complete', check: true });
    expect(bits.unreviewed).toBe('unknown');
    await page!.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    expect(await page!.evaluate(`getComputedStyle(document.querySelector('[data-state-mark=working] > span')).animationName`)).toBe('none');
    await page!.send('Emulation.setEmulatedMedia', { features: [] });
  });

  it('overlays and marks do not move under reduced motion (the components gate their own animations)', async () => {
    await page!.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await page!.evaluate(`document.getElementById('open-dialog').click()`);
    await waitFor(`!!document.querySelector('[data-slot=dialog-content]')`, 'the dialog to open');
    const still = await page!.evaluate(`({ dialog: getComputedStyle(document.querySelector('[data-slot=dialog-content]')).animationName,
      overlay: getComputedStyle(document.querySelector('[data-slot=dialog-overlay]')).animationName,
      spinner: getComputedStyle(document.querySelector('#spinner-line svg')).animationName })`);
    expect(still).toEqual({ dialog: 'none', overlay: 'none', spinner: 'none' });
    await press('Escape');
    await waitFor(`!document.querySelector('[data-slot=dialog-content]')`, 'the dialog to close');
    await page!.send('Emulation.setEmulatedMedia', { features: [] });
  });

  it('at a phone width with touch, the close buttons and fold row are 44px, and a tap toggles a tooltip and a hover card', async () => {
    await viewport(390, 844, true);
    await page!.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    expect(await heightOf('#fold-trigger')).toBeGreaterThanOrEqual(44);
    await page!.evaluate(`document.getElementById('open-dialog').click()`);
    await waitFor(`!!document.querySelector('[data-slot=dialog-close]')`, 'the dialog to open');
    expect(await heightOf('[data-slot=dialog-close]')).toBeGreaterThanOrEqual(44);
    await press('Escape');
    await waitFor(`!document.querySelector('[data-slot=dialog-content]')`, 'the dialog to close');

    // Each tap waits for its click, then for the tooltip or card to open (a frame after the click) or to finish its
    // 100–150ms exit. Closed means the trigger says so too: a tooltip that a tap closed and opened again is gone for
    // the frame before it shows.
    await page!.evaluate(`document.getElementById('tooltip-span-trigger').scrollIntoView({ block: 'center' })`);
    await tapThenWaitFor('#tooltip-span-trigger', `document.querySelector('[data-slot=tooltip-content]')?.textContent?.includes('Agent identity')`, 'a tap to open the tooltip');
    await tapThenWaitFor('#tooltip-span-trigger', `document.getElementById('tooltip-span-trigger').dataset.state === 'closed' && !document.querySelector('[data-slot=tooltip-content]')`, 'a second tap to close the tooltip');

    await page!.evaluate(`document.getElementById('hover-card-span-trigger').scrollIntoView({ block: 'center' })`);
    await tapThenWaitFor('#hover-card-span-trigger', `document.querySelector('[data-slot=hover-card-content]')?.textContent === 'Quoted on Nov 14'`, 'a tap to open the hover card');
    await tapThenWaitFor('#hover-card-span-trigger', `document.getElementById('hover-card-span-trigger').dataset.state === 'closed' && !document.querySelector('[data-slot=hover-card-content]')`, 'a second tap to close the hover card');
  });
});
