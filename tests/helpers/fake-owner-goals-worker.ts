/**
 * The three worker routes save_goals.py talks to, over real HTTP, backed by an in-memory work-state log and
 * the same functions the worker uses: reduceWorkState, buildOwnerGoals, buildFocusAreas and ownerGoalsAreaRows.
 * Run save_goals.py against it with `run()`; it is asynchronous so the server can answer while Python waits.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { reduceWorkState } from '../../src/services/work-view/data-source.mjs';
import { buildOwnerGoalHistory, buildOwnerGoals } from '../../src/services/work-view/agent-view.mjs';
import { buildFocusAreas, focusAreaRowFields, isMyFocusList, MY_FOCUS_LIST, ownerGoalsAreaRows, type FocusArea } from '../../src/services/work-view/my-focus.mjs';
import { resolvePythonCommand } from '../../src/services/work-view/python.js';

const SAVE_GOALS = join(import.meta.dir, '..', '..', 'plugin', 'skills', 'owner-goals', 'scripts', 'save_goals.py');
const python = await resolvePythonCommand();

export function fakeOwnerGoalsWorker(dataDir: string, { refuseOwnerGoalsWrites = false } = {}) {
  mkdirSync(dataDir, { recursive: true });
  const rows: Array<{ id: number; project: string; list_name: string; fields: string; created_at_epoch: number }> = [];
  const append = (listName: string, fields: Record<string, unknown>) =>
    rows.push({ id: rows.length + 1, project: 'home', list_name: listName, fields: JSON.stringify(fields), created_at_epoch: rows.length + 1 });
  const state = () => reduceWorkState(rows);
  const focusAreas = (): FocusArea[] => buildFocusAreas(state()).focusAreas;
  const server = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === 'GET' && path === '/api/work-view') {
        return Response.json({ goals: buildOwnerGoals(state()), goalHistory: buildOwnerGoalHistory(state()), focusAreas: focusAreas() });
      }
      const body = await request.json() as any;
      if (path === '/api/work-view/focus/owner-goals') {
        try {
          const planned = ownerGoalsAreaRows(body.areas, focusAreas());
          for (const fields of planned.rows) append(MY_FOCUS_LIST, fields);
          return Response.json({ focusAreaIds: planned.focusAreaIds });
        } catch (error) { return Response.json({ error: (error as Error).message }, { status: 400 }); }
      }
      if (path === '/api/work-state/entries') {
        // The real route refuses my-focus: only the worker's own routes write it.
        if (isMyFocusList(body.list)) return new Response('Not saved', { status: 403 });
        if (refuseOwnerGoalsWrites) return new Response('Not saved: the worker is shutting down.', { status: 503 });
        append(body.list, body.fields);
        return new Response(`Saved to "${body.list}" in home.`);
      }
      return new Response('not found', { status: 404 });
    },
  });
  return {
    rows, state, focusAreas,
    /** An owner decision, as POST /api/work-view/focus writes it. */
    ownerDecides(area: FocusArea, change: Partial<FocusArea>) { append(MY_FOCUS_LIST, focusAreaRowFields({ ...area, ...change, decidedBy: 'owner' })); },
    async run(args: string[]) {
      const child = Bun.spawn([python.command, ...python.args, SAVE_GOALS, ...args], {
        env: { ...process.env, PYTHONUTF8: '1', CLAUDE_MEM_DATA_DIR: dataDir, CLAUDE_MEM_WORKER_HOST: '127.0.0.1', CLAUDE_MEM_WORKER_PORT: String(server.port) },
        stdout: 'pipe', stderr: 'pipe',
      });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { stdout, stderr, exitCode };
    },
    stop() { server.stop(true); },
  };
}
