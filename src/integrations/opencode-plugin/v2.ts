/**
 * OpenCode v2 adapter, informed by Ephemushroom/opencode-claude-mem (MIT,
 * copyright 2026 Bryan). See THIRD-PARTY-LICENSE.txt for license/provenance.
 * The v1 entry remains a single exported factory; v2 has a separate definition.
 */
import type { Context, Plugin } from '@opencode/plugin/promise/plugin';
import type { Session } from '@opencode/schema/session';
import type { Registration } from '@opencode/plugin/promise/registration';
import { createHarnessWorkerClient } from '../harness-worker.js';
import { isInternalProtocolPayload, stripMemoryTags } from '../../utils/tag-stripping.js';
import { logger } from '../../utils/logger.js';

type Messages = Awaited<ReturnType<Context['session']['context']>>;
interface Turn {
  id: string;
  prompt: string;
  capture: boolean;
  anchored: boolean;
  needsSummary: boolean;
  assistant: string;
}
interface State {
  id: Session.ID;
  lifetime: AbortController;
  signal: AbortSignal;
  queue: Promise<void>;
  turn?: Turn;
  memory: string;
  memoryLoaded: boolean;
  retryContextAt: number;
}
const MAX_SESSIONS = 1_000;
const MAX_TEXT = 100_000;
// Match the shared file-evidence vocabulary used by the first-party v1 adapter (#3678).
const CAPTURE_TOOL_NAMES = new Map([
  ['read', 'Read'],
  ['write', 'Write'],
  ['edit', 'Edit'],
]);

/** Admission can be queued or steered. Only delivered context owns capture. */
function consumedTurn(messages: Messages): Turn | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.type === 'synthetic') {
      return { id: message.id, prompt: '', capture: false, anchored: false, needsSummary: false, assistant: '' };
    }
    if (message.type !== 'user') continue;
    const raw = message.text ?? '';
    const text = stripMemoryTags(raw);
    const synthetic = message.metadata?.synthetic || message.metadata?.agentId || isInternalProtocolPayload(raw);
    return {
      id: message.id,
      prompt: text || (!raw.trim() && message.files?.length ? '[media prompt]' : ''),
      capture: !synthetic && Boolean(text || (!raw.trim() && message.files?.length)),
      anchored: false, needsSummary: false, assistant: '',
    };
  }
}

function toolText(result: unknown): string {
  if (typeof result === 'string') return stripMemoryTags(result).slice(0, MAX_TEXT);
  if (result && typeof result === 'object') {
    const value = result as { content?: unknown; output?: unknown };
    if (typeof value.content === 'string') return toolText(value.content);
    if (Array.isArray(value.content)) {
      return toolText(value.content.filter(part => part?.type === 'text' && typeof part.text === 'string')
        .map(part => part.text).join('\n'));
    }
    if (value.output !== undefined) return toolText(value.output);
  }
  return toolText(JSON.stringify(result ?? ''));
}

function sanitize(value: unknown): unknown {
  if (typeof value === 'string') return stripMemoryTags(value);
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]));
  return value;
}

