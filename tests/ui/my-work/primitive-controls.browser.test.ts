import { expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
  REPOSITORY_ROOT, UNTHROTTLED_TIMER_FLAGS, chromeExecutablePath, compileBrowserFixture, connectToPage,
  failOnCiWithoutChrome, htmlResponse, launchChrome, scriptResponse, withTimeout, type DevToolsPage, type OwnedChrome,
} from '../../helpers/chrome-devtools';

failOnCiWithoutChrome('CI requires Chrome for the My Work primitive size, cursor and focus regressions.');

/**
 * Tells Chrome it has a mouse, so the desktop half of this test runs on the desktop it describes on every platform.
 * Headless Chrome on Linux finds no pointing device: it reports `(hover: none)` and `(pointer: none)`, and a CDP mouse
 * move then gives a button `:hover` without the hover looks index.css keeps inside `@media (hover: hover)` (CI on PR
 * 6210; Chrome 157 and Chromium 156 on Linux, 2026-11-16). Chrome on macOS reports a mouse already. The values are
 * Blink's hover type "hover" (2) and pointer type "fine" (4), the setting Playwright 1.66 passes to every headless
 * Chromium it launches. Turning touch emulation off puts Chrome's own values back, so the hover checks run before the
 * touch part.
 */
const DESKTOP_MOUSE_FLAGS = ['--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4'];

/**
 * Phase 1 claims about My Work's control primitives, measured in a real browser on the app's real stylesheet:
 * - touch size (plan rule 6): on a coarse pointer, and at phone width, every Button, SelectTrigger, ToggleGroupItem,
 *   Switch, Input and Textarea renders at least 44px tall (icon buttons and toggles 44px wide too);
 * - desktop: the review's sizes, with sm controls and the switch taking presses across 44×44px;
 * - cursors and disabled (G16): hand cursor, not-allowed with pointer events left on, aria-disabled and busy ignore presses;
 * - looks: near-black text on orange (G1), control edges (G12), the toggle's chosen look without orange (D b22),
 *   the bare variant (G14), field states (D b12), number styles (rule 9);
 * - focus: Tab shows the shared ring on a Button; an interactive Card is a Tab stop that Enter opens.
 * Phase 1 fix round: a caller's own hover: class beats the primitive's hover look (the Team button keeps its tint); a
 * disabled switch inside a Label is dimmed once; an errored field says so and links its message; the toggle check sits
 * above a caller's highlight; a select row's highlight has a ≥3:1 mark; a popper select does not animate under
 * reduced motion. PR 6210 review: Command's search field shows the same focus look as an Input.
 */
