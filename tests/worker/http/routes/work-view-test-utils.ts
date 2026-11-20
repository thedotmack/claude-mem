import type { WorkViewRoutes } from '../../../../src/services/worker/http/routes/WorkViewRoutes.js';

/** Keep the first overview response pending after reviews/sidecars were read. */
export function holdEnrichedOverview(routes: WorkViewRoutes) {
  const target = routes as any;
  const snapshot = target.snapshot.bind(routes);
  let release!: () => void, captured!: (view: any) => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<any>(resolve => { captured = resolve; });
  let held = false;
  target.snapshot = async (...args: any[]) => {
    const view = await snapshot(...args);
    if (args[1] === 'overview' && !held) {
      held = true;
      captured(view);
      await gate;
    }
    return view;
  };
  return { ready, release };
}
