// SPDX-License-Identifier: Apache-2.0
//
// A thread's messages, rebuilt from the AG-UI events stored for it, in the dialect CopilotKit's
// runtime reads back: an assistant's tool calls as {id, name, args}, not AG-UI's
// {id, type, function: {name, arguments}}. The rules follow @ag-ui/client's apply/default.ts, so a
// history read here matches what a browser rebuilds from the same events.

export type StoredToolCall = { id: string; name: string; args: string };

export type ThreadMessage = {
  id: string;
  role: string;
  content?: unknown;
  name?: string;
  activityType?: string;
  toolCalls?: StoredToolCall[];
  toolCallId?: string;
};

type AgUiEvent = Record<string, unknown> & { type?: unknown };

type JsonPatchOp = { op: string; path: string; from?: string; value?: unknown };

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** An incoming message in either dialect, as the stored dialect. */
export function toStoredMessage(raw: unknown): ThreadMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const message = raw as Record<string, unknown>;
  const id = asString(message.id);
  const role = asString(message.role);
  if (!id || !role) return null;
  const stored: ThreadMessage = { id, role };
  if (message.content !== undefined && message.content !== null) stored.content = message.content;
  if (typeof message.name === 'string') stored.name = message.name;
  if (role === 'activity' && typeof message.activityType === 'string') stored.activityType = message.activityType;
  if (role === 'tool' && typeof message.toolCallId === 'string') stored.toolCallId = message.toolCallId;
  if (Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
    stored.toolCalls = message.toolCalls.flatMap((call): StoredToolCall[] => {
      if (typeof call !== 'object' || call === null) return [];
      const record = call as Record<string, unknown>;
      const fn = record.function as Record<string, unknown> | undefined;
      const callId = asString(record.id);
      const name = asString(fn?.name) ?? asString(record.name);
      if (!callId || !name) return [];
      return [{ id: callId, name, args: asString(fn?.arguments) ?? asString(record.args) ?? '' }];
    });
  }
  return stored;
}

function decodePointer(path: string): string[] {
  if (path === '') return [];
  return path
    .slice(1)
    .split('/')
    .map((part) => {
      const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
      // A patch may only reach the document's own data, never an object's prototype.
      if (key === '__proto__') throw new Error(`patch path ${path} is not allowed`);
      return key;
    });
}

