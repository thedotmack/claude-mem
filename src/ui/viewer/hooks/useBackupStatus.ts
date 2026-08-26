import { useState, useEffect } from 'react';
import { API_ENDPOINTS } from '../constants/api';

/**
 * GET /api/backup/status response (worker BackupRoutes). The route is
 * registered unconditionally: a disabled install answers `{configured: false}`
 * and every other field is absent, so all of them are optional here.
 */
export interface BackupStatusResponse {
  configured: boolean;
  lastSnapshotAt?: number | null;
  lastSnapshotBytes?: number | null;
  snapshotCount?: number;
  lastError?: string | null;
  nextRunAt?: number | null;
  cloudEnabled?: boolean;
  lastUploadAt?: number | null;
  lastUploadKey?: string | null;
  addonRequired?: boolean;
}

interface UseBackupStatusResult {
  status: BackupStatusResponse | null;
  isLoading: boolean;
  error: string | null;
}

/**
 * Fetch backup status once on mount (useSettings fetch shape). Mounted from
 * the Backups section's content, which only renders while the section is
 * open — so opening the section is what triggers the fetch.
 */
export function useBackupStatus(): UseBackupStatusResult {
  const [status, setStatus] = useState<BackupStatusResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch(API_ENDPOINTS.BACKUP_STATUS)
      .then(async res => {
        if (!res.ok) {
          throw new Error(`Failed to load backup status (${res.status})`);
        }
        return res.json() as Promise<BackupStatusResponse>;
      })
      .then(data => {
        if (cancelled) return;
        setStatus(data);
        setIsLoading(false);
      })
      .catch(err => {
        if (cancelled) return;
        console.error('Failed to load backup status:', err instanceof Error ? err.message : String(err));
        setError('Failed to load backup status');
        setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return { status, isLoading, error };
}
