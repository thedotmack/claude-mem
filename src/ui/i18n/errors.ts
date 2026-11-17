import { interpolate } from './locale';

type Translate = (source: string) => string;

const DELETE_FAILURES = new Set([
  'Not deleted: this memory was synced from another device (delete it there), or it is already gone.',
  'Not deleted: this session is still running, or holds memories synced from another device (delete those there).',
  'Not deleted: cloud sync is unavailable, so the delete could not be recorded for your other devices. Try again once sync reconnects.',
  'Not deleted: this session is already gone.',
  'Not deleted: the claude-mem worker could not be reached.',
  'Stopped waiting for the delete. If the worker finishes it anyway, this memory leaves the list.',
  'Stopped waiting for the delete. If the worker finishes it anyway, this session leaves the list.',
]);

/** Render application-owned English errors; never translate opaque error details. */
export function translateViewerError(message: string, t: Translate): string {
  if (DELETE_FAILURES.has(message) || message === 'Failed to load more data') return t(message);

  const http = /^Not deleted: the worker answered HTTP (\d+)\.$/.exec(message);
  if (http) return interpolate(t('Not deleted: the worker answered HTTP {status}.'), { status: http[1] });

  // A card's delete and a session's delete time out with the same sentence (feed-deletion.ts sendDelete), naming what leaves.
  const noAnswer = /^No answer from the worker in (\d+(?:\.\d+)?) seconds, so the viewer stopped waiting\. If the delete finishes anyway, this (memory|session) leaves the list\.$/.exec(message);
  if (noAnswer) {
    const template = noAnswer[2] === 'session'
      ? t('No answer from the worker in {seconds} seconds, so the viewer stopped waiting. If the delete finishes anyway, this session leaves the list.')
      : t('No answer from the worker in {seconds} seconds, so the viewer stopped waiting. If the delete finishes anyway, this memory leaves the list.');
    return interpolate(template, { seconds: noAnswer[1] });
  }

  const timedOut = /^Loading (observations|summaries|prompts) timed out\. Try again\.$/.exec(message);
  if (timedOut) return interpolate(t('Loading {type} timed out. Try again.'), { type: t(timedOut[1]) });

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

/**
 * A refused save's reason, as the Settings dialog folds it under Details: the viewer's own "✗ Error:" prefix (every
 * reason useSettings and describeSaveFailure write starts with it) in the reader's language, the worker's words after
 * it untouched. Anything else is shown as it came.
 */
export function translateSettingsStatus(message: string, t: Translate): string {
  const prefix = '\u2717 Error: ';
  return message.startsWith(prefix) ? interpolate(t('\u2717 Error: {error}'), { error: message.slice(prefix.length) }) : message;
}
