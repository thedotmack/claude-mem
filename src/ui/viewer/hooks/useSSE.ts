import { useState, useEffect, useRef, useCallback } from 'react';
import { Observation, Summary, UserPrompt, StreamEvent, FeedItemType } from '../types';
import { API_ENDPOINTS } from '../constants/api';
import { TIMING } from '../constants/timing';
import { itemDeletedTarget } from '../utils/feed-deletion';
import { removeSessionRows, sessionDeletedTarget, sessionRefOf, type SessionRef } from '../utils/sessions';

/** A live row as the session catalog sees it. */
export interface LiveSessionItem {
  session: SessionRef;
  project: string;
  createdAtEpoch: number;
}

export interface StreamHandlers {
  /** Every `item_deleted` event (a row deleted in this tab or any other); the caller owns removal. */
  onItemDeleted: (itemType: FeedItemType, id: number) => void;
  /** Every `session_deleted` event; the caller owns removal. */
  onSessionDeleted: (session: SessionRef) => void;
  /** Every new live observation, summary or prompt, for the session catalog. */
  onLiveItem: (item: LiveSessionItem) => void;
}

export function useSSE(handlers: StreamHandlers) {
  const [observations, setObservations] = useState<Observation[]>([]);
  const [summaries, setSummaries] = useState<Summary[]>([]);
  const [prompts, setPrompts] = useState<UserPrompt[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [queueDepth, setQueueDepth] = useState(0);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | undefined>(undefined);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

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
    setProjects(prev => prev.includes(project) ? prev : [...prev, project]);
  };

  const reportLiveItem = (row: { content_session_id?: string | null; session_id?: string | null; platform_source?: string | null; project: string; created_at_epoch: number }) => {
    const session = sessionRefOf(row);
    if (session) handlersRef.current.onLiveItem({ session, project: row.project, createdAtEpoch: row.created_at_epoch });
  };

  useEffect(() => {
    let closed = false;
    let processingVersion = 0;
    let statusRequest: AbortController | null = null;

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
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }

      const eventSource = new EventSource(API_ENDPOINTS.STREAM);
      eventSourceRef.current = eventSource;

      eventSource.onopen = () => {
        console.log('[SSE] Connected');
        void refreshProcessingStatus();
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
        }
      };

      eventSource.onerror = (error) => {
        console.error('[SSE] Connection error:', error);
        eventSource.close();
        void refreshProcessingStatus();

        reconnectTimeoutRef.current = setTimeout(() => {
          reconnectTimeoutRef.current = undefined;
          console.log('[SSE] Attempting to reconnect...');
          connect();
        }, TIMING.SSE_RECONNECT_DELAY_MS);
      };

      eventSource.onmessage = (event) => {
        const data: StreamEvent = JSON.parse(event.data);

        switch (data.type) {
          case 'initial_load':
            console.log('[SSE] Initial load:', {
              projects: data.projects?.length || 0
            });
            setProjects(data.projects || []);
            break;

          case 'new_observation':
            if (data.observation) {
              console.log('[SSE] New observation:', data.observation.id);
              addProjectIfNew(data.observation.project);
              reportLiveItem(data.observation);
              setObservations(prev => [data.observation!, ...prev]);
            }
            break;

          case 'new_summary':
            if (data.summary) {
              console.log('[SSE] New summary:', data.summary.id);
              addProjectIfNew(data.summary.project);
              reportLiveItem(data.summary);
              setSummaries(prev => [data.summary!, ...prev]);
            }
            break;

          case 'new_prompt':
            if (data.prompt) {
              console.log('[SSE] New prompt:', data.prompt.id);
              addProjectIfNew(data.prompt.project);
              reportLiveItem(data.prompt);
              setPrompts(prev => [data.prompt!, ...prev]);
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
    window.addEventListener('focus', refreshProcessingStatus);
    document.addEventListener('visibilitychange', refreshProcessingStatus);

    return () => {
      closed = true;
      clearInterval(statusInterval);
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
    removeLiveItem,
    removeLiveSession
  };
}
