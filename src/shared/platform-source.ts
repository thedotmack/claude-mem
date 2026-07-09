export const DEFAULT_PLATFORM_SOURCE = 'claude';

function sanitizeRawSource(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '-');
}

export function normalizePlatformSource(value?: string | null): string {
  if (!value) return DEFAULT_PLATFORM_SOURCE;

  const source = sanitizeRawSource(value);
  if (!source) return DEFAULT_PLATFORM_SOURCE;

  if (source === 'transcript') return 'codex';
  if (source.includes('codex')) return 'codex';
  if (source.includes('cursor')) return 'cursor';
  if (source.includes('kimi')) return 'kimi';
  if (source.includes('claude')) return 'claude';
  if (source.includes('opencode')) return 'opencode';
  if (source.includes('gemini') && source.includes('cli')) return 'gemini-cli';

  return source;
}

export function normalizePlatformSourceOrNull(value?: string | null): string | null {
  if (typeof value !== 'string') return null;
  return normalizePlatformSource(value);
}

export function sortPlatformSources(sources: string[]): string[] {
  const priority = ['claude', 'opencode', 'gemini-cli', 'codex', 'cursor'];

  return [...sources].sort((a, b) => {
    const aPriority = priority.indexOf(a);
    const bPriority = priority.indexOf(b);

    if (aPriority !== -1 || bPriority !== -1) {
      if (aPriority === -1) return 1;
      if (bPriority === -1) return -1;
      return aPriority - bPriority;
    }

    return a.localeCompare(b);
  });
}
