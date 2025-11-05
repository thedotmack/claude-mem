import { useState, useEffect, useRef } from 'react';
import { Observation, Summary, StreamEvent } from '../types';

export function useSSE() {
  const [observations, setObservations] = useState<Observation[]>([]);
  const [summaries, setSummaries] = useState<Summary[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout>();

  useEffect(() => {
    const connect = () => {
      // Clean up existing connection
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }

      const eventSource = new EventSource('/stream');
      eventSourceRef.current = eventSource;

      eventSource.onopen = () => {
        console.log('[SSE] Connected');
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

        // Reconnect after 3 seconds
        reconnectTimeoutRef.current = setTimeout(() => {
          console.log('[SSE] Attempting to reconnect...');
          connect();
        }, 3000);
      };

      eventSource.onmessage = (event) => {
        try {
          const data: StreamEvent = JSON.parse(event.data);

          switch (data.type) {
            case 'initial_load':
              console.log('[SSE] Initial load:', {
                observations: data.observations?.length || 0,
                summaries: data.summaries?.length || 0
              });
              setObservations(data.observations || []);
              setSummaries(data.summaries || []);
              break;

            case 'new_observation':
              if (data.observation) {
                console.log('[SSE] New observation:', data.observation.id);
                setObservations(prev => [data.observation!, ...prev]);
              }
              break;

            case 'new_summary':
              if (data.summary) {
                console.log('[SSE] New summary:', data.summary.id);
                setSummaries(prev => [data.summary!, ...prev]);
              }
              break;
          }
        } catch (error) {
          console.error('[SSE] Failed to parse message:', error);
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

  return { observations, summaries, isConnected };
}
