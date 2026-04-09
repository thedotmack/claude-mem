import { useState, useEffect, useRef, useCallback } from 'react';
import { Observation, Summary, UserPrompt, StreamEvent, ProjectCatalog } from '../types';
import { API_ENDPOINTS } from '../constants/api';
import { TIMING } from '../constants/timing';

export type ClientSSEEvent = StreamEvent & {
  type: 'client_connected' | 'client_heartbeat' | 'client_disconnected';
};

type ClientEventHandler = (event: ClientSSEEvent) => void;

export function useSSE() {
  const [observations, setObservations] = useState<Observation[]>([]);
  const [summaries, setSummaries] = useState<Summary[]>([]);
  const [prompts, setPrompts] = useState<UserPrompt[]>([]);
  const [catalog, setCatalog] = useState<ProjectCatalog>({
    projects: [],
    sources: [],
    projectsBySource: {}
  });
  const [isConnected, setIsConnected] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [queueDepth, setQueueDepth] = useState(0);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout>();
  const clientEventHandlerRef = useRef<ClientEventHandler | null>(null);

  /** Register a handler for client SSE events (connect/heartbeat/disconnect) */
  const onClientEvent = useCallback((handler: ClientEventHandler) => {
    clientEventHandlerRef.current = handler;
  }, []);

  const updateCatalogForItem = (project: string, platformSource: string) => {
    setCatalog(prev => {
      const nextProjects = prev.projects.includes(project)
        ? prev.projects
        : [...prev.projects, project];
      const nextSources = prev.sources.includes(platformSource)
        ? prev.sources
        : [...prev.sources, platformSource];
      const sourceProjects = prev.projectsBySource[platformSource] || [];

      return {
        projects: nextProjects,
        sources: nextSources,
        projectsBySource: {
          ...prev.projectsBySource,
          [platformSource]: sourceProjects.includes(project)
            ? sourceProjects
            : [...sourceProjects, project]
        }
      };
    });
  };

  useEffect(() => {
    const connect = () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }

      const eventSource = new EventSource(API_ENDPOINTS.STREAM);
      eventSourceRef.current = eventSource;

      eventSource.onopen = () => {
        // SSE connected
        setIsConnected(true);
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
        }
      };

      eventSource.onerror = (error) => {
        console.error('[SSE] Connection error:', error);
        setIsConnected(false);
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
              sources: data.sources?.length || 0
            });
            setCatalog({
              projects: data.projects || [],
              sources: data.sources || [],
              projectsBySource: data.projectsBySource || {}
            });
            break;

          case 'new_observation':
            if (data.observation) {
              console.log('[SSE] New observation:', data.observation.id);
              updateCatalogForItem(data.observation.project, data.observation.platform_source || 'claude');
              setObservations(prev => [data.observation!, ...prev]);
            }
            break;

          case 'new_summary':
            if (data.summary) {
              console.log('[SSE] New summary:', data.summary.id);
              updateCatalogForItem(data.summary.project, data.summary.platform_source || 'claude');
              setSummaries(prev => [data.summary!, ...prev]);
            }
            break;

          case 'new_prompt':
            if (data.prompt) {
              console.log('[SSE] New prompt:', data.prompt.id);
              updateCatalogForItem(data.prompt.project, data.prompt.platform_source || 'claude');
              setPrompts(prev => [data.prompt!, ...prev]);
            }
            break;

          case 'processing_status':
            if (typeof data.isProcessing === 'boolean') {
              // Processing status update
              setIsProcessing(data.isProcessing);
              setQueueDepth(data.queueDepth || 0);
            }
            break;

          case 'client_connected':
          case 'client_heartbeat':
          case 'client_disconnected':
            // Client SSE event
            if (clientEventHandlerRef.current) {
              clientEventHandlerRef.current(data as ClientSSEEvent);
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
    projects: catalog.projects,
    sources: catalog.sources,
    projectsBySource: catalog.projectsBySource,
    isProcessing,
    queueDepth,
    isConnected,
    onClientEvent
  };
}
