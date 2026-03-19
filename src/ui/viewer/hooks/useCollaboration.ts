import { useState, useEffect, useCallback } from 'react';
import { API_ENDPOINTS } from '../constants/api';
import { CollabStatus, Plan, AgentMessage } from '../types';

export function useCollaboration(pollInterval = 5000) {
  const [status, setStatus] = useState<CollabStatus | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(API_ENDPOINTS.STATUS);
      if (res.ok) {
        const data = await res.json();
        setStatus(data);
        setError(null);
      }
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  const fetchPlans = useCallback(async () => {
    try {
      const res = await fetch(API_ENDPOINTS.PLANS);
      if (res.ok) {
        const data = await res.json();
        setPlans(data.plans || []);
      }
    } catch {}
  }, []);

  const fetchAllMessages = useCallback(async () => {
    try {
      const agents = ['claude-code', 'codex', 'claude-app'];
      const allMsgs: AgentMessage[] = [];
      for (const agent of agents) {
        const res = await fetch(`${API_ENDPOINTS.MAILBOX}/${agent}`);
        if (res.ok) {
          const data = await res.json();
          allMsgs.push(...(data.messages || []));
        }
      }
      allMsgs.sort((a, b) => b.created_at_epoch - a.created_at_epoch);
      setMessages(allMsgs);
    } catch {}
  }, []);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    await Promise.all([fetchStatus(), fetchPlans(), fetchAllMessages()]);
    setIsLoading(false);
  }, [fetchStatus, fetchPlans, fetchAllMessages]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, pollInterval);
    return () => clearInterval(interval);
  }, [refresh, pollInterval]);

  return { status, plans, messages, isLoading, error, refresh };
}
