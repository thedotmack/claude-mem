import { useState, useEffect, useRef, Dispatch, SetStateAction } from 'react';
import { Observation, Summary, UserPrompt, StreamEvent } from '../types';
import { API_ENDPOINTS } from '../constants/api';
import { TIMING } from '../constants/timing';

interface SSEData {
  observations: Observation[];
  summaries: Summary[];
  prompts: UserPrompt[];
  projects: string[];
  isProcessing: boolean;
  queueDepth: number;
  isConnected: boolean;
}

// Event handlers map for cleaner switch statement alternative
const EVENT_HANDLERS = {
  initial_load: (data: StreamEvent, setState: Dispatch<SetStateAction<SSEData>>) => {
    setState(prev => ({ ...prev, projects: data.projects || [] }));
  },
  
  new_observation: (data: StreamEvent, setState: Dispatch<SetStateAction<SSEData>>) => {
    if (data.observation) {
      setState(prev => ({ 
        ...prev, 
        observations: [data.observation!, ...prev.observations] 
      }));
    }
  },
  
  new_summary: (data: StreamEvent, setState: Dispatch<SetStateAction<SSEData>>) => {
    if (data.summary) {
      setState(prev => ({ 
        ...prev, 
        summaries: [data.summary!, ...prev.summaries] 
      }));
    }
  },
  
  new_prompt: (data: StreamEvent, setState: Dispatch<SetStateAction<SSEData>>) => {
    if (data.prompt) {
      setState(prev => ({ 
        ...prev, 
        prompts: [data.prompt!, ...prev.prompts] 
      }));
    }
  },
  
  processing_status: (data: StreamEvent, setState: Dispatch<SetStateAction<SSEData>>) => {
    if (typeof data.isProcessing === 'boolean') {
      setState(prev => ({
        ...prev,
        isProcessing: data.isProcessing!,
        queueDepth: data.queueDepth || 0
      }));
    }
  }
} as const;

export function useSSE(): SSEData {
  const [data, setData] = useState<SSEData>({
    observations: [],
    summaries: [],
    prompts: [],
    projects: [],
    isProcessing: false,
    queueDepth: 0,
    isConnected: false
  });

  const eventSourceRef = useRef<EventSource>();
  const reconnectTimeoutRef = useRef<NodeJS.Timeout>();

  useEffect(() => {
    let isMounted = true;

    const connect = () => {
      eventSourceRef.current?.close();
      
      const eventSource = new EventSource(API_ENDPOINTS.STREAM);
      eventSourceRef.current = eventSource;

      eventSource.onopen = () => {
        if (!isMounted) return;
        setData(prev => ({ ...prev, isConnected: true }));
        clearTimeout(reconnectTimeoutRef.current);
      };

      eventSource.onerror = () => {
        if (!isMounted) return;
        setData(prev => ({ ...prev, isConnected: false }));
        eventSource.close();
        
        reconnectTimeoutRef.current = setTimeout(connect, TIMING.SSE_RECONNECT_DELAY_MS);
      };

      eventSource.onmessage = (event) => {
        if (!isMounted) return;
        
        try {
          const streamEvent: StreamEvent = JSON.parse(event.data);
          const handler = EVENT_HANDLERS[streamEvent.type];
          handler?.(streamEvent, setData);
        } catch (error) {
          console.error('[SSE] Failed to parse message:', error);
        }
      };
    };

    connect();

    return () => {
      isMounted = false;
      eventSourceRef.current?.close();
      clearTimeout(reconnectTimeoutRef.current);
    };
  }, []);

  return data;
}