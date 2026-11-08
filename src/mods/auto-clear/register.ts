/**
 * The auto-clear mod's hooks module: Claude Code loads the bundle of this file
 * (plugin/hooks/auto-clear.js, named by `modules` in plugin/hooks/hooks.json)
 * and calls `register`. Claude Code versions without mods ignore `modules`.
 *
 * Claude Code reads what a hooks module hooks and calls off its source, so
 * `register` is a function declaration, every hook is `on("<event>", hook)`,
 * and `$` is only ever spelled `$.<namespace>.<method>(…)` with literal names:
 * it is never passed to a helper, which is why the host below is built inline.
 */
import { AutoClearController, type AutoClearHost } from './controller.js';
import type { On } from './mod-api.js';
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

  on('tool.call', async ($, e, next) => {
    const result = await next(e);
    if (!controller) return result;
    try {
      const note = await controller.onToolCallEnd({
        tool: e.tool,
        agentId: e.agentId,
        denied: typeof result.deny === 'string',
        isError: result.isError === true,
        text: typeof result.text === 'string' ? result.text : undefined,
      });
      if (note) return { ...result, context: [...(result.context ?? []), note] };
    } catch {
      // Auto-clear never gets in the way of a tool call.
    }
    return result;
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
