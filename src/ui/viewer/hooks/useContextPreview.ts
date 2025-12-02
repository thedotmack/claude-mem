import { useState, useEffect, useCallback } from 'react';
import type { Settings } from '../types';

interface UseContextPreviewResult {
  preview: string;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useContextPreview(settings: Settings, projectFilter: string): UseContextPreviewResult {
  const [preview, setPreview] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({
        project: projectFilter || ''
      });

      const response = await fetch(`/api/context/preview?${params}`);
      const text = await response.text();

      if (response.ok) {
        setPreview(text);
      } else {
        setError('Failed to load preview');
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsLoading(false);
    }
  }, [projectFilter]);

  // Debounced refresh when settings change
  useEffect(() => {
    const timeout = setTimeout(() => {
      refresh();
    }, 300);
    return () => clearTimeout(timeout);
  }, [settings, refresh]);

  return { preview, isLoading, error, refresh };
}
