import type { ParseResult } from './parser.js';

export type ObserverOutputClass =
  | 'valid'
  | 'skip'
  | 'idle'
  | 'auth'
  | 'quota'
  | 'transport'
  | 'overflow'
  | 'model_error'
  | 'xml_drift'
  | 'prose';

const PREVIEW_LENGTH = 200;

/**
 * Returns a short, single-line preview of raw output for local diagnostics.
 * Rejected output is preserved for recovery; telemetry never receives it.
 */
export function previewOutput(raw: unknown, maxLength: number = PREVIEW_LENGTH): string {
  if (typeof raw !== 'string') {
    return `(non-string output: ${typeof raw})`;
  }
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) {
    return collapsed;
  }
  return `${collapsed.slice(0, maxLength)}…(+${collapsed.length - maxLength} chars)`;
}

/**
 * Classify an observer/summarizer SDK output.
 *
 * Parseable XML wins before prose error detection so memory text that happens
 * to mention an error cannot be misclassified. Every rejected response maps
 * to a closed reason that is safe to log and use in abort state.
 */
function classifyAcceptedXml(raw: string): 'valid' | 'skip' | null {
  if (/^\s*<skip_(?:summary|observation)(?:\s+reason="[^"]*")?\s*\/>\s*$/.test(raw)) {
    return 'skip';
  }

  const observation = /<observation>([\s\S]*?)<\/observation>/.exec(raw)?.[1];
  if (observation && /<(?:title|narrative|fact|concept)>[\s\S]*?[^\s<][\s\S]*?<\//.test(observation)) {
    return 'valid';
  }

  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(raw)?.[1];
  if (summary && /<(?:request|investigated|learned|completed|next_steps)>[\s\S]*?[^\s<][\s\S]*?<\//.test(summary)) {
    return 'valid';
  }

  return null;
}

export function classifyObserverOutput(raw: unknown, parsed?: ParseResult): ObserverOutputClass {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return 'idle';
  }

  if (parsed?.valid) {
    return parsed.summary?.skipped ? 'skip' : 'valid';
  }
  if (parsed === undefined) {
    const acceptedXml = classifyAcceptedXml(raw);
    if (acceptedXml) {
      return acceptedXml;
    }
  }

  if (isAuthFailureObserverOutput(raw)) {
    return 'auth';
  }
  if (isQuotaLimitedObserverOutput(raw)) {
    return 'quota';
  }

  const text = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  if (
    /\b(context window|context length|maximum context|prompt is too long|input is too long|too many tokens)\b/.test(text) ||
    /\btoken limit\b.{0,30}\b(exceeded|reached)\b/.test(text)
  ) {
    return 'overflow';
  }
  if (
    /\b(connection (?:closed|reset|lost|terminated)|socket hang up|network error|fetch failed|timed? out|timeout|stream (?:closed|terminated|interrupted))\b/.test(text)
  ) {
    return 'transport';
  }
  if (
    /\b(issue with the selected model|model (?:is )?(?:unavailable|not found|unsupported)|invalid model|model error)\b/.test(text)
  ) {
    return 'model_error';
  }
  if (/<\/?(?:observation|summary|skip_(?:summary|observation))\b/i.test(raw)) {
    return 'xml_drift';
  }
  if (/^(?:no|nothing)\b.{0,40}\b(?:observations?|summar(?:y|ies)|durable)\b/i.test(text)) {
    return 'idle';
  }

  return 'prose';
}

/**
 * Detect provider quota prose returned as an assistant message instead of a
 * structured SDK/system error. Quota pauses preserve claimed work; ordinary
 * observer prose is confirmed and dropped.
 */
export function isQuotaLimitedObserverOutput(raw: unknown): boolean {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return false;
  }

  const text = raw.toLowerCase().replace(/\s+/g, ' ').trim();

  return (
    /\bclaude\b.*\busage\b.*\blimit\b.*\b(reached|exceeded|exhausted|reset|resets|try again)\b/.test(text) ||
    /\b(reached|exceeded|exhausted)\b.*\bclaude\b.*\busage\b.*\blimit\b/.test(text) ||
    /\bweekly\b.*\b(limit|quota)\b.*\b(reached|exceeded|exhausted|reset|resets|try again)\b/.test(text) ||
    /\b(reached|exceeded|exhausted)\b.*\bweekly\b.*\b(limit|quota)\b/.test(text) ||
    /\bsubscription\b.*\b(limit|quota)\b.*\b(reached|exceeded|exhausted|reset|resets|try again)\b/.test(text) ||
    /\b(rate limit|quota)\b.*\b(subscription|weekly|claude usage)\b.*\b(reached|exceeded|exhausted|reset|resets|try again)\b/.test(text)
  );
}

/**
 * Detect provider authentication-failure prose so claimed work can be retried
 * after the user restores provider authentication.
 */
export function isAuthFailureObserverOutput(raw: unknown): boolean {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return false;
  }

  if (classifyAcceptedXml(raw)) {
    return false;
  }

  const text = raw.toLowerCase().replace(/\s+/g, ' ').trim();

  return (
    /\bfailed to authenticate\b/.test(text) ||
    /\bauthentication (?:failed|failure|error)\b/.test(text) ||
    /\b(?:authentication|auth)\b.{0,20}\b(?:required|expired|invalid|again)\b.{0,20}\/login\b/.test(text) ||
    /\b(?:api|http)\s*(?:error\s*)?:?\s*(?:401|403)\b/.test(text) ||
    /\b(?:(?:401|403)\s+(?:unauthorized|forbidden)|status\s*[:=]?\s*(?:401|403)|request failed with\s+(?:401|403))\b/.test(text) ||
    /\/login\b.{0,40}\b(?:to\s+authenticate|again|to\s+continue|and\s+retry|reauthenticate|credentials|provider|claude)\b/.test(text)
  );
}
