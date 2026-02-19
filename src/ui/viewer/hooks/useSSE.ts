import { useState, useEffect, useRef } from 'react';
import type { Observation, Summary, UserPrompt, StreamEvent, ActiveSessionInfo } from '../types';
import { API_ENDPOINTS } from '../constants/api';
import { TIMING } from '../constants/timing';
import { logger } from '../utils/logger';

export function useSSE() {
  const [observations, setObservations] = useState<Observation[]>([]);
  const [summaries, setSummaries] = useState<Summary[]>([]);
  const [prompts, setPrompts] = useState<UserPrompt[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [queueDepth, setQueueDepth] = useState(0);
  const [initialActiveSession, setInitialActiveSession] = useState<ActiveSessionInfo | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout>();

  useEffect(() => {
    const connect = () => {
      // Clean up existing connection
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }

      const eventSource = new EventSource(API_ENDPOINTS.STREAM);
      eventSourceRef.current = eventSource;

      eventSource.onopen = () => {
        setIsConnected(true);
        // Clear any pending reconnect
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
        }
      };

      eventSource.onerror = (error) => {
        logger.error('SSE', 'Connection error');
        setIsConnected(false);
        eventSource.close();

        // Reconnect after delay
        reconnectTimeoutRef.current = setTimeout(() => {
          reconnectTimeoutRef.current = undefined; // Clear before reconnecting
          connect();
        }, TIMING.SSE_RECONNECT_DELAY_MS);
      };

      eventSource.onmessage = (event: MessageEvent<string>) => {
        const data: StreamEvent = JSON.parse(event.data) as StreamEvent;

        switch (data.type) {
          case 'initial_load':
            // Load projects list and active session info - data will come via pagination
            setProjects(data.projects || []);
            if (data.activeSession) {
              setInitialActiveSession(data.activeSession);
            }
            break;

          case 'new_observation':
            if (data.observation) {
              setObservations(prev => [data.observation, ...prev]);
            }
            break;

          case 'new_summary':
            if (data.summary) {
              setSummaries(prev => [data.summary, ...prev]);
            }
            break;

          case 'new_prompt':
            if (data.prompt) {
              setPrompts(prev => [data.prompt, ...prev]);
            }
            break;

          case 'processing_status':
            if (typeof data.isProcessing === 'boolean') {
              setIsProcessing(data.isProcessing);
              setQueueDepth(data.queueDepth || 0);
            }
            break;
        }
      };
    };

    connect();

    // Cleanup on unmount
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, []);

  return { observations, summaries, prompts, projects, isProcessing, queueDepth, isConnected, initialActiveSession };
}
