import { useState, useEffect } from 'react';
import { API_ENDPOINTS } from '../constants/api';

export interface WorkerHealth {
  version: string;
  pid: number;
  /** Seconds since worker start, as of the fetch (a snapshot, not live). */
  uptime: number;
}

/**
 * Fetches the running worker's health from GET /api/health — the same source
 * `claude-mem status` reads (version, pid, uptime). Returns null until loaded
 * or on failure.
 */
export function useHealth(): WorkerHealth | null {
  const [health, setHealth] = useState<WorkerHealth | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch(API_ENDPOINTS.HEALTH)
      .then(response => {
        if (!response.ok) throw new Error(`Health API error: ${response.status}`);
        return response.json();
      })
      .then((data: Partial<WorkerHealth>) => {
        if (
          !cancelled &&
          typeof data.version === 'string' &&
          typeof data.pid === 'number' &&
          typeof data.uptime === 'number'
        ) {
          setHealth({
            version: data.version,
            pid: data.pid,
            uptime: data.uptime,
          });
        }
      })
      .catch(error => {
        console.error('Failed to fetch worker health:', error);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return health;
}
