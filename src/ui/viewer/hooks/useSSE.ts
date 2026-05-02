import { useState, useEffect, useRef } from 'react';
import { Observation, Summary, UserPrompt, StreamEvent } from '../types';
import { API_ENDPOINTS } from '../constants/api';
import { TIMING } from '../constants/timing';

export function useSSE() {
  const [observations, setObservations] = useState<Observation[]>([]);
  const [summaries, setSummaries] = useState<Summary[]>([]);
  const [prompts, setPrompts] = useState<UserPrompt[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [queueDepth, setQueueDepth] = useState(0);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout>();

  const addProjectIfNew = (project: string) => {
    setProjects(prev => prev.includes(project) ? prev : [...prev, project]);
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
              projects: data.projects?.length || 0
            });
            setProjects(data.projects || []);
            break;

          case 'new_observation':
            if (data.observation) {
              console.log('[SSE] New observation:', data.observation.id);
              addProjectIfNew(data.observation.project);
              setObservations(prev => [data.observation!, ...prev]);
            }
            break;

          case 'new_summary':
            if (data.summary) {
              console.log('[SSE] New summary:', data.summary.id);
              addProjectIfNew(data.summary.project);
              setSummaries(prev => [data.summary!, ...prev]);
            }
            break;

          case 'new_prompt':
            if (data.prompt) {
              console.log('[SSE] New prompt:', data.prompt.id);
              addProjectIfNew(data.prompt.project);
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
    isProcessing,
    queueDepth,
    isConnected
  };
}
