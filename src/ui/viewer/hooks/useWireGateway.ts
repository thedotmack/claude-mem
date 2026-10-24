import { useCallback, useEffect, useRef, useState } from 'react';
import { API_ENDPOINTS } from '../constants/api';
import { TIMING } from '../constants/timing';
import {
  describeWireFailure,
  mergeTraceCalls,
  type WireCallBodies,
  type WireConsent,
  type WireRouteReport,
  type WireStatusReport,
  type WireTraceCall,
  type WireTraceSnapshot,
  type WireUsageSummary,
} from '../utils/wire';

/** One worker answer: its data, or that the gateway is down, or why it failed. */
export interface WireLoad<T> {
  data: T | null;
  /** The worker said 503 "wire gateway not running". */
  gatewayDown: boolean;
  error: string | null;
}

const EMPTY_LOAD = { data: null, gatewayDown: false, error: null };

async function loadJson<T>(url: string, signal?: AbortSignal): Promise<WireLoad<T>> {
  let response: Response;
  try {
    response = await fetch(url, { signal, cache: 'no-store' });
  } catch (error) {
    if (signal?.aborted) throw error;
    return { data: null, gatewayDown: false, error: 'the claude-mem worker could not be reached' };
  }
  if (response.status === 503) return { data: null, gatewayDown: true, error: null };
  if (!response.ok) return { data: null, gatewayDown: false, error: await describeWireFailure(response) };
  try {
    return { data: await response.json() as T, gatewayDown: false, error: null };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { data: null, gatewayDown: false, error: `the worker's answer is not JSON (${error instanceof Error ? error.message : String(error)})` };
  }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/** The live feed's address: the calls changed after `seq` of feed `feedId`, waiting for one (`wait=1`). */
export function wireTraceUrl(seq: number, feedId: string | null): string {
  return `${API_ENDPOINTS.WIRE_TRACE}?after=${seq}&wait=1${feedId ? `&feed=${encodeURIComponent(feedId)}` : ''}`;
}

/** Whether the page is shown; false while its tab is in the background or minimized. */
function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const onVisibilityChange = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);
  return visible;
}

/**
 * Everything the Wire page shows. Status, routes, consent and usage are read
 * again every TIMING.STATS_REFRESH_INTERVAL_MS (the viewer's own refresh
 * pace); the live call feed is a long-poll that the gateway answers as soon
 * as a call changes. Both pause while the page is hidden: a background tab
 * holding a long-poll beside the viewer's /stream would use up the browser's
 * connections to the worker (Chrome allows 6 per host), and reading usage for
 * a page nobody sees costs the worker for nothing. Every request is aborted
 * when the page is left. Nothing here is kept in the browser: consent is the
 * worker's to read and write.
 */
