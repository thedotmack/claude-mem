import { useCallback } from 'react';
import type { QueueMessage } from '../types';

const API_BASE = '';

interface UseQueueReturn {
  retryMessage: (id: number) => Promise<boolean>;
  abortMessage: (id: number) => Promise<boolean>;
  retryAllStuck: () => Promise<number>;
  forceRestartSession: (sessionId: number) => Promise<{ success: boolean; messagesReset: number }>;
  recoverSession: (sessionId: number) => Promise<{ success: boolean; pendingCount: number }>;
  fetchQueue: () => Promise<{ messages: QueueMessage[]; stuckCount: number }>;
}

export function useQueue(): UseQueueReturn {
  const retryMessage = useCallback(async (id: number): Promise<boolean> => {
    try {
      const response = await fetch(`${API_BASE}/api/queue/${id}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const result = await response.json();
      return result.success;
    } catch (error) {
      console.error('Failed to retry message:', error);
      return false;
    }
  }, []);

  const abortMessage = useCallback(async (id: number): Promise<boolean> => {
    try {
      const response = await fetch(`${API_BASE}/api/queue/${id}/abort`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const result = await response.json();
      return result.success;
    } catch (error) {
      console.error('Failed to abort message:', error);
      return false;
    }
  }, []);

  const retryAllStuck = useCallback(async (): Promise<number> => {
    try {
      const response = await fetch(`${API_BASE}/api/queue/retry-all-stuck`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const result = await response.json();
      return result.count;
    } catch (error) {
      console.error('Failed to retry all stuck:', error);
      return 0;
    }
  }, []);

  const forceRestartSession = useCallback(async (sessionId: number): Promise<{ success: boolean; messagesReset: number }> => {
    try {
      const response = await fetch(`${API_BASE}/api/queue/session/${sessionId}/restart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const result = await response.json();
      return { success: result.success, messagesReset: result.messagesReset };
    } catch (error) {
      console.error('Failed to force restart session:', error);
      return { success: false, messagesReset: 0 };
    }
  }, []);

  const recoverSession = useCallback(async (sessionId: number): Promise<{ success: boolean; pendingCount: number }> => {
    try {
      const response = await fetch(`${API_BASE}/api/queue/session/${sessionId}/recover`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const result = await response.json();
      return { success: result.success, pendingCount: result.pendingCount };
    } catch (error) {
      console.error('Failed to recover session:', error);
      return { success: false, pendingCount: 0 };
    }
  }, []);

  const fetchQueue = useCallback(async (): Promise<{ messages: QueueMessage[]; stuckCount: number }> => {
    try {
      const response = await fetch(`${API_BASE}/api/queue`);
      const result = await response.json();
      return { messages: result.messages, stuckCount: result.stuckCount };
    } catch (error) {
      console.error('Failed to fetch queue:', error);
      return { messages: [], stuckCount: 0 };
    }
  }, []);

  return { retryMessage, abortMessage, retryAllStuck, forceRestartSession, recoverSession, fetchQueue };
}
