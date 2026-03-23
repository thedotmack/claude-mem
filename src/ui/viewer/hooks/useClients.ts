import { useState, useEffect, useCallback } from 'react';
import { ClientInfo } from '../types';
import { API_ENDPOINTS } from '../constants/api';

export function useClients(mode?: string) {
  const [clients, setClients] = useState<ClientInfo[]>([]);

  const loadClients = useCallback(async () => {
    // Only fetch when in server mode
    if (mode !== 'server') {
      setClients([]);
      return;
    }

    try {
      const response = await fetch(API_ENDPOINTS.CLIENTS);
      const data = await response.json();
      setClients(data.clients || []);
    } catch (error) {
      console.error('Failed to load clients:', error);
    }
  }, [mode]);

  useEffect(() => {
    loadClients();

    // Poll every 15 seconds when in server mode
    if (mode === 'server') {
      const interval = setInterval(loadClients, 15_000);
      return () => clearInterval(interval);
    }
  }, [loadClients, mode]);

  return { clients, refreshClients: loadClients };
}
