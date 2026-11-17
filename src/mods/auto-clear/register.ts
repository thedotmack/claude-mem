/**
 * The auto-clear mod's hooks module: Claude Code loads the bundle of this file
 * (plugin/hooks/auto-clear.js, named by `modules` in plugin/hooks/hooks.json)
 * and calls `register`. Claude Code versions without mods ignore `modules`.
 *
 * Claude Code reads what a hooks module hooks and calls off its source, so
 * `register` is a function declaration, every hook is a literal
 * `on("<event>", …)`, and `$` is only ever spelled `$.<namespace>.<method>(…)`
 * with literal names: it is never passed to a helper, which is why the host
 * below is built inline and why `toolCallEnd` takes only the event.
 *
 * Tool results are watched at `session.append` (door `tool-result`), not at the
 * tool-call event: Claude Code's Code Mode refuses to start while any enabled
 * plugin's hooks module hooks a tool-call, tool-check or classic PreToolUse
 * event (and a few more), so one such hook here would turn Code Mode off for
 * all of claude-mem. scripts/code-mode-refused-events.js lists the events and
 * the build fails if this bundle hooks one.
 */
import { AutoClearController, WORK_STATE_WRITE_TOOL, type AutoClearHost, type ToolCallEnd } from './controller.js';
import type { ApiContentBlock, On, SessionAppendEvent } from './mod-api.js';
import {
  AUTO_CLEAR_DEFAULT_PERCENT,
  defaultDataDir,
  joinPath,
  parseSettingsJson,
  redirectedDataDir,
  resolveAutoClearSettings,
  type AutoClearSettings,
} from './settings.js';

/** settings.json is read again at most this often, so a change applies within a minute without a read per tool call. */
const SETTINGS_TTL_MS = 30_000;

/** The text of one tool_result block: its content as a string, or the text blocks of a block array. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block: ApiContentBlock) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('');
}

/** A stored tool-result row as the controller sees a finished tool call. */
function toolCallEnd(e: SessionAppendEvent): ToolCallEnd {
  let isError = false;
  let text = '';
  for (const block of e.message.content) {
    if (block.type !== 'tool_result') continue;
    if (block.is_error === true) isError = true;
    text += resultText(block.content);
  }
  return {
    tool: typeof e.origin.tool === 'string' ? e.origin.tool : 'unknown',
    agentId: e.agentId,
    isError,
    text,
  };
}

export function register(on: On): void {
  let controller: AutoClearController | null = null;

  on('session.start', async ($, e, next) => {
    if (!controller) {
      let cached: { settings: AutoClearSettings; readAt: number } | null = null;
      // A missing file is no document (the defaults apply). A file that is there
      // but cannot be read or parsed throws, so a user's opt-out is never lost to it.
      const readSettingsFile = async (path: string) => {
        if (!(await $.fs.exists(path))) return null;
        const document = parseSettingsJson(await $.fs.read(path));
        if (!document) throw new Error(`${path} is not a JSON object`);
        return document;
      };
      const readSettings = async (): Promise<AutoClearSettings> => {
        const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || undefined;
        const envDataDir = (await $.env.get('CLAUDE_MEM_DATA_DIR')) || undefined;
        const env = {
          CLAUDE_MEM_AUTO_CLEAR_ENABLED: await $.env.get('CLAUDE_MEM_AUTO_CLEAR_ENABLED'),
          CLAUDE_MEM_AUTO_CLEAR_PERCENT: await $.env.get('CLAUDE_MEM_AUTO_CLEAR_PERCENT'),
          CLAUDE_MEM_WORK_STATE_ENABLED: await $.env.get('CLAUDE_MEM_WORK_STATE_ENABLED'),
        };
        const dataDir = defaultDataDir(envDataDir, home);
        let document = dataDir ? await readSettingsFile(joinPath(dataDir, 'settings.json')) : null;
        const redirected = redirectedDataDir(document, envDataDir, home);
        if (redirected) document = await readSettingsFile(joinPath(redirected, 'settings.json'));
        return resolveAutoClearSettings({ env, document });
      };

      const host: AutoClearHost = {
        settings: async () => {
          const now = await $.clock.now();
          if (cached && now - cached.readAt < SETTINGS_TTL_MS) return cached.settings;
          let settings: AutoClearSettings;
          try {
            settings = await readSettings();
          } catch {
            // Unreadable settings, or another mod refused a read: keep what was
            // last read, and with nothing read yet stay off rather than guess.
            settings = cached?.settings ?? { enabled: false, percent: AUTO_CLEAR_DEFAULT_PERCENT };
          }
          cached = { settings, readAt: now };
          return settings;
        },
        contextPercent: async () => {
          const { context } = await $.session.usage();
          return typeof context.percent === 'number' ? context.percent : undefined;
        },
        isInteractive: async () => (await $.session.surfaces()).length > 0,
        submitPrompt: async text => {
          await $.prompt.submit({ text });
        },
        clear: async () => {
          await $.command.run({ command: 'clear' });
        },
        submitAsUser: async text => {
          try {
            await $.prompt.submit({ text, asUser: true });
          } catch {
            // A Claude Code without `asUser` sends it labeled as claude-mem's.
            await $.prompt.submit({ text });
          }
        },
        note: text => {
          $.ui.log(text);
        },
        defer: task => {
          $.clock.after(0, () => {
            task().catch(() => {});
          });
        },
      };
      controller = new AutoClearController(host);
    }
    return next(e);
  });

  on('session.append', { door: 'tool-result' }, async ($, e, next) => {
    // The row is stored first: nothing here may hold it back or change it.
    const stored = await next(e);
    if (!controller) return stored;
    try {
      // Judge the result by the row as kept: a later hook in the chain may have changed its content.
      const note = await controller.onToolCallEnd(toolCallEnd({ ...e, message: stored.message }));
      if (note) await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: note }] } });
    } catch {
      // Auto-clear never gets in the way of a tool result being kept.
    }
    return stored;
  }).catch(async ($, e, next) => next(e));

  // A tool-result row names only its tool, so the save's own arguments (the
  // continuation prompt's blanks) are read off the model's response row, which
  // carries the work_state_write tool_use block.
  on('session.append', { door: 'response' }, async ($, e, next) => {
    // The row is stored first and kept as it is: this only reads its tool_use blocks.
    const stored = await next(e);
    if (!controller) return stored;
    try {
      for (const block of stored.message.content) {
        if (block.type === 'tool_use' && typeof block.name === 'string' && WORK_STATE_WRITE_TOOL.test(block.name)) {
          controller.onWorkStateWriteCall({ agentId: e.agentId, input: block.input });
        }
      }
    } catch (error) {
      // The row is already kept; say why the continuation prompt may fall back to "continue".
      $.ui.log(`claude-mem auto-clear could not read a work_state_write call off the model's response, so the continuation prompt may fall back to "continue": ${error instanceof Error ? error.message : String(error)}`);
    }
    return stored;
  }).catch(async ($, e, next) => next(e));

  on('turn.start', async ($, e, next) => {
    controller?.onTurnStart();
    return next(e);
  });

  on('turn.complete', async ($, e, next) => {
    const result = await next(e);
    if (!controller) return result;
    try {
      await controller.onTurnEnd({ agentId: e.agentId, isAborted: e.isAborted, reason: e.reason });
    } catch {
      // Nor of a turn ending.
    }
    return result;
  }).catch(async ($, e, next) => next(e));

  on('session.end', async ($, e, next) => {
    controller?.onConversationEnd();
    return next(e);
  });
}
