import { useState, useEffect, useRef, useCallback } from 'react';
import { Observation, Summary, UserPrompt, StreamEvent, FeedItemType } from '../types';
import { API_ENDPOINTS } from '../constants/api';
import { TIMING } from '../constants/timing';
import { itemDeletedTarget } from '../utils/feed-deletion';
import { removeSessionRows, sessionDeletedTarget, sessionRefOf, type SessionRef } from '../utils/sessions';
import { isSyncStatus, presentSync, type SyncStatusForDisplay } from '../utils/sync-presentation';
import { startViewerActivity } from '../utils/viewer-activity';
import { retainLiveRow } from '../utils/live-cache';

export interface MemoryChange { kinds?: string[]; projects?: string[]; reconnect?: boolean }

/** A live row as the session catalog sees it. */
export interface LiveSessionItem {
  session: SessionRef;
  project: string;
  createdAtEpoch: number;
}

/**
 * Decode one SSE frame, or null when it is not a usable event.
 *
 * Every producer on this stream writes `data: ${JSON.stringify(...)}`, so a
 * non-JSON frame is not something the worker sends today. It becomes possible
 * with a future producer or a rewriting proxy. React error boundaries do not
 * catch errors in `onmessage`; a throw ends that call, but later frames still
 * reach the handler. Drop the bad frame without an uncaught error instead.
 */
export function parseStreamFrame(raw: string): StreamEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as StreamEvent;
}

export interface StreamHandlers {
  /** Every `item_deleted` event (a row deleted in this tab or any other); the caller owns removal. */
  onItemDeleted: (itemType: FeedItemType, id: number) => void;
  /** Every `session_deleted` event; the caller owns removal. */
  onSessionDeleted: (session: SessionRef) => void;
  /** Every new live observation, summary or prompt, for the session catalog. */
  onLiveItem: (item: LiveSessionItem) => void;
  /** Authoritative content must be reread; events carry no replay cursor. */
  onDataChanged?: (change: MemoryChange) => void;
}

