import path from 'path';

const activeRefreshes = new Map<string, { started: number; published: number; pending: number }>();

/**
 * Overlapping summaries can fetch snapshots that finish in reverse order.
 * Once a later refresh publishes, an earlier one must not replace its file.
 * Failed reads/writes do not supersede a usable earlier response. Keep only
 * counters while requests are in flight; this queues or retries no work.
 */
export async function publishContextRefresh(
  file: string,
  fetchContext: () => Promise<string>,
  publish: (context: string) => boolean,
): Promise<boolean> {
  const key = path.resolve(file);
  const state = activeRefreshes.get(key) ?? { started: 0, published: 0, pending: 0 };
  activeRefreshes.set(key, state);
  const sequence = ++state.started;
  state.pending++;
  try {
    const context = await fetchContext();
    if (!context.trim() || sequence < state.published) return false;
    if (!publish(context)) return false;
    state.published = sequence;
    return true;
  } finally {
    if (--state.pending === 0) activeRefreshes.delete(key);
  }
}
