import { useState, useEffect, useCallback } from 'react';
import { HealthData } from '../types';
import { API_ENDPOINTS } from '../constants/api';

export function useHealth() {
  const [health, setHealth] = useState<HealthData>({});

  const loadHealth = useCallback(async () => {
    try {
      const response = await fetch(API_ENDPOINTS.HEALTH);
      if (!response.ok) {
        console.error('Health check failed:', response.status);
        return;
      }
      const data = await response.json();
      setHealth(data);
    } catch (error) {
      console.error('Failed to load health:', error);
    }
  }, []);

  useEffect(() => {
    loadHealth();
    const interval = setInterval(loadHealth, 15_000);
    return () => clearInterval(interval);
  }, [loadHealth]);

  return { health, refreshHealth: loadHealth };
}
