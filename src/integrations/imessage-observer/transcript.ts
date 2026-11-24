/**
 * Writes a conversation window as a plain transcript the observer can read:
 * who said what, and when. People are named from the optional contacts file;
 * a phone number nobody named is shortened to its last four digits so a full
 * number never lands in memory by accident.
 */
import type { ChatInfo } from './types.js';
import type { WindowEntry } from './batcher.js';

export interface PeopleBook {
  /** Address (phone or email) → name, from the contacts file. */
  names: Record<string, string>;
  /** What to call the account the observer runs on. */
  meLabel: string;
}

/** Digits only, without a leading US/Canada 1, so "+1 (555) 123-4567" and "5551234567" match. */
function phoneKey(address: string): string | null {
  if (address.includes('@')) return null;
  const digits = address.replace(/\D/g, '');
  if (digits.length < 7) return null;
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

export function normalizeNames(names: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [address, name] of Object.entries(names)) {
    if (typeof name !== 'string' || !name.trim()) continue;
    const key = phoneKey(address) ?? address.trim().toLowerCase();
    normalized[key] = name.trim();
  }
  return normalized;
}

export function personLabel(address: string | undefined, book: PeopleBook): string {
  if (address === 'me') return book.meLabel;
  if (!address) return 'Someone';
  const key = phoneKey(address) ?? address.trim().toLowerCase();
  const named = book.names[key];
  if (named) return named;
  const digits = phoneKey(address);
  return digits ? `Phone ending ${digits.slice(-4)}` : address;
}

/** Local wall-clock time with its UTC offset, e.g. 2026-11-24 15:04 -08:00. */
export function formatStamp(at: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const offset = -at.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} `
    + `${pad(at.getHours())}:${pad(at.getMinutes())} ${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function timeOnly(at: Date): string {
  return formatStamp(at).slice(11, 16);
}

export function formatTranscript(entries: WindowEntry[], book: PeopleBook): string {
  const lines: string[] = [];
  let day = '';
  for (const entry of entries) {
    const stamp = formatStamp(entry.at);
    if (stamp.slice(0, 10) !== day) {
      day = stamp.slice(0, 10);
      lines.push(`--- ${day} ---`);
    }
    const who = personLabel(entry.speaker, book);
    if (entry.kind === 'message') {
      const parts = [entry.text.trim().replace(/\n/g, '\n    ')];
      if (entry.attachments.length > 0) parts.push(`[${entry.attachments.join('; ')}]`);
      lines.push(`[${timeOnly(entry.at)}] ${who}: ${parts.filter(Boolean).join(' ')}`);
    } else {
      const target = entry.target ? ` ${personLabel(entry.target, book)}` : '';
      lines.push(`[${timeOnly(entry.at)}] (${who} ${entry.text}${target})`);
    }
  }
  return lines.join('\n');
}

export function participantLabels(chat: ChatInfo, book: PeopleBook): string[] {
  return chat.participants.map(person => personLabel(person.address, book));
}

/**
 * The turn the observer is told it is watching. The worker's observer reads
 * this as the request, so it says plainly that this is a chat, not code.
 */
export function conversationPrompt(chat: ChatInfo, book: PeopleBook): string {
  const people = participantLabels(chat, book);
  const roster = people.length > 0 ? ` Members: ${people.join(', ')}.` : '';
  return `Observe the iMessage group chat "${chat.displayName}".${roster}`
    + ' This is a group conversation between people, not a coding session.'
    + ' Record what the group decided, planned, asked for, promised, scheduled and shared,'
    + ' saying who said what and when. Skip small talk that changes nothing.';
}