export function useWireGateway() {
  const [status, setStatus] = useState<WireLoad<WireStatusReport>>({ ...EMPTY_LOAD });
  const [routes, setRoutes] = useState<WireLoad<{ routes: WireRouteReport[] }>>({ ...EMPTY_LOAD });
  const [usage, setUsage] = useState<WireLoad<WireUsageSummary>>({ ...EMPTY_LOAD });
  const [consent, setConsent] = useState<WireLoad<WireConsent>>({ ...EMPTY_LOAD });
  const [consentBusy, setConsentBusy] = useState(false);
  const [consentMessage, setConsentMessage] = useState<string | null>(null);
  const [calls, setCalls] = useState<WireTraceCall[]>([]);
  const [trace, setTrace] = useState<{ gatewayDown: boolean; error: string | null; connected: boolean }>({ gatewayDown: false, error: null, connected: false });
  /** Aborted when the page is left: every request still going stops, and nothing is set after. */
  const lifetimeRef = useRef<AbortController>(new AbortController());
  /** The live feed's cursor, kept across a pause so the feed goes on where it stopped. */
  const cursorRef = useRef<{ seq: number; feedId: string | null }>({ seq: 0, feedId: null });
  const visible = usePageVisible();

  useEffect(() => {
    if (lifetimeRef.current.signal.aborted) lifetimeRef.current = new AbortController();
    const lifetime = lifetimeRef.current;
    return () => lifetime.abort();
  }, []);

  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, lifetimeRef.current.signal]);
    const refresh = async () => {
      let answers: [WireLoad<WireStatusReport>, WireLoad<{ routes: WireRouteReport[] }>, WireLoad<WireUsageSummary>, WireLoad<WireConsent>];
      try {
        answers = await Promise.all([
          loadJson<WireStatusReport>(API_ENDPOINTS.WIRE_STATUS, signal),
          loadJson<{ routes: WireRouteReport[] }>(API_ENDPOINTS.WIRE_ROUTES, signal),
          loadJson<WireUsageSummary>(API_ENDPOINTS.WIRE_USAGE, signal),
          loadJson<WireConsent>(API_ENDPOINTS.WIRE_CONSENT, signal),
        ]);
      } catch (error) {
        // Only an abort throws here (loadJson turns every other failure into an answer): the page was hidden or left.
        if (signal.aborted) return;
        throw error;
      }
      if (signal.aborted) return;
      const [nextStatus, nextRoutes, nextUsage, nextConsent] = answers;
      setStatus(nextStatus);
      setRoutes(nextRoutes);
      setUsage(nextUsage);
      setConsent(nextConsent);
    };
    void refresh();
    const timer = setInterval(() => void refresh(), TIMING.STATS_REFRESH_INTERVAL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [visible]);

  // The live feed: ask for what changed after the last seq of the same feed,
  // waiting up to the gateway's 25 s for a change. While the gateway is down,
  // or after a failure, try again at the viewer's reconnect pace
  // (TIMING.SSE_RECONNECT_DELAY_MS).
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, lifetimeRef.current.signal]);
    (async () => {
      while (!signal.aborted) {
        let answer: WireLoad<WireTraceSnapshot>;
        try {
          answer = await loadJson<WireTraceSnapshot>(wireTraceUrl(cursorRef.current.seq, cursorRef.current.feedId), signal);
        } catch (error) {
          // An abort means the page was hidden or left; anything else (an answer that is not JSON) is shown and retried.
          if (signal.aborted) return;
          answer = { data: null, gatewayDown: false, error: error instanceof Error ? error.message : String(error) };
        }
        if (signal.aborted) return;
        if (answer.data) {
          const snapshot = answer.data;
          const previousFeedId = cursorRef.current.feedId;
          cursorRef.current = { seq: snapshot.seq, feedId: snapshot.feedId };
          setCalls(current => mergeTraceCalls(current, previousFeedId, snapshot));
          setTrace({ gatewayDown: false, error: null, connected: true });
          continue;
        }
        setTrace({ gatewayDown: answer.gatewayDown, error: answer.error, connected: false });
        await wait(TIMING.SSE_RECONNECT_DELAY_MS, signal);
      }
    })();
    return () => controller.abort();
  }, [visible]);

  const postConsent = useCallback(async (url: string, body: object, doneMessage: string) => {
    const lifetime = lifetimeRef.current.signal;
    setConsentBusy(true);
    setConsentMessage(null);
    try {
      // Not aborted when the page is left: a change already sent is the worker's to finish; only the page's state is skipped.
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (lifetime.aborted) return;
      if (!response.ok) {
        const failure = await describeWireFailure(response);
        if (!lifetime.aborted) setConsentMessage(`✗ ${failure}`);
        return;
      }
      const saved = await response.json() as WireConsent;
      if (lifetime.aborted) return;
      setConsent({ data: saved, gatewayDown: false, error: null });
      setConsentMessage(`✓ ${doneMessage}`);
    } catch (error) {
      if (!lifetime.aborted) setConsentMessage(`✗ the claude-mem worker could not be reached (${error instanceof Error ? error.message : String(error)})`);
    } finally {
      if (!lifetime.aborted) setConsentBusy(false);
    }
  }, []);

  const setRecording = useCallback(
    (recording: boolean) => postConsent(API_ENDPOINTS.WIRE_CONSENT, { recording }, recording ? 'Recording is on' : 'Recording is off'),
    [postConsent],
  );
  const clearRecordings = useCallback(
    () => postConsent(API_ENDPOINTS.WIRE_CONSENT_CLEAR, {}, 'Every recording was deleted'),
    [postConsent],
  );

  /** One call's bodies; rejects with a message the page shows, or with the abort when the page is left. */
  const loadCallBodies = useCallback(async (id: string): Promise<WireCallBodies> => {
    const answer = await loadJson<WireCallBodies>(`${API_ENDPOINTS.WIRE_CALL}?id=${encodeURIComponent(id)}`, lifetimeRef.current.signal);
    if (answer.data) return answer.data;
    throw new Error(answer.gatewayDown ? 'the wire gateway is not running' : answer.error ?? 'no bodies');
  }, []);

  return {
    status, routes, usage, consent, consentBusy, consentMessage, calls, trace,
    setRecording, clearRecordings, loadCallBodies,
  };
}
