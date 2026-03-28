import { useState, useEffect, useRef, useCallback } from 'react';
import { Observation, Summary, UserPrompt, StreamEvent } from '../types';
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
  const [projects, setProjects] = useState<string[]>([]);
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

  useEffect(() => {
    const connect = () => {
      // Clean up existing connection
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }

      const eventSource = new EventSource(API_ENDPOINTS.STREAM);
      eventSourceRef.current = eventSource;

      eventSource.onopen = () => {
        // SSE connected
        setIsConnected(true);
        // Clear any pending reconnect
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
        }
      };

      eventSource.onerror = (error) => {
        console.error('[SSE] Connection error:', error);
        setIsConnected(false);
        eventSource.close();

        // Reconnect after delay
        reconnectTimeoutRef.current = setTimeout(() => {
          reconnectTimeoutRef.current = undefined; // Clear before reconnecting
          // SSE reconnecting
          connect();
        }, TIMING.SSE_RECONNECT_DELAY_MS);
      };

      eventSource.onmessage = (event) => {
        const data: StreamEvent = JSON.parse(event.data);

        switch (data.type) {
          case 'initial_load':
            // Initial load
            // Only load projects list - data will come via pagination
            setProjects(data.projects || []);
            break;

          case 'new_observation':
            if (data.observation) {
              // New observation received
              setObservations(prev => [data.observation, ...prev]);
            }
            break;

          case 'new_summary':
            if (data.summary) {
              const summary = data.summary;
              // New summary received
              setSummaries(prev => [summary, ...prev]);
            }
            break;

          case 'new_prompt':
            if (data.prompt) {
              const prompt = data.prompt;
              // New prompt received
              setPrompts(prev => [prompt, ...prev]);
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

  return { observations, summaries, prompts, projects, isProcessing, queueDepth, isConnected, onClientEvent };
}