export function useSSE(handlers: StreamHandlers) {
  const [observations, setObservations] = useState<Observation[]>([]);
  const [summaries, setSummaries] = useState<Summary[]>([]);
  const [prompts, setPrompts] = useState<UserPrompt[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [queueDepth, setQueueDepth] = useState(0);
  const [isConnected, setIsConnected] = useState(false);
  const [syncStatus, setSyncStatus] = useState(() => presentSync(null, null, performance.now()));
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | undefined>(undefined);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const nextLiveVersionRef = useRef(0);
  const liveVersionsRef = useRef(new WeakMap<object, number>());
  const mountedRef = useRef(true);
  const projectRequestRef = useRef<AbortController | null>(null);
  const projectAdditionsRef = useRef<Array<{ name: string; version: number }>>([]);
  const captureLiveVersion = useCallback(() => nextLiveVersionRef.current, []);
  const clearLiveThrough = useCallback((itemType: FeedItemType, version: number) => {
    const keep = (row: object) => (liveVersionsRef.current.get(row) ?? 0) > version;
    if (itemType === 'observation') setObservations(previous => previous.filter(keep));
    else if (itemType === 'summary') setSummaries(previous => previous.filter(keep));
    else setPrompts(previous => previous.filter(keep));
  }, []);
  const refreshProjects = useCallback(async () => {
    projectRequestRef.current?.abort();
    const controller = new AbortController();
    projectRequestRef.current = controller;
    const version = nextLiveVersionRef.current;
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch('/api/projects', { cache: 'no-store', signal: controller.signal });
      if (!response.ok) return;
      const data = await response.json();
      if (!mountedRef.current || controller.signal.aborted || projectRequestRef.current !== controller || !Array.isArray(data.projects)) return;
      const additions = projectAdditionsRef.current.filter(item => item.version > version).map(item => item.name);
      setProjects([...new Set<string>([...data.projects.filter((item: unknown) => typeof item === 'string'), ...additions])]);
    } catch { /* The current project list remains usable through a failed refresh. */ }
    finally { clearTimeout(timeout); if (projectRequestRef.current === controller) projectRequestRef.current = null; }
  }, []);

  const removeLiveItem = useCallback((itemType: FeedItemType, id: number) => {
    if (itemType === 'observation') {
      setObservations(prev => prev.filter(o => o.id !== id));
    } else if (itemType === 'summary') {
      setSummaries(prev => prev.filter(s => s.id !== id));
    } else {
      setPrompts(prev => prev.filter(p => p.id !== id));
    }
  }, []);

  const removeLiveSession = useCallback((session: SessionRef) => {
    setObservations(prev => removeSessionRows(prev, session).rows);
    setSummaries(prev => removeSessionRows(prev, session).rows);
    setPrompts(prev => removeSessionRows(prev, session).rows);
  }, []);

  const addProjectIfNew = (project: string) => {
    projectAdditionsRef.current = [...projectAdditionsRef.current, { name: project, version: nextLiveVersionRef.current + 1 }].slice(-200);
    setProjects(prev => prev.includes(project) ? prev : [...prev, project]);
  };

  const reportLiveItem = (row: { content_session_id?: string | null; session_id?: string | null; platform_source?: string | null; project: string; created_at_epoch: number }) => {
    const session = sessionRefOf(row);
    if (session) handlersRef.current.onLiveItem({ session, project: row.project, createdAtEpoch: row.created_at_epoch });
  };

  useEffect(() => {
    mountedRef.current = true;
    let closed = false;
    let processingVersion = 0;
    let statusRequest: AbortController | null = null;
    const syncEvidence: { value: SyncStatusForDisplay | null; receivedAt: number | null } = { value: null, receivedAt: null };
    const refreshSync = () => {
      const next = presentSync(syncEvidence.value, syncEvidence.receivedAt, performance.now());
      setSyncStatus(previous => previous.state === next.state && previous.label === next.label && previous.detail === next.detail ? previous : next);
    };
    const acceptSync = (value: unknown) => {
      if (!isSyncStatus(value) || (syncEvidence.value && JSON.stringify(value) === JSON.stringify(syncEvidence.value))) return;
      syncEvidence.value = value;
      syncEvidence.receivedAt = performance.now();
      refreshSync();
    };
    const host = window.location.hostname;
    const stopActivity = startViewerActivity({ enabled: host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1' });

    // A quiet or disconnected stream can leave an old queue count on screen.
    // Reconcile with the worker, but never overwrite a newer stream event.
    const refreshProcessingStatus = async () => {
      if (closed || document.visibilityState === 'hidden' || statusRequest) return;
      const controller = new AbortController();
      statusRequest = controller;
      const version = processingVersion;
      // 10 s bounds a hung request below the 15 s reconcile interval, so one
      // stuck fetch cannot hold the single in-flight slot past the next tick.
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch('/api/processing-status', { cache: 'no-store', signal: controller.signal });
        if (!response.ok) return;
        const status = await response.json();
        if (!closed && !controller.signal.aborted && version === processingVersion
          && typeof status.isProcessing === 'boolean' && Number.isSafeInteger(status.queueDepth) && status.queueDepth >= 0) {
          setIsProcessing(status.isProcessing);
          setQueueDepth(status.queueDepth);
        }
      } catch {
        // Keep the last known status through a temporary worker outage.
      } finally {
        clearTimeout(timeout);
        if (statusRequest === controller) statusRequest = null;
      }
    };

    const connect = () => {
      if (closed) return;
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }

      const eventSource = new EventSource(API_ENDPOINTS.STREAM);
      eventSourceRef.current = eventSource;

      eventSource.onopen = () => {
        if (closed || eventSourceRef.current !== eventSource) return;
        setIsConnected(true);
        console.log('[SSE] Connected');
        void refreshProcessingStatus();
        handlersRef.current.onDataChanged?.({ reconnect: true });
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
        }
      };

      eventSource.onerror = (error) => {
        if (closed || eventSourceRef.current !== eventSource) return;
        setIsConnected(false);
        console.error('[SSE] Connection error:', error);
        eventSource.close();
        eventSourceRef.current = null;
        void refreshProcessingStatus();

        if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = setTimeout(() => {
          reconnectTimeoutRef.current = undefined;
          console.log('[SSE] Attempting to reconnect...');
          connect();
        }, TIMING.SSE_RECONNECT_DELAY_MS);
      };

      eventSource.onmessage = (event) => {
        if (closed || eventSourceRef.current !== eventSource) return;
        const data = parseStreamFrame(event.data);
        if (!data) {
          console.warn('[SSE] Ignoring an unparseable frame');
          return;
        }

        switch (data.type) {
          case 'initial_load':
            console.log('[SSE] Initial load:', {
              projects: data.projects?.length || 0
            });
            projectRequestRef.current?.abort();
            projectRequestRef.current = null;
            setProjects(data.projects || []);
            acceptSync(data.sync);
            break;

          case 'sync_status':
            acceptSync(data.sync);
            break;

          case 'data_changed': {
            const strings = (value: unknown): string[] | undefined => Array.isArray(value) && value.every(item => typeof item === 'string') ? value : undefined;
            handlersRef.current.onDataChanged?.({ kinds: strings(data.kinds), projects: strings(data.projects) });
            break;
          }

          case 'new_observation':
            if (data.observation) {
              console.log('[SSE] New observation:', data.observation.id);
              addProjectIfNew(data.observation.project);
              reportLiveItem(data.observation);
              liveVersionsRef.current.set(data.observation, ++nextLiveVersionRef.current);
              setObservations(prev => retainLiveRow(prev, data.observation!));
            }
            break;

          case 'new_summary':
            if (data.summary) {
              console.log('[SSE] New summary:', data.summary.id);
              addProjectIfNew(data.summary.project);
              reportLiveItem(data.summary);
              liveVersionsRef.current.set(data.summary, ++nextLiveVersionRef.current);
              setSummaries(prev => retainLiveRow(prev, data.summary!));
            }
            break;

          case 'new_prompt':
            if (data.prompt) {
              console.log('[SSE] New prompt:', data.prompt.id);
              addProjectIfNew(data.prompt.project);
              reportLiveItem(data.prompt);
              liveVersionsRef.current.set(data.prompt, ++nextLiveVersionRef.current);
              setPrompts(prev => retainLiveRow(prev, data.prompt!));
            }
            break;

          case 'item_deleted': {
            const target = itemDeletedTarget(data);
            if (target) handlersRef.current.onItemDeleted(target.itemType, target.id);
            break;
          }

          case 'session_deleted': {
            const session = sessionDeletedTarget(data);
            if (session) handlersRef.current.onSessionDeleted(session);
            break;
          }

          case 'processing_status':
            if (typeof data.isProcessing === 'boolean') {
              processingVersion++;
              console.log('[SSE] Processing status:', data.isProcessing, 'Queue depth:', data.queueDepth);
              setIsProcessing(data.isProcessing);
              setQueueDepth(data.queueDepth || 0);
            }
            break;
        }
      };
    };

    connect();
    void refreshProcessingStatus();
    // 15 s matches the heartbeat cadence of the worker's other event stream
    // (WorkViewRoutes sends one every 15 s): one cheap status read per beat
    // while visible; hidden tabs skip it (see refreshProcessingStatus).
    const statusInterval = setInterval(refreshProcessingStatus, 15000);
    const syncClock = setInterval(refreshSync, 1000);
    window.addEventListener('focus', refreshProcessingStatus);
    document.addEventListener('visibilitychange', refreshProcessingStatus);

    return () => {
      closed = true;
      mountedRef.current = false;
      projectRequestRef.current?.abort();
      clearInterval(statusInterval);
      clearInterval(syncClock);
      stopActivity();
      statusRequest?.abort();
      window.removeEventListener('focus', refreshProcessingStatus);
      document.removeEventListener('visibilitychange', refreshProcessingStatus);
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, []);

  return {
    observations,
    summaries,
    prompts,
    projects,
    isProcessing,
    queueDepth,
    isConnected,
    syncStatus,
    captureLiveVersion,
    clearLiveThrough,
    refreshProjects,
    removeLiveItem,
    removeLiveSession
  };
}
