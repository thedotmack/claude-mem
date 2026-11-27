import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { isProjectExcluded } from '../../utils/project-filter.js';
import { stripMemoryTags, stripSystemReminderBlocks } from '../../utils/tag-stripping.js';
import { readExportFiles } from './export-files.js';

import {
  activeBranch,
  messageTime,
  plainTextBlocks,
  record,
  string,
  type ChatNode,
  type RecordValue,
  type HistoricalChat,
  type HistoricalMessage,
} from './chat-shape.js';
import { nativeChats } from './native-sources.js';

export type { HistoricalChat, HistoricalMessage } from './chat-shape.js';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function chatNodes(chat: RecordValue, source: HistoricalChat['source']): ChatNode[] | null {
  if (source === 'chatgpt') {
    return activeBranch(
      Object.entries(record(chat.mapping)).map(([id, raw]) => {
        const node = record(raw);
        return { id, parent: string(node.parent), data: record(node.message) };
      }),
      string(chat.current_node),
    );
  }
  const messages = (chat.chat_messages as unknown[]).map((raw) => {
    const data = record(raw);
    const parent = string(data.parent_message_uuid);
    return {
      id: string(data.uuid),
      parent: /^00000000-0000-[04]000-[08]000-000000000000$/.test(parent) ? '' : parent,
      data,
    };
  });
  if (messages.some((node) => node.parent) || chat.current_leaf_message_uuid) {
    return activeBranch(messages, string(chat.current_leaf_message_uuid));
  }
  return messages;
}

function visibleMessage(node: ChatNode, source: HistoricalChat['source']): HistoricalMessage | null {
  const data = node.data;
  const role = source === 'claude' ? (data.sender === 'human' ? 'user' : data.sender) : record(data.author).role;
  if (role !== 'user' && role !== 'assistant') return null;
  let rawText: string;
  if (source === 'chatgpt') {
    if (
      data.channel === 'analysis' ||
      record(data.metadata).is_visually_hidden_from_conversation ||
      (data.recipient && data.recipient !== 'all')
    )
      return null;
    const content = record(data.content);
    if (!['text', 'multimodal_text'].includes(string(content.content_type)) || !Array.isArray(content.parts)) return null;
    rawText = content.parts.filter((part): part is string => typeof part === 'string').join('\n');
  } else {
    // Some Claude exports provide both structured blocks and a flat convenience string.
    // When blocks are present, only visible text has provenance; thinking and tool output stay out.
    rawText = Array.isArray(data.content) && data.content.length ? plainTextBlocks(data.content) : string(data.text);
  }
  const text = stripMemoryTags(stripSystemReminderBlocks(rawText));
  const id = string(source === 'claude' ? data.uuid : data.id) || node.id;
  const timestampMs = messageTime(source === 'claude' ? data.created_at : data.create_time);
  return text && id && Number.isSafeInteger(timestampMs) ? { id, role, text, timestampMs } : null;
}

function projectFor(raw: RecordValue, source: HistoricalChat['source'], catalog: Map<string, string>, fallback: string) {
  const project = record(raw.project);
  let id = string(raw.project_uuid) || string(raw.project_id) || string(project.uuid) || string(project.id);
  // A general gizmo ID can name a custom GPT. Only the project-specific template ID is evidence of a project.
  const template = string(raw.conversation_template_id);
  if (!id && source === 'chatgpt' && template.startsWith('g-p-')) id = template;
  if (id) return { projectId: id, project: catalog.get(id) || string(project.name) || id, projectOrigin: 'export' as const };
  return {
    project: fallback || `Unassigned ${source} chats`,
    projectOrigin: fallback ? ('user' as const) : ('unassigned' as const),
  };
}

