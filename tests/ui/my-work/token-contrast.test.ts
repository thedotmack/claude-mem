import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * My Work's colour tokens meet the plan's contrast rules (rule 7 and decision G12) in both themes: text ≥4.5:1;
 * control edges, the focus ring, progress fills and the switch's on edge ≥3:1 against every surface they sit on.
 * The formula is the one the UI UX Pro Max review measured with (tools/D-lib.mjs lines 7-9): WCAG relative
 * luminance and (L1 + 0.05) / (L2 + 0.05). Ratios are compared unrounded.
 */

const INDEX_CSS = readFileSync(resolve(import.meta.dir, '../../../src/ui/my-work/src/index.css'), 'utf8');
const BITS_SOURCE = readFileSync(resolve(import.meta.dir, '../../../src/ui/my-work/src/components/bits.tsx'), 'utf8');
const APP_BAR_SOURCE = readFileSync(resolve(import.meta.dir, '../../../src/ui/my-work/src/components/app-bar.tsx'), 'utf8');

/** The custom properties declared in the block that opens a line with `selector {`. */
function readThemeBlock(selector: string): Record<string, string> {
  const opening = new RegExp(`^${selector.replace('.', '\\.')} \\{`, 'm').exec(INDEX_CSS);
  if (!opening) throw new Error(`index.css has no "${selector} {" block`);
  const body = INDEX_CSS.slice(opening.index + opening[0].length, INDEX_CSS.indexOf('\n}', opening.index));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));
}

const ROOT_TOKENS = readThemeBlock(':root');
// The dark block overrides :root; anything it leaves out is inherited from :root by the cascade.
const THEMES = { light: ROOT_TOKENS, dark: { ...ROOT_TOKENS, ...readThemeBlock('.dark') } } as const;
type ThemeName = keyof typeof THEMES;
type Rgb = [number, number, number];

function tokenRgb(theme: ThemeName, name: string): Rgb {
  const value = THEMES[theme][name];
  if (value === undefined) throw new Error(`--${name} is not defined for the ${theme} theme`);
  if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`--${name} is "${value}" in the ${theme} theme; this test reads #rrggbb only`);
  return [1, 3, 5].map((offset) => parseInt(value.slice(offset, offset + 2), 16)) as Rgb;
}

