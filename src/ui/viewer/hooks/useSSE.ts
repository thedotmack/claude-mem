import { useState, useEffect, useRef } from 'react';
import type { Observation, Summary, UserPrompt, StreamEvent, ActiveSessionInfo } from '../types';
import { API_ENDPOINTS } from '../constants/api';
import { TIMING } from '../constants/timing';
import { logger } from '../utils/logger';
import { calculateBackoffDelay } from '../utils/backoff';

const MAX_RECONNECT_ATTEMPTS = 20;
/** Cap SSE arrays — paginated data covers historical items, SSE only needs recent events */
const MAX_SSE_ITEMS = 500;

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
  const reconnectAttemptRef = useRef(0);

  useEffect(() => {
    const connect = () => {
      eventSourceRef.current?.close();

      const eventSource = new EventSource(API_ENDPOINTS.STREAM);
      eventSourceRef.current = eventSource;

      eventSource.onopen = () => {
        setIsConnected(true);
        reconnectAttemptRef.current = 0;
        clearTimeout(reconnectTimeoutRef.current);
      };

      eventSource.onerror = () => {
        logger.error('SSE', 'Connection error');
        setIsConnected(false);
        eventSource.close();
        clearTimeout(reconnectTimeoutRef.current);

        // Reconnect with exponential backoff
        const attempt = reconnectAttemptRef.current;
        if (attempt >= MAX_RECONNECT_ATTEMPTS) {
          logger.error('SSE', `Giving up after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts`);
          return;
        }
        const delay = calculateBackoffDelay(
          attempt,
          TIMING.SSE_RECONNECT_DELAY_MS,
          TIMING.SSE_RECONNECT_MAX_DELAY_MS,
          TIMING.SSE_RECONNECT_BACKOFF_FACTOR,
          0.25,
        );
        reconnectAttemptRef.current = attempt + 1;

        reconnectTimeoutRef.current = setTimeout(() => {
          reconnectTimeoutRef.current = undefined;
          connect();
        }, delay);
      };

      eventSource.onmessage = (event: MessageEvent<string>) => {
        let data: StreamEvent;
        try {
          data = JSON.parse(event.data) as StreamEvent;
        } catch {
          logger.warn('SSE', 'Malformed event data, skipping');
          return;
        }

        switch (data.type) {
          case 'initial_load':
            // Load projects list and active session info - data will come via pagination
            setProjects(data.projects || []);
            if (data.activeSession) {
              setInitialActiveSession(data.activeSession);
            }
            break;

          case 'new_observation': {
            const obs = data.observation;
            if (obs) setObservations(prev => [obs, ...prev].slice(0, MAX_SSE_ITEMS));
            break;
          }

          case 'new_summary': {
            const sum = data.summary;
            if (sum) setSummaries(prev => [sum, ...prev].slice(0, MAX_SSE_ITEMS));
            break;
          }

          case 'new_prompt': {
            const prompt = data.prompt;
            if (prompt) setPrompts(prev => [prompt, ...prev].slice(0, MAX_SSE_ITEMS));
            break;
          }

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

    return () => {
      eventSourceRef.current?.close();
      clearTimeout(reconnectTimeoutRef.current);
    };
  }, []);

  return { observations, summaries, prompts, projects, setProjects, isProcessing, queueDepth, isConnected, initialActiveSession };
}
