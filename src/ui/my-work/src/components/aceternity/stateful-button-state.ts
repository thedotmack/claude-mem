/**
 * What a stateful button shows, as people see and hear it (c-save-button, c-aceternity-stateful-button). Its one writer
 * is StatefulButton's press handler (stateful-button.tsx):
 *
 *   rest ──press──▶ saving ──the action resolves anything but false──▶ saved
 *                        └──resolves false, or throws──▶ not-saved
 *   saved, not-saved ──press──▶ saving
 *
 * "Saved" holds until the next press: no timer turns it back (plan Phase 5: no timers for "Saved"). Keyboard focus is
 * the fifth look, the focus ring of the caller's button classes, not a state. SaveButton words each state. The one
 * definition: the type, the word and mark tables and the tests take the values from here. It is its own module so the
 * component file exports only components (fast refresh) and a test can read the values without drawing anything.
 */
export const STATEFUL_BUTTON_STATE = { rest: 'rest', saving: 'saving', saved: 'saved', notSaved: 'not-saved' } as const
export type StatefulButtonState = (typeof STATEFUL_BUTTON_STATE)[keyof typeof STATEFUL_BUTTON_STATE]
