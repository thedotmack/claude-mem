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
  alive: boolean;
  ownership: Promise<boolean>;
  queue: Promise<void>;
  turn?: Turn;
  memory: string;
  memoryLoaded: boolean;
  retryContextAt: number;
}
const MAX_SESSIONS = 1_000;
const MAX_TEXT = 100_000;

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
    let warned = false;
    const warn = (error: unknown): void => {
      if (!warned && !controller.signal.aborted) {
        console.warn('[claude-mem] OpenCode memory unavailable. Run npx claude-mem doctor. ' + String(error));
        warned = true;
      }
    };
    function enqueue(state: State, operation: () => Promise<void>): Promise<void> {
      state.queue = state.queue.then(async () => {
        if (state.alive && !controller.signal.aborted) await operation();
      }).catch(warn);
      return state.queue;
    }
    async function own(id: Session.ID): Promise<State | undefined> {
      if (!id || controller.signal.aborted) return;
      let state = states.get(id);
      if (!state) {
        // Bound a long-lived server without evicting a turn still being captured.
        if (states.size >= MAX_SESSIONS) {
          const idle = [...states.values()].find(item => !item.turn?.needsSummary);
          if (!idle) return;
          idle.alive = false;
          states.delete(idle.id);
        }
        state = {
          id, alive: true, ownership: Promise.resolve(false), queue: Promise.resolve(),
          memory: '', memoryLoaded: false, retryContextAt: 0,
        };
        states.set(id, state);
      }
      if (!state.alive) return;
      const target = state;
      // Sessions can move locations while the server remains alive.
      state.ownership = ctx.session.get({ sessionID: id }).then(session =>
        target.alive && !controller.signal.aborted && session.location.directory === directory,
      ).catch(() => false);
      if (await state.ownership && state.alive && !controller.signal.aborted) return state;
    }
    async function summarize(state: State, turn = state.turn): Promise<void> {
      if (!turn?.anchored || !turn.needsSummary) return;
      await worker.post('/api/sessions/summarize', {
        contentSessionId: state.id, cwd: directory, platformSource: 'opencode',
        last_assistant_message: turn.assistant,
      });
      turn.needsSummary = false;
    }

    registrations.push(await ctx.session.hook('context', async event => {
      const state = await own(event.sessionID);
      if (!state) return;
      await enqueue(state, async () => {
        const next = consumedTurn(await ctx.session.context({ sessionID: event.sessionID }));
        if (!state.alive || controller.signal.aborted) return;
        if (next && state.turn?.id !== next.id) {
          const previous = state.turn;
          state.turn = next;
          await summarize(state, previous).catch(warn);
        }
        const turn = state.turn;
        if (turn?.capture && !turn.anchored) {
          await worker.ready();
          const response = await worker.post('/api/sessions/init', {
            contentSessionId: state.id, cwd: directory, prompt: turn.prompt, platformSource: 'opencode',
          });
          const result = await response.json() as { skipped?: boolean; reason?: string; sessionDbId?: number };
          // Duplicate means persisted, unlike a private/excluded prompt.
          turn.anchored = typeof result.sessionDbId === 'number' && (!result.skipped || result.reason === 'duplicate');
          turn.capture = !result.skipped || result.reason === 'duplicate';
          turn.needsSummary = turn.anchored;
          if (result.skipped && result.reason !== 'duplicate') return;
        }
        if (turn && !turn.capture) return;
        if (!state.memoryLoaded && Date.now() >= state.retryContextAt) {
          state.retryContextAt = Date.now() + 60_000;
          await worker.ready();
          const query = new URLSearchParams({ cwd: directory, platform_source: 'opencode' });
          state.memory = (await (await worker.request('/api/context/inject?' + query)).text()).trim();
          state.memoryLoaded = true;
        }
        event.system = event.system.filter(part => part.type !== 'text' || !part.text.startsWith('<claude-mem-context>'));
        if (state.memory) event.system.push({ type: 'text', text: '<claude-mem-context>\n' + state.memory + '\n</claude-mem-context>' });
      });
    }));
    registrations.push(await ctx.session.hook('model.request', event => {
      if (event.kind === 'compaction') {
        const state = states.get(event.sessionID);
        if (state) state.memoryLoaded = false;
      }
    }));
    registrations.push(await ctx.tool.hook('execute.after', async event => {
      if (/^(?:mem[_-]|.*claude[-_]mem(?:__|_))/i.test(event.tool)) return;
      const state = await own(event.sessionID);
      if (!state) return;
      const turn = state.turn;
      await enqueue(state, async () => {
        if (!turn?.anchored) return;
        await worker.post('/api/sessions/observations', {
          contentSessionId: state.id, cwd: directory, platformSource: 'opencode',
          tool_name: event.tool, tool_input: sanitize(event.input), tool_use_id: event.id,
          tool_response: event.status === 'error' ? toolText(event.error.message) : toolText(event.result),
        });
      });
    }));

    // Public events cover all locations. Check both the envelope and the session.
    void (async () => {
      while (!controller.signal.aborted) {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            if (controller.signal.aborted) break;
            if (!('sessionID' in event.data) || event.location?.directory !== directory) continue;
            const id = event.data.sessionID as Session.ID;
            if (event.type === 'session.deleted') {
              const state = states.get(id);
              if (state) state.alive = false;
              // Retain a tombstone until cleanup/eviction; late callbacks cannot reopen it.
              continue;
            }
            const state = await own(id);
            if (!state) continue;
            const turn = state.turn;
            if (event.type === 'session.text.ended' && turn?.anchored) {
              const text = toolText(event.data.text);
              await enqueue(state, async () => { turn.assistant = text; });
            } else if (event.type === 'session.execution.succeeded' || event.type === 'session.compaction.ended') {
              state.memoryLoaded = false;
              await enqueue(state, () => summarize(state, turn));
            }
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
      for (const state of states.values()) state.alive = false;
      await Promise.allSettled(registrations.map(registration => registration.dispose()));
      states.clear();
    };
  },
} satisfies Plugin;
