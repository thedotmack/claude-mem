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
  if (source.includes('claude')) return 'claude';

  return source;
}

export function isOpenClawSessionSource(input: {
  contentSessionId?: string | null;
  project?: string | null;
  cwd?: string | null;
}): boolean {
  const contentSessionId = (input.contentSessionId ?? '').trim().toLowerCase();
  const project = (input.project ?? '').trim().toLowerCase();
  const cwd = (input.cwd ?? '').trim().toLowerCase();

  return contentSessionId.startsWith('openclaw-')
    || contentSessionId.includes('openclaw-agent:')
    || project === 'openclaw'
    || project.startsWith('openclaw-')
    || cwd.includes('/.openclaw/')
    || cwd.includes('\\.openclaw\\');
}

export function resolvePlatformSourceForSession(
  value: string | null | undefined,
  input: {
    contentSessionId?: string | null;
    project?: string | null;
    cwd?: string | null;
  }
): string {
  if (isOpenClawSessionSource(input)) {
    return 'openclaw';
  }

  return normalizePlatformSource(value);
}

export function sortPlatformSources(sources: string[]): string[] {
  const priority = ['claude', 'codex', 'cursor'];

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
