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
    } catch (e) {
      console.error('Failed to fetch plans:', e);
    }
  }, []);

  const fetchAllMessages = useCallback(async () => {
    try {
      // Dynamically fetch agent names from controls instead of hardcoding
      let agents = ['claude-code', 'codex', 'claude-app']; // fallback
      try {
        const controlsRes = await fetch(API_ENDPOINTS.CONTROLS);
        if (controlsRes.ok) {
          const controlsData = await controlsRes.json();
          if (controlsData.agents) {
            agents = Object.keys(controlsData.agents);
          }
        }
      } catch (e) {
        console.error('Failed to fetch agent list:', e);
      }

      const allMsgs: AgentMessage[] = [];
      for (const agent of agents) {
        try {
          const res = await fetch(`${API_ENDPOINTS.MAILBOX}/${agent}`);
          if (res.ok) {
            const data = await res.json();
            allMsgs.push(...(data.messages || []));
          }
        } catch (e) {
          console.error(`Failed to fetch mailbox for ${agent}:`, e);
        }
      }
      allMsgs.sort((a, b) => b.created_at_epoch - a.created_at_epoch);
      setMessages(allMsgs);
    } catch (e) {
      console.error('Failed to fetch messages:', e);
    }
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