/** Read exactly the chosen export. The result contains dated, visible conversational turns in chronological order. */
export async function readChatExports(
  path: string,
  { now = Date.now(), project = '' }: { now?: number; project?: string } = {},
): Promise<{ chats: HistoricalChat[]; skipped: number }> {
  const excluded =
    process.env.CLAUDE_MEM_EXCLUDED_PROJECTS ??
    SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH, true, { readOnly: true }).CLAUDE_MEM_EXCLUDED_PROJECTS;
  if (!Number.isSafeInteger(now)) throw new Error('Invalid end date for the chat import.');
  const since = now - THIRTY_DAYS_MS;
  const catalog = new Map<string, string>();
  const groups = new Map<string, { chat: HistoricalChat; messages: Map<string, HistoricalMessage> }>();
  let skipped = 0;
  let sawChat = false;
  let sawEmptyExport = false;
  for await (const { name, value } of readExportFiles(path)) {
    if (name === 'projects.json' || name.startsWith('projects/')) {
      const projects = Array.isArray(value) ? value : [value];
      for (const raw of projects.map(record)) {
        const id = string(raw.uuid) || string(raw.id);
        const title = string(raw.name);
        if (id && title) catalog.set(id, title);
      }
      continue;
    }
    if (/\.jsonl$/i.test(name)) {
      const native = nativeChats(value, project.trim(), excluded);
      sawChat ||= native.recognized;
      skipped += native.skipped;
      for (const chat of native.chats) {
        const key = JSON.stringify([chat.source, chat.id, chat.projectId]);
        const group = groups.get(key) || { chat, messages: new Map<string, HistoricalMessage>() };
        for (const msg of chat.messages) {
          if (msg.timestampMs < since || msg.timestampMs > now) {
            skipped++;
            continue;
          }
          addMessage(group.messages, msg);
        }
        groups.set(key, group);
      }
      continue;
    }
    const conversations = Array.isArray(value) ? value : [value];
    if (Array.isArray(value) && value.length === 0) sawEmptyExport = true;
    for (const raw of conversations.map(record)) {
      const source = Array.isArray(raw.chat_messages)
        ? 'claude'
        : Object.keys(record(raw.mapping)).length
          ? 'chatgpt'
          : null;
      if (!source) {
        skipped++;
        continue;
      }
      sawChat = true;
      const id = source === 'claude' ? string(raw.uuid) : string(raw.conversation_id) || string(raw.id);
      const nodes = chatNodes(raw, source);
      if (!id || !nodes) {
        skipped++;
        continue;
      }
      const context = projectFor(raw, source, catalog, project.trim());
      if (
        isProjectExcluded(context.project, excluded) ||
        (context.projectId && isProjectExcluded(context.projectId, excluded))
      ) {
        skipped++;
        continue;
      }
      const key = JSON.stringify([source, id]);
      const group = groups.get(key) || {
        chat: { source, id, ...context, messages: [] },
        messages: new Map<string, HistoricalMessage>(),
      };
      if (context.projectId !== group.chat.projectId)
        throw new Error('The export assigns the same conversation to different projects.');
      for (const node of nodes) {
        if (!Object.keys(node.data).length) continue; // Tree root with no message.
        const message = visibleMessage(node, source);
        if (!message || message.timestampMs < since || message.timestampMs > now) {
          skipped++;
          continue;
        }
        addMessage(group.messages, message);
      }
      groups.set(key, group);
    }
  }
  if (!sawChat && !sawEmptyExport)
    throw new Error(
      'No supported conversation records were found. Select a ChatGPT or Claude export, or a Claude Code or Codex session JSONL file.',
    );
  const chats: HistoricalChat[] = [];
  for (const { chat, messages } of groups.values()) {
    if (!messages.size) continue;
    chat.messages = [...messages.values()].sort((a, b) => a.timestampMs - b.timestampMs);
    chats.push(chat);
  }
  return { chats, skipped };
}

export function addMessage(messages: Map<string, HistoricalMessage>, message: HistoricalMessage): void {
  const existing = messages.get(message.id);
  if (
    existing &&
    (existing.timestampMs !== message.timestampMs || existing.text !== message.text || existing.role !== message.role)
  ) {
    throw new Error('The export has conflicting records with the same message ID.');
  }
  messages.set(message.id, message);
}
