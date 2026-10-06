/**
 * First-party Pi extension. Builds on the native event and three-layer recall
 * design in husniadil/pi-mem (MIT, copyright 2026 Husni Adil Makmur).
 * The original license is retained in pi/THIRD-PARTY-LICENSE.txt.
 *
 * Unlike the external extension's fire-and-forget subprocesses, a session's
 * capture queue records its prompt before its tools and summary. Identity
 * comes from Pi's session manager: session_start carries a reason, not an ID.
 */
import { Type, type TSchema } from 'typebox';
import { createHarnessWorkerClient } from '../harness-worker.js';

interface PiMessage {
  role?: string;
  content?: unknown;
  timestamp?: number;
}
interface PiSessionEntry {
  type?: string;
  id?: string;
  message?: PiMessage;
}
interface PiContext {
  cwd: string;
  sessionManager: {
    getSessionId(): string;
    getBranch?(): ReadonlyArray<PiSessionEntry>;
  };
  hasUI?: boolean;
  ui?: { notify(message: string, level: 'warning' | 'info'): void };
}
interface PiEvent {
  prompt?: string;
  systemPrompt?: string;
  message?: PiMessage;
  messages?: PiMessage[];
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
  content?: unknown;
  isError?: boolean;
}
interface PiTool {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  execute(toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<{
    content: Array<{ type: 'text'; text: string }>;
    details: Record<string, never>;
  }>;
}
/** The stable public SDK surface used here; no host runtime is bundled. */
export interface PiExtensionAPI {
  on(event: string, handler: (event: PiEvent, context: PiContext) => unknown): void;
  registerTool(tool: PiTool): void;
}

interface Session {
  id: string;
  cwd: string;
  memory: string;
  anchored: boolean;
  excluded: boolean;
  queue: Promise<void>;
  lastAssistant: string;
  needsSummary: boolean;
  entryId?: string;
  initialized: boolean;
}

/** Original text-only extraction from husniadil/pi-mem; image payloads stay out. */
export function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((block): block is { type: 'text'; text: string } =>
    !!block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join('\n');
}

export default function claudeMemPi(pi: PiExtensionAPI): void {
  const worker = createHarnessWorkerClient();
  let current: Session | undefined;
  let notificationShown = false;
  const warn = (ctx: PiContext, error: unknown): void => {
    if (!notificationShown && ctx.hasUI && ctx.ui) {
      ctx.ui.notify('Claude-Mem is unavailable. Run npx claude-mem doctor. ' + String(error), 'warning');
      notificationShown = true;
    }
  };
  const enqueue = (session: Session, ctx: PiContext, task: () => Promise<void>): Promise<void> => {
    session.queue = session.queue.then(task).catch(error => warn(ctx, error));
    return session.queue;
  };
  const begin = async (_event: PiEvent, ctx: PiContext): Promise<void> => {
    const id = ctx.sessionManager.getSessionId();
    if (!id || !ctx.cwd) { current = undefined; return; }
    const session: Session = {
      id, cwd: ctx.cwd, memory: '', anchored: false, excluded: false,
      queue: Promise.resolve(), lastAssistant: '', needsSummary: false, initialized: false,
    };
    current = session;
    notificationShown = false;
    worker.reset();
    try {
      await worker.ready();
      const query = new URLSearchParams({ cwd: session.cwd, platform_source: 'pi' });
      session.memory = (await (await worker.request('/api/context/inject?' + query)).text()).trim();
    } catch (error) { warn(ctx, error); }
  };
  pi.on('session_start', begin);
  // Pi <=0.74 emitted these separately. Current Pi sends session_start for all three.
  pi.on('session_switch', begin);
  pi.on('session_fork', begin);

  const resetTurn = (_event: PiEvent, ctx: PiContext): Promise<void> | undefined => {
    const session = current;
    if (!session) return;
    return enqueue(session, ctx, async () => {
      session.entryId = undefined;
      session.initialized = false;
      session.anchored = false;
      session.excluded = true;
      session.needsSummary = false;
      session.lastAssistant = '';
    });
  };
  pi.on('before_agent_start', resetTurn);
  pi.on('session_tree', resetTurn);

  // Pi 1.0.2/1.0.4 await user persistence before this request-time hook.
  // sdk.ts transformContext -> ExtensionRunner.emitContext (full system phase):
  // https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/coding-agent/src/core/sdk.ts#L418
  // before_agent_start and user message_end are too early for a persisted ID.
  pi.on('context_with_system', async (event, ctx) => {
    const session = current;
    const messages = event.messages;
    if (!session) return;
    if (!Array.isArray(messages) || messages[0]?.role !== 'system' || typeof messages[0].content !== 'string') {
      await resetTurn(event, ctx);
      return;
    }
    const base = messages[0].content;
    const user = [...messages].reverse().find(message => message.role === 'user');
    const prompt = extractTextContent(user?.content);
    // Images never leave Pi; an image-only turn has no automatic text capture.
    const selectEntry = (): PiSessionEntry | undefined => {
      if (current !== session || ctx.sessionManager.getSessionId() !== session.id || ctx.cwd !== session.cwd
        || typeof ctx.sessionManager.getBranch !== 'function') return;
      const branch = ctx.sessionManager.getBranch();
      if (!Array.isArray(branch)) return;
      const entry = [...branch].reverse().find(item => item.type === 'message' && item.message?.role === 'user');
      // Timestamp/text only validate correspondence with the real request.
      // The identity always comes from the persisted active-branch entry.id.
      if (!entry || typeof entry.id !== 'string' || !/^[^\s\x00-\x1f\x7f]{1,256}$/.test(entry.id)
        || !user || typeof user.timestamp !== 'number' || !Number.isFinite(user.timestamp)
        || entry.message?.timestamp !== user.timestamp
        || extractTextContent(entry.message.content) !== prompt) return;
      return entry;
    };
    await enqueue(session, ctx, async () => {
      try {
        const entry = selectEntry();
        if (!entry || !prompt.trim()) {
          session.anchored = false;
          session.excluded = true;
          session.initialized = false;
          return;
        }
        if (session.entryId !== entry.id) {
          session.entryId = entry.id;
          session.initialized = false;
          session.anchored = false;
          session.excluded = true;
          session.needsSummary = false;
          session.lastAssistant = '';
        }
        if (session.initialized) return;
        // A legacy worker ignores unknown init fields. Probe without creating
        // a prompt/session so it cannot silently admit a text-based turn.
        const capability = await (await worker.request('/api/sessions/native-prompt-capability')).json() as {
          nativePromptId?: number;
        };
        if (capability.nativePromptId !== 1) throw new Error('Upgrade the worker for native Pi prompt capture.');
        if (selectEntry()?.id !== entry.id) return;
        const response = await worker.post('/api/sessions/init', {
          contentSessionId: session.id, cwd: session.cwd, prompt, platformSource: 'pi', nativePromptId: entry.id,
        });
        const result = await response.json() as {
          skipped?: boolean; reason?: string; sessionDbId?: number;
          nativePromptId?: string; nativePromptCurrent?: boolean;
        };
        if (selectEntry()?.id !== entry.id) return;
        if (result.skipped === true && result.reason !== 'duplicate') {
          // The same worker privacy/project gates run before exposing memory.
          session.initialized = true;
          session.excluded = true;
          return;
        }
        if (result.nativePromptId !== entry.id || typeof result.sessionDbId !== 'number') {
          throw new Error('The worker did not acknowledge the persisted Pi user-entry ID.');
        }
        session.initialized = true;
        // Older branch retries must not attach tools to a newer worker turn.
        session.anchored = result.nativePromptCurrent === true;
        session.excluded = !session.anchored;
        session.needsSummary = session.anchored;
      } catch (error) {
        session.anchored = false;
        session.excluded = true;
        session.initialized = false;
        throw error;
      }
    });
    if (current !== session || !session.anchored || session.excluded || !session.memory) return;
    const [head, ...tail] = messages;
    return { messages: [{ ...head, content: base + '\n\n<claude-mem-context>\n'
      + session.memory + '\n</claude-mem-context>' }, ...tail] };
  });

  pi.on('tool_result', (event, ctx) => {
    const session = current;
    if (!session || !event.toolName || event.toolName.startsWith('mem_')) return;
    const text = extractTextContent(event.content);
    return enqueue(session, ctx, async () => {
      if (!session.anchored || session.excluded) return;
      await worker.post('/api/sessions/observations', {
        contentSessionId: session.id, cwd: session.cwd, platformSource: 'pi',
        tool_name: event.toolName, tool_input: event.input,
        tool_response: text.slice(0, 100_000), tool_use_id: event.toolCallId,
      });
    });
  });
  pi.on('message_end', (event) => {
    if (current && event.message?.role === 'assistant') {
      current.lastAssistant = extractTextContent(event.message.content);
    }
  });
  const summarize = (_event: PiEvent, ctx: PiContext): Promise<void> | undefined => {
    const session = current;
    if (!session) return;
    return enqueue(session, ctx, async () => {
      if (!session.anchored || session.excluded || !session.needsSummary) return;
      await worker.post('/api/sessions/summarize', {
        contentSessionId: session.id, cwd: session.cwd, platformSource: 'pi',
        last_assistant_message: session.lastAssistant,
      });
      session.needsSummary = false;
    });
  };
  pi.on('agent_end', summarize);
  pi.on('session_before_compact', summarize);
  pi.on('session_shutdown', (_event, ctx) => summarize(_event, ctx));

  const tool = (name: string, label: string, description: string, parameters: TSchema,
    execute: (params: Record<string, unknown>, signal?: AbortSignal) => Promise<Response>): void => {
    pi.registerTool({
      name, label, description, parameters,
      async execute(_id, params, signal) {
        try {
          const response = await execute(params, signal);
          const raw = await response.text();
          let text = raw;
          try {
            const result = JSON.parse(raw) as { content?: Array<{ type: string; text?: string }> };
            if (Array.isArray(result.content)) text = extractTextContent(result.content);
          } catch { /* Context and formatted indices may be plain text. */ }
          return { content: [{ type: 'text', text }], details: {} };
        } catch (error) {
          return { content: [{ type: 'text', text: 'Memory request failed: ' + String(error) }], details: {} };
        }
      },
    });
  };
  const limit = Type.Optional(Type.Integer({ minimum: 1, maximum: 50 }));
  tool('mem_search', 'Memory search', 'Search memory for an index of IDs; use timeline, then fetch only useful observations.',
    Type.Object({ query: Type.String(), limit }), (params, signal) => {
      const query = new URLSearchParams({ query: String(params.query), limit: String(params.limit ?? 10) });
      return worker.request('/api/search?' + query, { signal });
    });
  tool('mem_timeline', 'Memory timeline', 'Inspect the neighborhood of an observation ID or search query. Supply anchor or query.',
    Type.Object({
      anchor: Type.Optional(Type.Union([Type.Integer(), Type.String()])),
      query: Type.Optional(Type.String()), depth_before: Type.Optional(Type.Integer({ minimum: 0, maximum: 50 })),
      depth_after: Type.Optional(Type.Integer({ minimum: 0, maximum: 50 })), project: Type.Optional(Type.String()),
    }), (params, signal) => {
      if ((params.anchor === undefined) === (params.query === undefined)) throw new Error('Supply exactly one of anchor or query.');
      const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined).map(([key, value]): [string, string] => [key, String(value)]));
      return worker.request('/api/timeline?' + query, { signal });
    });
  tool('mem_get_observations', 'Memory observations', 'Fetch full records for IDs found by mem_search.',
    Type.Object({ ids: Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1, maxItems: 100 }) }),
    (params, signal) => worker.request('/api/observations/batch', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params), signal,
    }));
}
