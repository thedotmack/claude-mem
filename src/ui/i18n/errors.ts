import { interpolate } from './locale';

type Translate = (source: string) => string;

const DELETE_FAILURES = new Set([
  'Not deleted: this memory was synced from another device (delete it there), or it is already gone.',
  'Not deleted: this session is still running, or holds memories synced from another device (delete those there).',
  'Not deleted: cloud sync is unavailable, so the delete could not be recorded for your other devices. Try again once sync reconnects.',
  'Not deleted: this session is already gone.',
  'Not deleted: the claude-mem worker could not be reached.',
]);

/** Render application-owned English errors; never translate opaque error details. */
export function translateViewerError(message: string, t: Translate): string {
  if (DELETE_FAILURES.has(message) || message === 'Failed to load more data') return t(message);

  const http = /^Not deleted: the worker answered HTTP (\d+)\.$/.exec(message);
  if (http) return interpolate(t('Not deleted: the worker answered HTTP {status}.'), { status: http[1] });

  const page = /^Failed to load (observations|summaries|prompts): ([\s\S]*)$/.exec(message);
  if (page) {
    return interpolate(t('Failed to load {type}: {reason}'), { type: t(page[1]), reason: page[2] });
  }

  const sessionsPrefix = 'Could not load sessions: ';
  if (message.startsWith(sessionsPrefix)) {
    return interpolate(t('Could not load sessions: {error}'), { error: message.slice(sessionsPrefix.length) });
  }
  return message;
}

/** Settings state stays in English, including unmodified server response details. */
export function translateSettingsStatus(message: string, t: Translate): string {
  for (const [prefix, template] of [
    ['Could not load settings: ', 'Could not load settings: {error}'],
    ['\u2717 Error: ', '\u2717 Error: {error}'],
  ]) {
    if (message.startsWith(prefix)) {
      return interpolate(t(template), { error: message.slice(prefix.length) });
    }
  }
  return message === 'Saving...' || message === '\u2713 Saved' ? t(message) : message;
}
