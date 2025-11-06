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
  const [processingSessions, setProcessingSessions] = useState<Set<string>>(new Set());
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

        // Reconnect after delay
        reconnectTimeoutRef.current = setTimeout(() => {
          reconnectTimeoutRef.current = undefined; // Clear before reconnecting
          console.log('[SSE] Attempting to reconnect...');
          connect();
        }, TIMING.SSE_RECONNECT_DELAY_MS);
      };

      eventSource.onmessage = (event) => {
        try {
          const data: StreamEvent = JSON.parse(event.data);

          switch (data.type) {
            case 'initial_load':
              console.log('[SSE] Initial load:', {
                observations: data.observations?.length || 0,
                summaries: data.summaries?.length || 0,
                prompts: data.prompts?.length || 0,
                projects: data.projects?.length || 0
              });
              setObservations(data.observations || []);
              setSummaries(data.summaries || []);
              setPrompts(data.prompts || []);
              setProjects(data.projects || []);
              break;

            case 'new_observation':
              if (data.observation) {
                console.log('[SSE] New observation:', data.observation.id);
                setObservations(prev => [data.observation, ...prev]);
              }
              break;

            case 'new_summary':
              if (data.summary) {
                const summary = data.summary;
                console.log('[SSE] New summary:', summary.id);
                setSummaries(prev => [summary, ...prev]);
                // Mark session as no longer processing (summary is the final step)
                setProcessingSessions(prev => {
                  const next = new Set(prev);
                  next.delete(summary.session_id);
                  return next;
                });
              }
              break;

            case 'new_prompt':
              if (data.prompt) {
                const prompt = data.prompt;
                console.log('[SSE] New prompt:', prompt.id);
                setPrompts(prev => [prompt, ...prev]);
                // Mark session as processing
                setProcessingSessions(prev => new Set(prev).add(prompt.claude_session_id));
              }
              break;

            case 'processing_status':
              if (data.processing) {
                const processing = data.processing;
                console.log('[SSE] Processing status:', processing);
                setProcessingSessions(prev => {
                  const next = new Set(prev);
                  if (processing.is_processing) {
                    next.add(processing.session_id);
                  } else {
                    next.delete(processing.session_id);
                  }
                  return next;
                });
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

  return { observations, summaries, prompts, projects, processingSessions, isConnected };
}