(chromeExecutablePath ? it : it.skip)('control primitives own touch size, hit areas, cursors, disabled, busy and focus', async () => {
  // Compile the application's real stylesheet and candidates; hand-written fixture CSS could hide a regression.
  const app = resolve(REPOSITORY_ROOT, 'src/ui/my-work');
  const appRequire = createRequire(resolve(app, 'package.json'));
  const { compile } = appRequire('@tailwindcss/node');
  const { Scanner } = appRequire('@tailwindcss/oxide');
  const css = await compile(readFileSync(resolve(app, 'src/index.css'), 'utf8'), { base: app, onDependency() {} });
  const scanner = new Scanner({ sources: [{ base: resolve(app, 'src'), pattern: '**/*.{ts,tsx}', negated: false }] });
  // Plus the one class only this fixture uses (a caller's own pressed look); no app file has an active: background yet.
  const styles = css.build([...scanner.scan(), 'active:bg-accent']);
  const bundle = compileBrowserFixture(`
    import React from './src/ui/my-work/node_modules/react';
    import { createRoot } from './src/ui/my-work/node_modules/react-dom/client';
    import { flushSync } from './src/ui/my-work/node_modules/react-dom';
    import { Button, buttonVariants } from './src/ui/my-work/src/components/ui/button';
    import { Badge, BadgeMore, badgeVariants } from './src/ui/my-work/src/components/ui/badge';
    import { toggleVariants } from './src/ui/my-work/src/components/ui/toggle';
    import { Card, CardContent, CardFooter } from './src/ui/my-work/src/components/ui/card';
    import { Command, CommandInput } from './src/ui/my-work/src/components/ui/command';
    import { FieldCount, FieldHelperText, Input } from './src/ui/my-work/src/components/ui/input';
    import { Textarea } from './src/ui/my-work/src/components/ui/textarea';
    import { Label } from './src/ui/my-work/src/components/ui/label';
    import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './src/ui/my-work/src/components/ui/select';
    import { Switch } from './src/ui/my-work/src/components/ui/switch';
    import { ToggleGroup, ToggleGroupItem } from './src/ui/my-work/src/components/ui/toggle-group';
    window.React = React;
    const presses = { ariaDisabled: 0, busy: 0, card: 0, more: 0 };
    window.presses = presses;
    const Row = ({ children }) => <div style={{ padding: '40px 60px', display: 'flex', gap: 80, alignItems: 'center', flexWrap: 'wrap' }}>{children}</div>;
    const Icon = () => <svg viewBox="0 0 24 24"><path d="M4 4h16v16H4z" /></svg>;
    function Fixture() {
      const [view, setView] = React.useState('cards');
      return <main>
        <span data-test="focus-start" tabIndex={-1} />
        <Row>
          <Button data-test="button-default">Approve</Button>
          <Button data-test="button-outline" variant="outline">Edit</Button>
          <Button data-test="button-sm" variant="outline" size="sm">Why</Button>
          <Button data-test="button-xs" variant="ghost" size="xs">Undo</Button>
          <Button data-test="button-icon-sm" variant="ghost" size="icon-sm" aria-label="Edit rule"><Icon /></Button>
          <Button data-test="button-icon" variant="outline" size="icon" aria-label="Edit rule"><Icon /></Button>
          <Button data-test="button-lg" size="lg">Open focus area</Button>
          <Button data-test="button-link" variant="link">Read the build story</Button>
        </Row>
        <Row>
          <Button data-test="button-disabled" variant="outline" disabled>Refresh now</Button>
          <Button data-test="button-aria-disabled" variant="outline" aria-disabled="true" onClick={() => presses.ariaDisabled++}>Save rule</Button>
          <Button data-test="button-busy" variant="outline" busy onClick={() => presses.busy++}>Refresh now</Button>
          <Button data-test="button-busy-label" variant="outline" busy busyLabel="Refreshing…">Refresh now</Button>
        </Row>
        <Row>
          <div style={{ fontSize: '19px', fontWeight: 700, lineHeight: '30px' }}>
            <Button data-test="button-bare" variant="bare">A whole card title that reads like the words around it</Button>
          </div>
        </Row>
        <Row>
          <Select defaultValue="needs-you"><SelectTrigger data-test="select-default" aria-label="Sort"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="needs-you">Needs you first</SelectItem></SelectContent></Select>
          <Select><SelectTrigger data-test="select-sm" size="sm" aria-label="Move to another focus area"><SelectValue placeholder="Move to…" /></SelectTrigger>
            <SelectContent><SelectItem value="viewer">Viewer</SelectItem></SelectContent></Select>
        </Row>
        <Row>
          <ToggleGroup type="single" variant="outline" size="sm" spacing={1} value={view} onValueChange={(next) => next && setView(next)} aria-label="View">
            <ToggleGroupItem data-test="toggle-chosen" value="cards">Cards</ToggleGroupItem>
            <ToggleGroupItem data-test="toggle-other" value="list">List</ToggleGroupItem>
          </ToggleGroup>
          <ToggleGroup type="single" variant="outline" spacing={1} defaultValue="all" aria-label="Filter">
            <ToggleGroupItem data-test="toggle-default" value="all">All</ToggleGroupItem>
          </ToggleGroup>
        </Row>
        <Row>
          <Switch data-test="switch-on" defaultChecked aria-label="Dark" />
          <Switch data-test="switch-off" aria-label="Spec IDs" />
          <Switch data-test="switch-sm" size="sm" aria-label="Compact" />
          <Label data-test="label-switch"><Switch data-test="switch-in-label" />Rule is on</Label>
          <Label data-test="label-switch-disabled"><Switch data-test="switch-in-label-disabled" disabled />Rule is locked</Label>
          <Switch data-test="switch-disabled" disabled aria-label="Locked" />
          <Label data-test="label-optional" htmlFor="input" optional>When</Label>
          <Label data-test="label-required" htmlFor="textarea" required>Then</Label>
        </Row>
        <Row>
          <div style={{ width: 320 }}><Input data-test="input" aria-describedby="hint" /><FieldHelperText id="hint">Leave empty for always.</FieldHelperText></div>
          <div style={{ width: 320 }}><Textarea data-test="textarea" /><FieldCount data-test="count" count={60} limit={60} /></div>
          <div style={{ width: 320 }}><Input data-test="input-readonly" readOnly value="~/.claude-mem/MY-RULES.md" /></div>
          <div style={{ width: 320 }}><Input data-test="input-disabled" disabled /><FieldHelperText data-test="error" tone="error">A repo name has no spaces.</FieldHelperText></div>
          <div data-test="errored-field" style={{ width: 320 }}><Input data-test="input-error" aria-describedby="hint" error="A repo name has no spaces." /></div>
          {/* The search field of Move to…'s list (Popover + Command, G15). No rows: cmdk scrolls its chosen row into view,
              which would scroll this page. */}
          <div style={{ width: 320 }}><Command label="Move to"><CommandInput data-test="command-input" placeholder="Move to…" /></Command></div>
        </Row>
        <Row>
          {/* App.tsx TeamSwitch with Team on: the caller's own hover tint must win over the primitive's hover look. */}
          <Button data-test="team-on" variant="secondary" size="sm" className="bg-accent text-accent-foreground hover:bg-accent">Team</Button>
          <Button data-test="secondary-plain" variant="secondary" size="sm">Plain</Button>
          <Button data-test="press-override" variant="outline" className="active:bg-accent">Pressed</Button>
          {/* pages/my-work.tsx View switcher: a sliding pill drawn inside the chosen item, under its words. */}
          <ToggleGroup type="single" variant="outline" size="sm" spacing={1} value="cards" aria-label="View with pill">
            <ToggleGroupItem data-test="pill-item" value="cards" className="relative data-[state=on]:bg-transparent"><span className="absolute inset-0 rounded-[inherit] bg-accent" /><span data-test="pill-label" className="relative">Cards</span></ToggleGroupItem>
          </ToggleGroup>
          <Select><SelectTrigger data-test="select-popper" aria-label="Pick"><SelectValue placeholder="Pick" /></SelectTrigger>
            <SelectContent position="popper"><SelectItem value="one">One</SelectItem></SelectContent></Select>
        </Row>
        <Row>
          <Badge data-test="badge-outline" variant="outline">30 requests</Badge>
          <span data-test="badge-more-row"><BadgeMore hiddenCount={3} onShowAll={() => presses.more++} /></span>
          <span data-test="tabular" className="tabular">195</span>
          <span data-test="mono" className="mono-number">90%</span>
        </Row>
        <Row>
          <div style={{ width: 300, height: 260, display: 'grid' }}><Card data-test="card" interactive aria-label="Open request" onClick={() => presses.card++}><CardContent>Card</CardContent><CardFooter>Footer</CardFooter></Card></div>
        </Row>
      </main>;
    }
    const element = (name) => document.querySelector('[data-test="' + name + '"]');
    const rect = (name) => element(name).getBoundingClientRect();
    const style = (name, pseudo) => getComputedStyle(element(name), pseudo);
    const round = (value) => Math.round(value * 100) / 100;
    // A press 21.5px from the centre in each direction lands on the control: its hit area is at least 43×43, i.e. 44.
    const hitArea = (name) => {
      const target = element(name), box = rect(name), x = box.left + box.width / 2, y = box.top + box.height / 2;
      const lands = (px, py) => { const hit = document.elementFromPoint(px, py); return !!hit && (hit === target || target.contains(hit)); };
      return [lands(x, y - 21.5), lands(x, y + 21.5), lands(x - 21.5, y), lands(x + 21.5, y)].every(Boolean);
    };
    const CONTROLS = ['button-default', 'button-outline', 'button-sm', 'button-xs', 'button-icon-sm', 'button-icon', 'button-lg', 'button-link',
      'button-bare', 'select-default', 'select-sm', 'toggle-chosen', 'toggle-other', 'toggle-default', 'switch-on', 'switch-off', 'switch-sm',
      'input', 'textarea'];
    const SQUARE_CONTROLS = ['button-icon-sm', 'button-icon', 'button-xs', 'toggle-chosen', 'toggle-other', 'switch-sm'];
    window.measureTouch = () => ({
      coarse: matchMedia('(pointer: coarse)').matches,
      width: innerWidth,
      shorterThan44: CONTROLS.filter((name) => rect(name).height < 44).map((name) => name + ' ' + round(rect(name).height)),
      narrowerThan44: SQUARE_CONTROLS.filter((name) => rect(name).width < 44).map((name) => name + ' ' + round(rect(name).width)),
      switchTrack: [style('switch-off', '::before').width, style('switch-off', '::before').height],
    });
    window.measureDesktop = () => ({
      coarse: matchMedia('(pointer: coarse)').matches,
      rootFontSize: getComputedStyle(document.documentElement).fontSize,
      heights: Object.fromEntries(['button-default', 'button-sm', 'button-icon', 'button-icon-sm', 'button-lg', 'select-default', 'select-sm', 'toggle-chosen', 'toggle-default', 'switch-off', 'input', 'textarea']
        .map((name) => [name, round(rect(name).height)])),
      hitAreas: Object.fromEntries(['button-sm', 'button-icon-sm', 'select-sm', 'toggle-chosen', 'toggle-default', 'switch-off', 'switch-sm', 'badge-more-row'].map((name) => [name, hitArea(name === 'badge-more-row' ? 'badge-more-row' : name)])),
      switchTrack: [style('switch-off', '::before').width, style('switch-off', '::before').height],
      cursors: Object.fromEntries(['button-default', 'button-link', 'button-bare', 'select-default', 'toggle-other', 'switch-off', 'label-switch', 'card', 'input-disabled', 'button-disabled', 'button-aria-disabled', 'button-busy']
        .map((name) => [name, style(name).cursor])),
      disabled: { opacity: style('button-disabled').opacity, pointerEvents: style('button-disabled').pointerEvents,
        ariaOpacity: style('button-aria-disabled').opacity, inputPointerEvents: style('input-disabled').pointerEvents },
      primary: { color: style('button-default').color, textShadow: style('button-default').textShadow },
      edges: { outlineButton: style('button-outline').borderTopColor, select: style('select-default').borderTopColor, input: style('input').borderTopColor,
        textarea: style('textarea').borderTopColor, badge: style('badge-outline').borderTopColor, toggleOther: style('toggle-other').borderTopColor,
        switchOff: style('switch-off', '::before').borderTopColor, switchOn: style('switch-on', '::before').borderTopColor },
      toggle: { chosenWeight: style('toggle-chosen').fontWeight, chosenStroke: style('toggle-chosen').webkitTextStrokeWidth,
        chosenBackground: style('toggle-chosen').backgroundColor, chosenEdge: style('toggle-chosen').borderTopColor,
        chosenCheck: getComputedStyle(element('toggle-chosen').querySelector('[data-slot=toggle-check]')).visibility,
        otherCheck: getComputedStyle(element('toggle-other').querySelector('[data-slot=toggle-check]')).visibility,
        otherWeight: style('toggle-other').fontWeight, otherStroke: style('toggle-other').webkitTextStrokeWidth },
      switchCheck: { on: getComputedStyle(element('switch-on').querySelector('[data-slot=switch-check]')).opacity,
        off: getComputedStyle(element('switch-off').querySelector('[data-slot=switch-check]')).opacity },
      bare: { padding: style('button-bare').padding, background: style('button-bare').backgroundColor, border: style('button-bare').borderTopColor,
        fontSize: style('button-bare').fontSize, fontWeight: style('button-bare').fontWeight, lineHeight: style('button-bare').lineHeight, whiteSpace: style('button-bare').whiteSpace },
      busy: { ariaBusy: element('button-busy').getAttribute('aria-busy'), spinner: !!element('button-busy').querySelector('[data-slot=button-spinner]'),
        text: element('button-busy').textContent, labelled: element('button-busy-label').textContent },
      fields: { autoComplete: element('input').getAttribute('autocomplete'), readOnlyEdge: style('input-readonly').borderTopStyle,
        countText: element('count').textContent, countColor: style('count').color, errorIcon: !!element('error').querySelector('svg') },
      numbers: { tabular: style('tabular').fontVariantNumeric, monoFamily: style('mono').fontFamily, monoNumeric: style('mono').fontVariantNumeric },
      // A card stretched to its row's height (260px here) keeps its footer on the bottom edge, inside the 1px border.
      labels: { aroundSwitchTall: rect('label-switch').height >= 44, optional: element('label-optional').textContent,
        required: element('label-required').textContent, requiredMarkHidden: element('label-required').querySelector('[data-slot=label-required]').getAttribute('aria-hidden') },
      card: { tabIndex: element('card').getAttribute('tabindex'), stretched: round(rect('card').height),
        footerGap: round(rect('card').bottom - element('card').querySelector('[data-slot=card-footer]').getBoundingClientRect().bottom) },
    });
    window.pressBlockedButtons = async () => {
      element('button-aria-disabled').click(); element('button-busy').click();
      element('badge-more-row').querySelector('button').click();
      element('label-switch').click();
      // The switch's new state renders after the click event; React commits it before the next frame, so two frames.
      for (let frame = 0; frame < 2; frame++) await new Promise(requestAnimationFrame);
      return { ...presses, labelToggledSwitch: element('switch-in-label').getAttribute('aria-checked') };
    };
    window.disabledSwitchLooks = () => ({
      // Effective opacity: the label's own times the switch's own.
      inLabel: Number(style('label-switch-disabled').opacity) * Number(style('switch-in-label-disabled').opacity),
      alone: Number(style('switch-disabled').opacity),
    });
    window.erroredField = () => {
      const field = element('input-error');
      const ids = (field.getAttribute('aria-describedby') ?? '').split(' ');
      const line = document.getElementById(ids[1] ?? '');
      return { invalid: field.getAttribute('aria-invalid'), firstDescribedBy: ids[0], lineTone: line?.dataset.tone ?? null,
        lineText: line?.textContent ?? null, edge: style('input-error').borderTopColor, lineAfterField: field.nextElementSibling === line };
    };
    window.checkAbovePill = () => {
      const svg = element('pill-item').querySelector('[data-slot=toggle-check]');
      const check = svg.getBoundingClientRect();
      const label = element('pill-label').getBoundingClientRect();
      // Hit testing follows paint order. The check never takes presses (pointer-events: none), so it takes them for
      // this one look only.
      svg.style.setProperty('pointer-events', 'auto', 'important');
      const top = document.elementFromPoint(check.left + check.width / 2, check.top + check.height / 2);
      svg.style.removeProperty('pointer-events');
      return { checkOnTop: !!top?.closest('[data-slot=toggle-check]'), checkBeforeLabel: check.right <= label.left,
        sameRow: Math.abs((check.top + check.bottom) / 2 - (label.top + label.bottom) / 2) < 1 };
    };
    window.middleOf = (name) => { const box = rect(name); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; };
    window.backgroundOf = async (name) => {
      await Promise.all(element(name).getAnimations().filter((animation) => animation instanceof CSSTransition).map((animation) => animation.finished));
      return style(name).backgroundColor;
    };
    // With the look, whether Chrome has a pointer that can hover and whether it is over the button, so a look that did
    // not change says which of the three it was. The page has no doctype, and in quirks mode a bare :hover matches only
    // links, so the check names an attribute too.
    window.hoverLook = async (name) => ({ hoverCapablePointer: matchMedia('(hover: hover)').matches, hovered: element(name).matches('[data-test]:hover'),
      background: await window.backgroundOf(name) });
    window.focusState = async () => {
      // Controls ease their colours (transition-all), so read the focus look once its transitions have finished.
      await Promise.all(document.activeElement.getAnimations().filter((animation) => animation instanceof CSSTransition).map((animation) => animation.finished));
      return { focused: document.activeElement?.dataset.test, focusVisible: document.activeElement?.matches(':focus-visible'),
        boxShadow: getComputedStyle(document.activeElement).boxShadow, edge: getComputedStyle(document.activeElement).borderTopColor };
    };
    window.spinnerAnimation = () => getComputedStyle(element('button-busy').querySelector('[data-slot=button-spinner]')).animationName;
    window.setDark = (dark) => document.documentElement.classList.toggle('dark', dark);
    window.darkEdges = async () => {
      // One frame, so the theme change has restyled and its colour transitions exist before they are awaited.
      await new Promise(requestAnimationFrame);
      // Transitions only: the busy spinner's spin never finishes.
      await Promise.all(document.getAnimations().filter((animation) => animation instanceof CSSTransition).map((animation) => animation.finished));
      return { outlineButton: style('button-outline').borderTopColor, primaryText: style('button-default').color, ring: style('select-default').getPropertyValue('--ring').trim() };
    };
    // Every variant and size name still adds its own classes (D b3 K66/72, b4 K90/97, b22 K465, b23): a removed name would fall
    // back to the bare base classes.
    window.namesWithoutClasses = () => {
      const missing = [];
      const check = (kind, make, axis, names) => { const base = make({ [axis]: null }); for (const name of names) if (make({ [axis]: name }) === base) missing.push(kind + ' ' + axis + ' ' + name); };
      check('button', buttonVariants, 'variant', ['default', 'outline', 'secondary', 'ghost', 'destructive', 'link', 'bare']);
      check('button', buttonVariants, 'size', ['default', 'xs', 'sm', 'lg', 'icon', 'icon-xs', 'icon-sm', 'icon-lg']);
      check('badge', badgeVariants, 'variant', ['default', 'secondary', 'destructive', 'outline', 'ghost', 'link']);
      check('toggle', toggleVariants, 'variant', ['default', 'outline']);
      check('toggle', toggleVariants, 'size', ['default', 'sm', 'lg']);
      return missing;
    };
    window.focusOn = (name) => element(name).focus();
    window.activeName = () => document.activeElement?.dataset.test ?? document.activeElement?.getAttribute('role');
    // A field's focus look: an Input draws it on itself, Command's search field on the InputGroup around it.
    window.fieldLook = async (name) => {
      const box = element(name).closest('[data-slot=input-group]') ?? element(name);
      await Promise.all(box.getAnimations().filter((animation) => animation instanceof CSSTransition).map((animation) => animation.finished));
      return { focusVisible: element(name).matches(':focus-visible'), edge: getComputedStyle(box).borderTopColor, boxShadow: getComputedStyle(box).boxShadow };
    };
    window.switchFocusRing = () => style('switch-off', '::before').boxShadow;
    window.toggleRoles = () => [element('toggle-chosen').getAttribute('role'), element('toggle-other').getAttribute('role')];
    window.openList = () => {
      const list = document.querySelector('[role=listbox]');
      const chosen = list?.querySelector('[data-slot=select-item][data-state=checked]');
      return { listbox: !!list, chosenHasCheck: !!chosen?.querySelector('svg'), highlighted: chosen ? getComputedStyle(chosen).backgroundColor : null,
        mark: chosen ? getComputedStyle(chosen).boxShadow : null };
    };
    window.popperListAnimation = () => getComputedStyle(document.querySelector('[data-slot=select-content]')).animationName;
    flushSync(() => createRoot(document.getElementById('root')).render(<Fixture />));
    fetch('/fixture-ready');
  `);
  let markReady!: () => void;
  const ready = new Promise<void>((resolveReady) => { markReady = resolveReady; });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/') return htmlResponse('<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/fixture.js"></script>');
    if (path === '/fixture.js') return scriptResponse(bundle);
    if (path === '/app.css') return new Response(styles, { headers: { 'Content-Type': 'text/css' } });
    if (path === '/fixture-ready') { markReady(); return new Response('ready'); }
    return new Response('not found', { status: 404 });
  } });
  let chrome: OwnedChrome | undefined;
  let page: DevToolsPage | undefined;
  const rgb = (hex: string) => `rgb(${[1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16)).join(', ')})`;
  try {
    chrome = launchChrome(server.url.href, { profilePrefix: 'claude-mem-primitives-', remoteDebugging: true,
      extraFlags: [...UNTHROTTLED_TIMER_FLAGS, ...DESKTOP_MOUSE_FLAGS] });
    // Chrome starts and runs this fixture in 0.65–0.94s here (3 runs, 2026-11-16); 15s is about 16× that, for a cold
    // Chrome on a shared CI runner.
    await withTimeout(ready, 15_000, 'Primitive fixture did not start');
    page = await connectToPage(chrome, server.url.href);

    // Desktop, fine pointer, 1440 wide (the 17px root).
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1400, deviceScaleFactor: 1, mobile: false });
    await page.settle();
    const desktop = await page.evaluate('window.measureDesktop()');
    expect(desktop.coarse).toBe(false);
    expect(desktop.rootFontSize).toBe('17px');
    // The review's sizes: default, icon, select and input at least 44px; lg at least 48px; sm keeps a smaller look.
    for (const name of ['button-default', 'button-icon', 'select-default', 'input']) expect(desktop.heights[name]).toBeGreaterThanOrEqual(44);
    expect(desktop.heights['button-lg']).toBeGreaterThanOrEqual(48);
    for (const name of ['button-sm', 'button-icon-sm', 'select-sm', 'toggle-chosen', 'switch-off']) expect(desktop.heights[name]).toBeLessThan(44);
    expect(desktop.heights.textarea).toBeGreaterThanOrEqual(80);
    expect(desktop.hitAreas).toEqual({ 'button-sm': true, 'button-icon-sm': true, 'select-sm': true, 'toggle-chosen': true, 'toggle-default': true,
      'switch-off': true, 'switch-sm': true, 'badge-more-row': true });
    expect(desktop.switchTrack).toEqual(['44px', '24px']);
    expect(desktop.cursors).toEqual({ 'button-default': 'pointer', 'button-link': 'pointer', 'button-bare': 'pointer', 'select-default': 'pointer',
      'toggle-other': 'pointer', 'switch-off': 'pointer', 'label-switch': 'pointer', card: 'pointer', 'input-disabled': 'not-allowed',
      'button-disabled': 'not-allowed', 'button-aria-disabled': 'not-allowed', 'button-busy': 'progress' });
    expect(desktop.disabled).toEqual({ opacity: '0.5', pointerEvents: 'auto', ariaOpacity: '0.5', inputPointerEvents: 'auto' });
    expect(desktop.primary).toEqual({ color: rgb('#0f0c0a'), textShadow: 'none' });
    const lightEdge = rgb('#8f8071');
    expect(desktop.edges).toEqual({ outlineButton: lightEdge, select: lightEdge, input: lightEdge, textarea: lightEdge, badge: lightEdge,
      toggleOther: lightEdge, switchOff: lightEdge, switchOn: rgb('#e55800') });
    // The chosen toggle reads heavier by a 0.5px stroke on the same weight, and its check keeps its room when hidden, so
    // choosing an item does not widen it (widths on the real page: toggle-width.browser.test.ts).
    expect(desktop.toggle).toEqual({ chosenWeight: '500', chosenStroke: '0.5px', chosenBackground: rgb('#f3ece3'), chosenEdge: rgb('#75685c'),
      chosenCheck: 'visible', otherCheck: 'hidden', otherWeight: '500', otherStroke: '0px' });
    expect(desktop.switchCheck).toEqual({ on: '1', off: '0' });
    expect(desktop.bare).toEqual({ padding: '0px', background: 'rgba(0, 0, 0, 0)', border: 'rgba(0, 0, 0, 0)', fontSize: '19px', fontWeight: '700',
      lineHeight: '30px', whiteSpace: 'normal' });
    expect(desktop.busy).toEqual({ ariaBusy: 'true', spinner: true, text: 'Refresh nowWorking…', labelled: 'Refreshing…' });
    expect(desktop.fields).toEqual({ autoComplete: 'off', readOnlyEdge: 'dashed', countText: '60 / 6060 of 60 characters', countColor: rgb('#925e0e'), errorIcon: true });
    expect(desktop.numbers.tabular).toBe('tabular-nums');
    expect(desktop.numbers.monoNumeric).toBe('tabular-nums');
    expect(desktop.numbers.monoFamily).toContain('monospace');
    expect(desktop.card).toEqual({ tabIndex: '0', stretched: 260, footerGap: 1 });
    // A label around a switch is one 44px hit area; the one shared optional / required mark (D b13 M273, M274).
    expect(desktop.labels).toEqual({ aroundSwitchTall: true, optional: 'Whenoptional', required: 'Then*required', requiredMarkHidden: 'true' });
    // aria-disabled and busy buttons ignore presses; the "+3 more" chip and a label around a switch act.
    expect(await page.evaluate('window.pressBlockedButtons()')).toEqual({ ariaDisabled: 0, busy: 0, card: 0, more: 1, labelToggledSwitch: 'true' });
    // A disabled switch inside a Label is dimmed once (the label's 0.5), not twice; on its own it dims itself.
    expect(await page.evaluate('window.disabledSwitchLooks()')).toEqual({ inLabel: 0.5, alone: 0.5 });
    // An errored field says so, keeps the caller's hint first, and links the error line drawn under it.
    expect(await page.evaluate('window.erroredField()')).toEqual({ invalid: 'true', firstDescribedBy: 'hint', lineTone: 'error',
      lineText: 'Error: A repo name has no spaces.', edge: rgb('#a33733'), lineAfterField: true });
    // The chosen toggle's check is drawn above a caller's highlight inside the item, before its words, on one row.
    expect(await page.evaluate('window.checkAbovePill()')).toEqual({ checkOnTop: true, checkBeforeLabel: true, sameRow: true });

    // Hover with a real pointer: the caller's hover: class keeps the Team button's tint; a plain secondary still changes.
    const hover = async (name: string) => {
      const { x, y } = await page!.evaluate(`window.middleOf(${JSON.stringify(name)})`);
      await page!.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await page!.settle();
    };
    const plainAtRest = await page.evaluate('window.backgroundOf("secondary-plain")');
    await hover('team-on');
    expect(await page.evaluate('window.hoverLook("team-on")')).toEqual({ hoverCapablePointer: true, hovered: true, background: rgb('#fdebdd') });
    await hover('secondary-plain');
    const plainHovered = await page.evaluate('window.hoverLook("secondary-plain")');
    expect({ hoverCapablePointer: plainHovered.hoverCapablePointer, hovered: plainHovered.hovered, lookChanged: plainHovered.background !== plainAtRest })
      .toEqual({ hoverCapablePointer: true, hovered: true, lookChanged: true });
    // A caller's active: class wins over the primitive's pressed look in the same way.
    {
      const { x, y } = await page.evaluate('window.middleOf("press-override")');
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await page.settle();
      expect(await page.evaluate('window.backgroundOf("press-override")')).toBe(rgb('#fdebdd'));
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
      await page.settle();
    }

    // Keyboard: Tab from the top lands on the first Button with the shared ring; Enter on a focused interactive Card opens it.
    await page.evaluate('document.querySelector(\'[data-test="focus-start"]\').focus()');
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await page.settle();
    const buttonFocus = await page.evaluate('window.focusState()');
    expect(buttonFocus.focused).toBe('button-default');
    expect(buttonFocus.focusVisible).toBe(true);
    expect(buttonFocus.edge).toBe(rgb('#e15c02'));
    expect(buttonFocus.boxShadow).toContain('0px 0px 0px 3px');
    await page.evaluate('document.querySelector(\'[data-test="card"]\').focus()');
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await page.settle();
    const cardFocus = await page.evaluate('window.focusState()');
    expect(cardFocus.focused).toBe('card');
    expect(cardFocus.focusVisible).toBe(true);
    expect(cardFocus.boxShadow).toContain('0px 0px 0px 3px');
    expect(await page.evaluate('window.presses.card')).toBe(1);

    // Reduced motion: the busy spinner stops inside the component.
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    expect(await page.evaluate('window.spinnerAnimation()')).toBe('none');
    await page.send('Emulation.setEmulatedMedia', { features: [] });

    expect(await page.evaluate('window.namesWithoutClasses()')).toEqual([]);
    const pressKey = async (key: string, code: string, keyCode: number) => {
      await page!.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode });
      await page!.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
      await page!.settle();
    };
    // Input keeps its orange focus edge (D b12 K245/248).
    await page.evaluate('window.focusOn("input")');
    const inputFocused = await page.evaluate('window.fieldLook("input")');
    expect(inputFocused.edge).toBe(rgb('#e15c02'));
    // Command's search field shows that look too, on its group: the same edge and the same 3px ring (it showed none).
    const ringOf = (boxShadow: string) => boxShadow.match(/(?:[a-z]+\([^)]*\)|#[0-9a-f]+) 0px 0px 0px 3px/)?.[0] ?? null;
    const inputRing = ringOf(inputFocused.boxShadow);
    expect(inputRing).not.toBeNull();
    const commandAtRest = await page.evaluate('window.fieldLook("command-input")');
    expect({ edge: commandAtRest.edge, ring: ringOf(commandAtRest.boxShadow) }).toEqual({ edge: lightEdge, ring: null });
    await page.evaluate('window.focusOn("command-input")');
    const commandFocused = await page.evaluate('window.fieldLook("command-input")');
    expect({ focusVisible: commandFocused.focusVisible, edge: commandFocused.edge, ring: ringOf(commandFocused.boxShadow) })
      .toEqual({ focusVisible: true, edge: inputFocused.edge, ring: inputRing });
    // Switch keeps its focus ring, now on the track (D b19 K389).
    await page.evaluate('window.focusOn("switch-off")');
    await page.settle();
    expect(await page.evaluate('window.switchFocusRing()')).toContain('0px 0px 0px 3px');
    // Toggle group items stay radios that arrow keys move between (D b22 K459).
    expect(await page.evaluate('window.toggleRoles()')).toEqual(['radio', 'radio']);
    await page.evaluate('window.focusOn("toggle-chosen")');
    await pressKey('ArrowRight', 'ArrowRight', 39);
    expect(await page.evaluate('window.activeName()')).toBe('toggle-other');
    // Select keeps its listbox and the check on the chosen row (D b16 K328); the highlighted row is --input.
    await page.evaluate('window.focusOn("select-default")');
    await pressKey('Enter', 'Enter', 13);
    await page.settle();
    const list = await page.evaluate('window.openList()');
    expect({ listbox: list.listbox, chosenHasCheck: list.chosenHasCheck, highlighted: list.highlighted })
      .toEqual({ listbox: true, chosenHasCheck: true, highlighted: rgb('#e1d6c8') });
    // The highlighted row's mark: a 1px --muted-foreground edge, ≥3:1 against the list (token contrast test).
    expect(list.mark).toContain(`${rgb('#75685c')} 0px 0px 0px 1px inset`);
    await pressKey('Escape', 'Escape', 27);
    // A popper-positioned list does not animate open under reduced motion (the component gates it, rule 8).
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await page.evaluate('window.focusOn("select-popper")');
    await pressKey('Enter', 'Enter', 13);
    await page.settle();
    expect(await page.evaluate('window.popperListAnimation()')).toBe('none');
    await pressKey('Escape', 'Escape', 27);
    await page.send('Emulation.setEmulatedMedia', { features: [] });

    // Dark theme: the dark control edge, and near-black text on orange.
    await page.evaluate('window.setDark(true)');
    expect(await page.evaluate('window.darkEdges()')).toEqual({ outlineButton: rgb('#897869'), primaryText: rgb('#0f0c0a'), ring: '#ff8a3d' });
    await page.evaluate('window.setDark(false)');

    // Coarse pointer at a desktop width: the pointer clause alone makes every control 44px.
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await page.settle();
    expect(await page.evaluate('window.measureTouch()')).toEqual({ coarse: true, width: 1440, shorterThan44: [], narrowerThan44: [], switchTrack: ['44px', '24px'] });
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: false });

    // Phone width with a fine pointer: the width clause alone makes every control 44px.
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 1400, deviceScaleFactor: 1, mobile: false });
    await page.settle();
    expect(await page.evaluate('window.measureTouch()')).toEqual({ coarse: false, width: 390, shorterThan44: [], narrowerThan44: [], switchTrack: ['44px', '24px'] });
  } finally {
    page?.close();
    await chrome?.close();
    server.stop(true);
  }
  // The whole test, stylesheet compile included, takes 3.2–3.8s here (same runs); 90s is about 24× that, for a slow CI
  // runner.
}, 90_000);