/** `top` at `alpha` over an opaque `under`: what Tailwind's `bg-x/NN` paints on a surface. */
const over = (top: Rgb, alpha: number, under: Rgb): Rgb => top.map((channel, index) => channel * alpha + under[index] * (1 - alpha)) as Rgb;
const luminance = (color: Rgb) => {
  const linear = (channel: number) => { const value = channel / 255; return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * linear(color[0]) + 0.7152 * linear(color[1]) + 0.0722 * linear(color[2]);
};
const contrast = (first: Rgb, second: Rgb) => {
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
};

/** Every surface a page, panel, popover or control fill paints under text and control edges. */
const PAINTED_SURFACES = ['background', 'card', 'popover', 'muted', 'secondary', 'surface', 'surface-warm', 'surface-cool', 'sidebar'];

/**
 * Surfaces a control edge sits on: the painted surfaces plus the field fills the primitives draw in the dark theme
 * (`dark:bg-input/20` Input, `dark:bg-input/30` Textarea and SelectTrigger, `dark:hover:bg-input/50` SelectTrigger
 * hover) over the card and the popover (dialogs). `input/30` on the popover is `#312923`, where the review's
 * `#7d6e60` measured 2.9:1 (G12).
 */
function controlSurfaces(theme: ThemeName): Array<[string, Rgb]> {
  const surfaces: Array<[string, Rgb]> = PAINTED_SURFACES.map((name) => [name, tokenRgb(theme, name)]);
  for (const alpha of [0.2, 0.3, 0.5]) {
    for (const under of ['card', 'popover']) {
      surfaces.push([`input/${alpha * 100} on ${under}`, over(tokenRgb(theme, 'input'), alpha, tokenRgb(theme, under))]);
    }
  }
  return surfaces;
}

function expectAtLeast(theme: ThemeName, foreground: string, background: [string, Rgb], minimum: number, why: string) {
  const ratio = contrast(tokenRgb(theme, foreground), background[1]);
  // The message names the pair so a failure says which token to move, and by how much.
  expect({ pair: `${theme}: --${foreground} on ${background[0]}`, why, passes: ratio >= minimum, ratio: Number(ratio.toFixed(2)) })
    .toEqual({ pair: `${theme}: --${foreground} on ${background[0]}`, why, passes: true, ratio: Number(ratio.toFixed(2)) });
}

/**
 * The colour family each request state paints with (`working`, `review`, …), read from STATE_SURFACE in bits.tsx:
 * the Record<LiveState, …> that StateBadge, the List status and the progress fills take their colours from. A new
 * state fails the typecheck until it has an entry there, and then this test checks its colours too. Each entry names
 * its family as `bg-<family>` with `text-<family>-foreground`.
 */
function stateColourFamilies(): string[] {
  const table = /export const STATE_SURFACE: Record<LiveState, string> = \{([\s\S]*?)\n\}/.exec(BITS_SOURCE);
  if (!table) throw new Error('bits.tsx has no "export const STATE_SURFACE: Record<LiveState, string> = {" table');
  const entries = [...table[1].matchAll(/^\s*'?([\w-]+)'?: '([^']*)',?$/gm)];
  if (entries.length === 0) throw new Error('STATE_SURFACE in bits.tsx has no entries this test can read');
  return [...new Set(entries.map(([, state, classes]) => {
    const family = /(?:^| )bg-([\w-]+)(?= |$)/.exec(classes)?.[1];
    if (!family || !classes.split(' ').includes(`text-${family}-foreground`)) {
      throw new Error(`STATE_SURFACE['${state}'] does not paint a bg-<family> with its text-<family>-foreground: "${classes}"`);
    }
    return family;
  }))];
}

const STATES = stateColourFamilies();

/**
 * The colour of the edge that marks the bar's place shown, read from components/app-bar.tsx PlaceLink
 * (`aria-[current=page]:border-b-<colour>`): the mark that is not colour alone, so this test follows the code.
 */
function activePlaceMarkColour(): string {
  const found = [...APP_BAR_SOURCE.matchAll(/aria-\[current=page\]:border-b-([a-z][\w-]*)/g)].map(([, colour]) => colour);
  if (found.length !== 1) throw new Error(`app-bar.tsx should mark the place shown with one aria-[current=page]:border-b-<colour>; found ${JSON.stringify(found)}`);
  return found[0];
}

const ACTIVE_PLACE_MARK = activePlaceMarkColour();

describe('My Work colour tokens meet rule 7 and G12', () => {
  for (const theme of Object.keys(THEMES) as ThemeName[]) {
    describe(`${theme} theme`, () => {
      it('text on orange is ≥4.5:1 on both ends of the button gradient and its hover (G1, D b4 M92)', () => {
        for (const orange of ['primary', 'primary-bright', 'primary-deep']) {
          expectAtLeast(theme, 'primary-foreground', [`--${orange}`, tokenRgb(theme, orange)], 4.5, 'primary button text');
        }
      });

      it('the control edge is ≥3:1 on every surface and field fill it sits on (G12)', () => {
        for (const surface of controlSurfaces(theme)) expectAtLeast(theme, 'control-edge', surface, 3, 'control edge');
      });

      it('the focus ring is ≥3:1 on every surface a focused control sits on (rule 7)', () => {
        for (const surface of controlSurfaces(theme)) expectAtLeast(theme, 'ring', surface, 3, 'focus ring edge');
      });

      it('muted text is ≥4.5:1 on every painted surface (rule 7)', () => {
        for (const surface of PAINTED_SURFACES) expectAtLeast(theme, 'muted-foreground', [`--${surface}`, tokenRgb(theme, surface)], 4.5, 'muted text');
      });

      it('body and on-surface text is ≥4.5:1 (rule 7)', () => {
        for (const surface of PAINTED_SURFACES) expectAtLeast(theme, 'foreground', [`--${surface}`, tokenRgb(theme, surface)], 4.5, 'body text');
        for (const [text, surface] of [
          ['card-foreground', 'card'], ['popover-foreground', 'popover'], ['secondary-foreground', 'secondary'], ['accent-foreground', 'accent'],
        ]) expectAtLeast(theme, text, [`--${surface}`, tokenRgb(theme, surface)], 4.5, 'text on its own surface');
        for (const surface of ['background', 'card', 'popover']) {
          expectAtLeast(theme, 'destructive', [`--${surface}`, tokenRgb(theme, surface)], 4.5, 'error text and destructive buttons');
        }
      });

      it('destructive words are ≥4.5:1 on their own tints, at the strengths Button and Badge use (rule 7)', () => {
        // Light: 10% at rest, 15% on hover and press. Dark: 15% at rest, 18% on hover and press.
        const tints = theme === 'light' ? [0.1, 0.15] : [0.15, 0.18];
        for (const surface of ['background', 'card', 'popover', 'muted', 'surface']) {
          for (const tint of tints) {
            const tinted = over(tokenRgb(theme, 'destructive'), tint, tokenRgb(theme, surface));
            expectAtLeast(theme, 'destructive', [`--destructive/${tint * 100} on --${surface}`, tinted], 4.5, 'destructive button and badge text');
          }
        }
      });

      it('link buttons are ≥4.5:1: accent-foreground in light, primary in dark (rule 7)', () => {
        const linkText = theme === 'light' ? 'accent-foreground' : 'primary';
        for (const surface of ['background', 'card', 'popover', 'muted']) {
          expectAtLeast(theme, linkText, [`--${surface}`, tokenRgb(theme, surface)], 4.5, 'link button text');
        }
      });

      it('the bar\'s place shown: its words ≥4.5:1 on its fill and on the bar, and its edge mark ≥3:1 against both (design pass Phase 3)', () => {
        expectAtLeast(theme, 'place-active-foreground', ['--place-active', tokenRgb(theme, 'place-active')], 4.5, 'active place words');
        expectAtLeast(theme, 'place-active-foreground', ['--card (the bar)', tokenRgb(theme, 'card')], 4.5, 'active place words on the bar');
        // The fill alone is 1.2:1 to 1.3:1 on the bar, and the words' green 1.04:1 to 1.19:1 against the other places'
        // grey: the edge along the place's foot is what tells it apart (WCAG 1.4.1 and 1.4.11).
        expectAtLeast(theme, ACTIVE_PLACE_MARK, ['--place-active (its fill)', tokenRgb(theme, 'place-active')], 3, 'active place edge');
        expectAtLeast(theme, ACTIVE_PLACE_MARK, ['--card (the bar)', tokenRgb(theme, 'card')], 3, 'active place edge');
      });

      it('each state word is ≥4.5:1 on its own badge surface (D b3 K61)', () => {
        for (const state of STATES) expectAtLeast(theme, `${state}-foreground`, [`--${state}`, tokenRgb(theme, state)], 4.5, 'state badge text');
      });

      it('progress fills are ≥3:1 against the muted track; the track edge is the control edge (D b14 K286, M291)', () => {
        for (const state of STATES) expectAtLeast(theme, `${state}-foreground`, ['--muted (track)', tokenRgb(theme, 'muted')], 3, 'progress fill');
        expectAtLeast(theme, 'control-edge', ['--card (behind the track)', tokenRgb(theme, 'card')], 3, 'progress track edge');
      });

      it('the state families come from STATE_SURFACE and each is defined in this theme', () => {
        expect(STATES.length).toBeGreaterThanOrEqual(5);
        for (const state of STATES) for (const token of [state, `${state}-foreground`]) tokenRgb(theme, token);
      });

      it('a highlighted row in a menu, select or command list is marked ≥3:1 against the list and its own fill (D b9 M192, rule 7)', () => {
        // The row fill is --input; its mark is a 1px --muted-foreground edge (dropdown-menu, select and command rows).
        expectAtLeast(theme, 'muted-foreground', ['--popover (the list)', tokenRgb(theme, 'popover')], 3, 'highlighted row edge');
        expectAtLeast(theme, 'muted-foreground', ['--input (the highlighted row)', tokenRgb(theme, 'input')], 3, 'highlighted row edge');
        expectAtLeast(theme, 'popover-foreground', ['--input (the highlighted row)', tokenRgb(theme, 'input')], 4.5, 'highlighted row text');
      });

      it('a switch that is on keeps a ≥3:1 edge on the surfaces it sits on (D b19, rule 7)', () => {
        for (const surface of ['background', 'card', 'popover', 'muted']) {
          expectAtLeast(theme, 'primary-deep', [`--${surface}`, tokenRgb(theme, surface)], 3, 'switch on edge');
        }
      });
    });
  }
});
