import { useState, useEffect, useCallback } from 'react';
import { HealthData } from '../types';
import { API_ENDPOINTS } from '../constants/api';

export function useHealth() {
  const [health, setHealth] = useState<HealthData>({});

  const loadHealth = useCallback(async () => {
    try {
      const response = await fetch(API_ENDPOINTS.HEALTH);
      const data = await response.json();
      setHealth(data);
    } catch (error) {
      console.error('Failed to load health:', error);
    }
  }, []);

  useEffect(() => {
    loadHealth();
  }, [loadHealth]);

  return { health, refreshHealth: loadHealth };
}
