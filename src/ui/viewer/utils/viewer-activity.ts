/** A visible local page renews an expiring lease; it never asks sync to bypass retry policy. */
export const VIEWER_ACTIVITY_RENEW_MS = 20_000;
export const VIEWER_ACTIVITY_TIMEOUT_MS = 10_000;
export const VIEWER_ACTIVITY_URL = '/api/work-view/activity';

interface VisibilityTarget {
  readonly visibilityState: string;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

interface PageTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface ViewerActivityOptions {
  enabled?: boolean;
  fetchImpl?: typeof fetch;
  document?: VisibilityTarget;
  page?: PageTarget;
  viewerId?: string;
  renewMs?: number;
  timeoutMs?: number;
}

/** Shared by the two local viewers. Absence of a browser makes this a no-op in tools/tests. */
export function startViewerActivity(options: ViewerActivityOptions = {}): () => void {
  const browser = globalThis as unknown as { document?: VisibilityTarget; window?: PageTarget };
  const visibility = options.document ?? browser.document;
  const page = options.page ?? browser.window;
  if (options.enabled === false || !visibility || !page) return () => {};
  const fetchImpl = options.fetchImpl ?? fetch;
  const viewerId = options.viewerId ?? crypto.randomUUID();
  const renewMs = options.renewMs ?? VIEWER_ACTIVITY_RENEW_MS;
  const timeoutMs = options.timeoutMs ?? VIEWER_ACTIVITY_TIMEOUT_MS;
  let sequence = 0;
  let stopped = false;
  let visible = false;
  let request: AbortController | null = null;
  const pending = new Set<AbortController>();

  const send = (nextVisible: boolean) => {
    // Superseded visibility changes carry a larger sequence, including when the old HTTP request reached the worker.
    request?.abort();
    const controller = new AbortController();
    request = controller;
    pending.add(controller);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const currentSequence = ++sequence;
    void fetchImpl(VIEWER_ACTIVITY_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewerId, visible: nextVisible, sequence: currentSequence }),
      signal: controller.signal, keepalive: !nextVisible,
    }).catch(() => {
      // The server lease expires if release/renewal cannot arrive; offline pages never hammer a forced pull.
    }).finally(() => {
      clearTimeout(timeout);
      pending.delete(controller);
      if (request === controller) request = null;
    });
  };

  const update = () => {
    if (stopped) return;
    const nextVisible = visibility.visibilityState === 'visible';
    if (nextVisible || visible) send(nextVisible);
    visible = nextVisible;
  };
  const hide = () => {
    if (stopped || !visible) return;
    visible = false;
    send(false);
  };
  const renew = setInterval(() => {
    if (!stopped && visible && visibility.visibilityState === 'visible' && !request) send(true);
  }, renewMs);
  visibility.addEventListener('visibilitychange', update);
  page.addEventListener('pageshow', update);
  page.addEventListener('pagehide', hide);
  update();

  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(renew);
    visibility.removeEventListener('visibilitychange', update);
    page.removeEventListener('pageshow', update);
    page.removeEventListener('pagehide', hide);
    for (const controller of pending) controller.abort();
    if (visible) { visible = false; send(false); }
  };
}
