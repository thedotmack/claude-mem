/**
 * The worker's focus-step write (WorkViewRoutes.recordRouterFocus) over a fixture database: the same row builder,
 * routerFocusRows, appending my-focus rows to work_state_entries. Plus a stub agent answer for the focus step.
 */
import type { Database } from 'bun:sqlite';
import { MY_FOCUS_LIST, readFocusAreas, routerFocusRows, type RouterFocusBody } from '../../src/services/work-view/my-focus.mjs';

export function focusWriter(database: Database, { firstEpoch = 1000 } = {}) {
  let at = firstEpoch;
  const insert = database.prepare('INSERT INTO work_state_entries (project, list_name, fields, created_at_epoch) VALUES (?, ?, ?, ?)');
  const bodies: RouterFocusBody[] = [];
  const save = (body: RouterFocusBody) => {
    bodies.push(body);
    const planned = routerFocusRows(body, readFocusAreas(database, { localDeviceId: '' }));
    for (const fields of planned.rows) insert.run('home', MY_FOCUS_LIST, JSON.stringify(fields), at++);
    return { placed: planned.placed, focusAreaIds: planned.focusAreaIds };
  };
  return { save, bodies };
}

/** The focus-input inlined in a focus-step prompt. */
export const focusInputFrom = (prompt: string) => JSON.parse(/```json\n([\s\S]*?)\n```/.exec(prompt.slice(prompt.indexOf('Do only section 3')))![1]);

/** A focus-step answer placing every asked request in Other, proposing nothing (and, for the Other pass, nothing at all). */
export function everyRequestInOther(prompt: string): string {
  if (isOtherPass(prompt)) return JSON.stringify({ placements: [], proposals: [] });
  const input = focusInputFrom(prompt);
  return JSON.stringify({ placements: input.requests.map((request: { anchor: string }) => ({ anchor: request.anchor, focusAreaId: 'other', evidence: 'Fits no area yet.' })), proposals: [] });
}

/** The focus step's second question: propose areas from Other. */
export const isOtherPass = (prompt: string) => prompt.includes('Do only section 3, step 3');