export default {
  id: 'claude-mem',
  async setup(ctx: Context) {
    const controller = new AbortController();
    const worker = createHarnessWorkerClient();
    const states = new Map<string, State>();
    const registrations: Registration[] = [];
    const directory = ctx.location.directory;
    const active = (state: State): boolean => !state.signal.aborted;
    let warned = false;
    const warn = (error: unknown): void => {
      if (!warned && !controller.signal.aborted) {
        logger.warn('OPENCODE', 'Memory unavailable. Run npx claude-mem doctor.', undefined, error);
        warned = true;
      }
    };
    function enqueue(state: State, operation: () => Promise<void>): Promise<void> {
      state.queue = state.queue.then(async () => {
        if (active(state)) await operation();
      }).catch(error => { if (active(state)) warn(error); });
      return state.queue;
    }
    function stateFor(id: Session.ID): State | undefined {
      if (!id || controller.signal.aborted) return;
      let state = states.get(id);
      if (!state) {
        // Bound a long-lived server without evicting a turn still being captured.
        if (states.size >= MAX_SESSIONS) {
          const idle = [...states.values()].find(item => !active(item) || !item.turn?.needsSummary);
          if (!idle) return;
          idle.lifetime.abort();
          states.delete(idle.id);
        }
        const lifetime = new AbortController();
        state = {
          id, lifetime, signal: AbortSignal.any([controller.signal, lifetime.signal]),
          queue: Promise.resolve(),
          memory: '', memoryLoaded: false, retryContextAt: 0,
        };
        states.set(id, state);
      }
      if (active(state)) return state;
    }
    async function owns(state: State): Promise<boolean> {
      if (!active(state)) return false;
      // Sessions can move locations while the server remains alive.
      // Public requestOptions.signal: https://opencode.ai/v2/docs/build/plugins/#sessions
      // Also verified against @opencode/client 2.0.22's published RequestOptions.
      try {
        const session = await ctx.session.get({ sessionID: state.id }, { signal: state.signal });
        return active(state) && session.location.directory === directory;
      } catch { return false; }
    }
    async function summarize(state: State, turn = state.turn): Promise<void> {
      if (!active(state) || !turn?.anchored || !turn.needsSummary) return;
      await worker.post('/api/sessions/summarize', {
        contentSessionId: state.id, cwd: directory, platformSource: 'opencode',
        last_assistant_message: turn.assistant,
      }, state.signal);
      if (active(state)) turn.needsSummary = false;
    }

    registrations.push(await ctx.session.hook('context', async event => {
      const state = stateFor(event.sessionID);
      if (!state) return;
      await enqueue(state, async () => {
        if (!await owns(state)) return;
        const messages = await ctx.session.context({ sessionID: event.sessionID }, { signal: state.signal });
        if (!active(state)) return;
        const next = consumedTurn(messages);
        if (next && state.turn?.id !== next.id) {
          const previous = state.turn;
          state.turn = next;
          await summarize(state, previous).catch(error => { if (active(state)) warn(error); });
        }
        if (!active(state)) return;
        const turn = state.turn;
        if (turn?.capture && !turn.anchored) {
          await worker.ready(state.signal);
          if (!active(state)) return;
          const response = await worker.post('/api/sessions/init', {
            contentSessionId: state.id, cwd: directory, prompt: turn.prompt, platformSource: 'opencode',
          }, state.signal);
          if (!active(state)) return;
          const result = await response.json() as { skipped?: boolean; reason?: string; sessionDbId?: number };
          if (!active(state)) return;
          // Duplicate means persisted, unlike a private/excluded prompt.
          turn.anchored = typeof result.sessionDbId === 'number' && (!result.skipped || result.reason === 'duplicate');
          turn.capture = !result.skipped || result.reason === 'duplicate';
          turn.needsSummary = turn.anchored;
          if (result.skipped && result.reason !== 'duplicate') return;
        }
        if (turn && !turn.capture) return;
        if (!state.memoryLoaded && Date.now() >= state.retryContextAt) {
          state.retryContextAt = Date.now() + 60_000;
          await worker.ready(state.signal);
          if (!active(state)) return;
          const query = new URLSearchParams({ cwd: directory, platform_source: 'opencode' });
          const response = await worker.request('/api/context/inject?' + query, { signal: state.signal });
          if (!active(state)) return;
          const memory = (await response.text()).trim();
          if (!active(state)) return;
          state.memory = memory;
          state.memoryLoaded = true;
        }
        if (!active(state)) return;
        event.system = event.system.filter(part => part.type !== 'text' || !part.text.startsWith('<claude-mem-context>'));
        if (state.memory) event.system.push({ type: 'text', text: '<claude-mem-context>\n' + state.memory + '\n</claude-mem-context>' });
      });
    }));
    registrations.push(await ctx.session.hook('model.request', event => {
      if (event.kind === 'compaction') {
        const state = states.get(event.sessionID);
        if (state && active(state)) state.memoryLoaded = false;
      }
    }));
    registrations.push(await ctx.tool.hook('execute.after', async event => {
      if (/^(?:mem[_-]|.*claude[-_]mem(?:__|_))/i.test(event.tool)) return;
      const state = stateFor(event.sessionID);
      if (!state) return;
      // The turn this tool ran in when one is already current: a later prompt
      // can swap state.turn while this callback waits behind that prompt's
      // anchor acknowledgement. Tools can also run before the first anchor
      // completes; those fall back to the turn that materializes by drain.
      const turn = state.turn;
      await enqueue(state, async () => {
        if (!await owns(state)) return;
        const target = turn ?? state.turn;
        if (!active(state) || !target?.anchored) return;
        let toolInput = sanitize(event.input);
        // The v2 SDK supplies readonly input, not v1 args. Rename the native patch
        // key on the sanitized copy so the observer receives the patch only once.
        if (event.tool === 'apply_patch' && toolInput && typeof toolInput === 'object' && !Array.isArray(toolInput)) {
          const { patchText, ...otherArgs } = toolInput as Record<string, unknown>;
          if (typeof patchText === 'string') toolInput = { ...otherArgs, patch: patchText };
        }
        await worker.post('/api/sessions/observations', {
          contentSessionId: state.id, cwd: directory, platformSource: 'opencode',
          tool_name: CAPTURE_TOOL_NAMES.get(event.tool) ?? event.tool, tool_input: toolInput, tool_use_id: event.id,
          tool_response: event.status === 'error' ? toolText(event.error.message) : toolText(event.result),
        }, state.signal);
      });
    }));

    // Public events cover all locations. Check both the envelope and the session.
    void (async () => {
      while (!controller.signal.aborted) {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            if (controller.signal.aborted) break;
            // Execution and deletion events arrive without a location on the
            // real 2.0.23 host; owns() guards their session location. Only
            // events that carry a location are filtered here.
            if (!('sessionID' in event.data) || (event.location && event.location.directory !== directory)) continue;
            const id = event.data.sessionID as Session.ID;
            if (event.type === 'session.deleted') {
              const state = states.get(id);
              state?.lifetime.abort();
              // Retain a tombstone until cleanup/eviction; late callbacks cannot reopen it.
              continue;
            }
            if (event.type !== 'session.text.ended' && event.type !== 'session.execution.succeeded' && event.type !== 'session.compaction.ended') continue;
            const state = stateFor(id);
            if (!state) continue;
            // The turn this event belongs to when one is already current: a
            // later prompt can swap state.turn while this callback waits in
            // the queue. Events can also arrive before the first anchor
            // completes; those fall back to the turn that materializes by drain.
            const turn = state.turn;
            // Queue ownership with capture so the reader can immediately abort a
            // deleted session, even while its SDK ownership request is pending.
            void enqueue(state, async () => {
              if (!await owns(state)) return;
              const target = turn ?? state.turn;
              if (event.type === 'session.text.ended' && target?.anchored) {
                target.assistant = toolText(event.data.text);
              } else if (event.type === 'session.execution.succeeded' || event.type === 'session.compaction.ended') {
                state.memoryLoaded = false;
                await summarize(state, target);
              }
            });
          }
        } catch (error) { warn(error); }
        if (!controller.signal.aborted) {
          await new Promise<void>(resolve => {
            const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); };
            const timer = setTimeout(done, 10_000);
            timer.unref();
            controller.signal.addEventListener('abort', done, { once: true });
          });
        }
      }
    })();
    return async () => {
      controller.abort();
      await Promise.allSettled(registrations.map(registration => registration.dispose()));
      states.clear();
    };
  },
} satisfies Plugin;
