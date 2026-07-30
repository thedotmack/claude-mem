import { useState, useEffect, useRef } from 'react';
import { Observation, Summary, UserPrompt, SessionCatalogEntry, StreamEvent } from '../types';
import { API_ENDPOINTS } from '../constants/api';
import { TIMING } from '../constants/timing';

export function useSSE() {
  const [observations, setObservations] = useState<Observation[]>([]);
  const [summaries, setSummaries] = useState<Summary[]>([]);
  const [prompts, setPrompts] = useState<UserPrompt[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [sessions, setSessions] = useState<SessionCatalogEntry[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [queueDepth, setQueueDepth] = useState(0);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | undefined>(undefined);

  const addProjectIfNew = (project: string) => {
    setProjects(prev => prev.includes(project) ? prev : [...prev, project]);
  };

  const touchSession = (item: {
    content_session_id: string;
    project: string;
    platform_source: string;
    created_at_epoch: number;
  }) => {
    setSessions(prev => {
      const existingIndex = prev.findIndex(s => s.content_session_id === item.content_session_id);
      if (existingIndex === -1) {
        return [
          ...prev,
          {
            content_session_id: item.content_session_id,
            project: item.project,
            platform_source: item.platform_source,
            custom_title: null,
            started_at_epoch: item.created_at_epoch,
            item_count: 1
          }
        ];
      }
      const next = [...prev];
      next[existingIndex] = { ...next[existingIndex], item_count: next[existingIndex].item_count + 1 };
      return next;
    });
  };

  const removeSession = (contentSessionId: string) => {
    setSessions(prev => prev.filter(s => s.content_session_id !== contentSessionId));
  };

  useEffect(() => {
    const connect = () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }

      const eventSource = new EventSource(API_ENDPOINTS.STREAM);
      eventSourceRef.current = eventSource;

      eventSource.onopen = () => {
        console.log('[SSE] Connected');
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
        }
      };

      eventSource.onerror = (error) => {
        console.error('[SSE] Connection error:', error);
        eventSource.close();

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
              projects: data.projects?.length || 0,
              sessions: data.sessions?.length || 0
            });
            setProjects(data.projects || []);
            setSessions(data.sessions || []);
            break;

          case 'new_observation':
            if (data.observation) {
              console.log('[SSE] New observation:', data.observation.id);
              addProjectIfNew(data.observation.project);
              touchSession({
                content_session_id: data.observation.content_session_id,
                project: data.observation.project,
                platform_source: data.observation.platform_source || 'claude',
                created_at_epoch: data.observation.created_at_epoch
              });
              setObservations(prev => [data.observation!, ...prev]);
            }
            break;

          case 'new_summary':
            if (data.summary) {
              console.log('[SSE] New summary:', data.summary.id);
              addProjectIfNew(data.summary.project);
              touchSession({
                content_session_id: data.summary.session_id,
                project: data.summary.project,
                platform_source: data.summary.platform_source || 'claude',
                created_at_epoch: data.summary.created_at_epoch
              });
              setSummaries(prev => [data.summary!, ...prev]);
            }
            break;

          case 'new_prompt':
            if (data.prompt) {
              console.log('[SSE] New prompt:', data.prompt.id);
              addProjectIfNew(data.prompt.project);
              touchSession({
                content_session_id: data.prompt.content_session_id,
                project: data.prompt.project,
                platform_source: data.prompt.platform_source || 'claude',
                created_at_epoch: data.prompt.created_at_epoch
              });
              setPrompts(prev => [data.prompt!, ...prev]);
            }
            break;

          case 'processing_status':
            if (typeof data.isProcessing === 'boolean') {
              console.log('[SSE] Processing status:', data.isProcessing, 'Queue depth:', data.queueDepth);
              setIsProcessing(data.isProcessing);
              setQueueDepth(data.queueDepth || 0);
            }
            break;
        }
      };
    };

    connect();

    return () => {
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
    sessions,
    removeSession,
    isProcessing,
    queueDepth
  };
}
