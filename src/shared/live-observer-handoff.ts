/** One live transport attempt. This module is safe for native host bundles. */
export const LIVE_OBSERVER_HANDOFF_TIMEOUT_MS = 250;

export async function deliverLiveObserverHandoff(
  request: (timeoutMs: number) => Promise<Response>,
): Promise<void> {
  const response = await request(LIVE_OBSERVER_HANDOFF_TIMEOUT_MS);
  await response.body?.cancel();
  if (!response.ok) throw new Error(`Live observer handoff returned ${response.status}`);
}
