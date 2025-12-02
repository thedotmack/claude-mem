import { useState, useEffect, useCallback } from 'react';

export interface GitHubStarsData {
  stargazers_count: number;
  watchers_count: number;
  forks_count: number;
}

export interface UseGitHubStarsReturn {
  stars: number | null;
  isLoading: boolean;
  error: Error | null;
}

export function useGitHubStars(username: string, repo: string): UseGitHubStarsReturn {
  const [stars, setStars] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchStars = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      const response = await fetch(`https://api.github.com/repos/${username}/${repo}`);

      if (!response.ok) {
        throw new Error(`GitHub API error: ${response.status}`);
      }

      const data: GitHubStarsData = await response.json();
      setStars(data.stargazers_count);
    } catch (error) {
      console.error('Failed to fetch GitHub stars:', error);
      setError(error instanceof Error ? error : new Error('Unknown error'));
    } finally {
      setIsLoading(false);
    }
  }, [username, repo]);

  useEffect(() => {
    fetchStars();
  }, [fetchStars]);

  return { stars, isLoading, error };
}