function walk(document: unknown, parts: readonly string[]): unknown {
  let node = document;
  for (const part of parts) {
    if (node === null || typeof node !== 'object' || !Object.hasOwn(node, part)) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

function getAt(document: unknown, path: string): unknown {
  return walk(document, decodePointer(path));
}

/** RFC 6902, enough of it for AG-UI state and activity deltas. Returns the new document. */
export function applyJsonPatch(document: unknown, patch: readonly JsonPatchOp[]): unknown {
  let root = structuredClone(document);
  for (const operation of patch) {
    const parts = decodePointer(operation.path);
    if (parts.length === 0) {
      if (operation.op === 'add' || operation.op === 'replace') root = structuredClone(operation.value);
      else if (operation.op === 'remove') root = undefined;
      else if (operation.op === 'copy' || operation.op === 'move') root = structuredClone(getAt(root, operation.from ?? ''));
      continue;
    }
    const key = parts[parts.length - 1];
    const parent = walk(root, parts.slice(0, -1));
    if (parent === null || typeof parent !== 'object') throw new Error(`patch path ${operation.path} has no parent`);
    const write = (value: unknown, insert: boolean) => {
      if (Array.isArray(parent)) {
        const index = key === '-' ? parent.length : Number(key);
        if (insert) parent.splice(index, 0, value);
        else parent[index] = value;
      } else {
        (parent as Record<string, unknown>)[key] = value;
      }
    };
    const remove = () => {
      if (Array.isArray(parent)) parent.splice(Number(key), 1);
      else delete (parent as Record<string, unknown>)[key];
    };
    switch (operation.op) {
      case 'add':
        write(structuredClone(operation.value), true);
        break;
      case 'replace':
        write(structuredClone(operation.value), false);
        break;
      case 'remove':
        remove();
        break;
      case 'copy':
        write(structuredClone(getAt(root, operation.from ?? '')), true);
        break;
      case 'move': {
        const value = structuredClone(getAt(root, operation.from ?? ''));
        root = applyJsonPatch(root, [{ op: 'remove', path: operation.from ?? '' }]);
        root = applyJsonPatch(root, [{ op: 'add', path: operation.path, value }]);
        break;
      }
      case 'test':
        break;
      default:
        throw new Error(`unknown patch op ${operation.op}`);
    }
  }
  return root;
}

/** The messages these events leave behind, oldest first. */
export function messagesFromEvents(events: readonly AgUiEvent[]): ThreadMessage[] {
  let messages: ThreadMessage[] = [];
  const byId = () => new Map(messages.map((m) => [m.id, m]));
  const ownerOf = (toolCallId: string) => messages.find((m) => m.toolCalls?.some((c) => c.id === toolCallId));

  const startText = (messageId: string, role: string, name?: string) => {
    const existing = messages.find((m) => m.id === messageId);
    if (existing) return existing.role === 'activity' ? null : existing;
    const created: ThreadMessage = { id: messageId, role, content: '' };
    if (name !== undefined) created.name = name;
    messages.push(created);
    return created;
  };
  const appendText = (messageId: string, delta: string) => {
    const target = messages.find((m) => m.id === messageId);
    if (!target || target.role === 'activity') return;
    target.content = `${typeof target.content === 'string' ? target.content : ''}${delta}`;
  };
  const startToolCall = (toolCallId: string, name: string, parentMessageId?: string) => {
    const owner = ownerOf(toolCallId);
    if (owner) {
      const call = owner.toolCalls!.find((c) => c.id === toolCallId)!;
      call.name = name;
      return;
    }
    let target: ThreadMessage | undefined;
    if (parentMessageId) {
      const existing = messages.find((m) => m.id === parentMessageId);
      if (existing?.role === 'assistant') target = existing;
      else {
        target = { id: existing ? toolCallId : parentMessageId, role: 'assistant' };
        messages.push(target);
      }
    } else {
      target = { id: toolCallId, role: 'assistant' };
      messages.push(target);
    }
    (target.toolCalls ??= []).push({ id: toolCallId, name, args: '' });
  };
  const appendArgs = (toolCallId: string, delta: string) => {
    const call = ownerOf(toolCallId)?.toolCalls?.find((c) => c.id === toolCallId);
    if (call) call.args += delta;
  };

  for (const event of events) {
    switch (event.type) {
      case 'RUN_STARTED': {
        const input = event.input as { messages?: unknown[] } | undefined;
        if (!Array.isArray(input?.messages)) break;
        const present = byId();
        for (const raw of input.messages) {
          const message = toStoredMessage(raw);
          if (message && !present.has(message.id)) {
            messages.push(message);
            present.set(message.id, message);
          }
        }
        break;
      }
      case 'TEXT_MESSAGE_START': {
        const messageId = asString(event.messageId);
        if (messageId) startText(messageId, asString(event.role) ?? 'assistant', asString(event.name));
        break;
      }
      case 'TEXT_MESSAGE_CONTENT': {
        const messageId = asString(event.messageId);
        if (messageId) appendText(messageId, asString(event.delta) ?? '');
        break;
      }
      case 'TEXT_MESSAGE_CHUNK': {
        const messageId = asString(event.messageId) ?? messages.at(-1)?.id;
        if (!messageId) break;
        startText(messageId, asString(event.role) ?? 'assistant', asString(event.name));
        appendText(messageId, asString(event.delta) ?? '');
        break;
      }
      case 'TOOL_CALL_START': {
        const toolCallId = asString(event.toolCallId);
        const name = asString(event.toolCallName);
        if (toolCallId && name) startToolCall(toolCallId, name, asString(event.parentMessageId));
        break;
      }
      case 'TOOL_CALL_ARGS': {
        const toolCallId = asString(event.toolCallId);
        if (toolCallId) appendArgs(toolCallId, asString(event.delta) ?? '');
        break;
      }
      case 'TOOL_CALL_CHUNK': {
        const toolCallId = asString(event.toolCallId);
        if (!toolCallId) break;
        if (!ownerOf(toolCallId)) startToolCall(toolCallId, asString(event.toolCallName) ?? '', asString(event.parentMessageId));
        appendArgs(toolCallId, asString(event.delta) ?? '');
        break;
      }
      case 'TOOL_CALL_RESULT': {
        const messageId = asString(event.messageId);
        const toolCallId = asString(event.toolCallId);
        if (!messageId || !toolCallId || messages.some((m) => m.id === messageId)) break;
        const result: ThreadMessage = {
          id: messageId,
          role: asString(event.role) ?? 'tool',
          content: event.content,
          toolCallId,
        };
        // Right after the call it answers, past any results already there, as AG-UI places it.
        const ownerIndex = messages.findIndex((m) => m.role === 'assistant' && m.toolCalls?.some((c) => c.id === toolCallId));
        if (ownerIndex === -1) messages.push(result);
        else {
          let at = ownerIndex + 1;
          while (at < messages.length && messages[at].role === 'tool') at++;
          messages.splice(at, 0, result);
        }
        break;
      }
      case 'MESSAGES_SNAPSHOT': {
        const snapshot = (Array.isArray(event.messages) ? event.messages : [])
          .map(toStoredMessage)
          .filter((m): m is ThreadMessage => m !== null);
        const snapshotHasActivity = snapshot.some((m) => m.role === 'activity');
        const next = messages
          .filter((m) => snapshot.some((s) => s.id === m.id) || (m.role === 'activity' && !snapshotHasActivity))
          .map((m) => snapshot.find((s) => s.id === m.id) ?? m);
        for (const message of snapshot) if (!next.some((m) => m.id === message.id)) next.push(message);
        messages = next;
        break;
      }
      case 'ACTIVITY_SNAPSHOT': {
        const messageId = asString(event.messageId);
        if (!messageId) break;
        const activity: ThreadMessage = {
          id: messageId,
          role: 'activity',
          activityType: asString(event.activityType) ?? '',
          content: structuredClone(event.content),
        };
        const index = messages.findIndex((m) => m.id === messageId);
        if (index === -1) messages.push(activity);
        else if (event.replace !== false) messages[index] = activity;
        break;
      }
      case 'ACTIVITY_DELTA': {
        const messageId = asString(event.messageId);
        const target = messages.find((m) => m.id === messageId && m.role === 'activity');
        if (!target) break;
        try {
          target.content = applyJsonPatch(target.content ?? {}, (event.patch as JsonPatchOp[]) ?? []);
          if (typeof event.activityType === 'string') target.activityType = event.activityType;
        } catch {
          // A patch that does not apply leaves the activity as it was, as AG-UI does.
        }
        break;
      }
    }
  }
  return messages;
}

/** The thread's agent state: the last snapshot with the deltas after it folded in. */
export function stateFromEvents(events: readonly AgUiEvent[]):
  | { kind: 'no-snapshot' }
  | { kind: 'snapshot'; state: unknown; skippedDeltas: number } {
  let state: unknown;
  let seen = false;
  let skippedDeltas = 0;
  for (const event of events) {
    if (event.type === 'STATE_SNAPSHOT') {
      state = structuredClone(event.snapshot);
      seen = true;
    } else if (event.type === 'STATE_DELTA' && seen) {
      try {
        state = applyJsonPatch(state, (event.delta as JsonPatchOp[]) ?? []);
      } catch {
        skippedDeltas += 1;
      }
    }
  }
  return seen ? { kind: 'snapshot', state, skippedDeltas } : { kind: 'no-snapshot' };
}
