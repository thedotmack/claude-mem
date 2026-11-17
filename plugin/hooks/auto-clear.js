// Built from src/mods/auto-clear/ by scripts/build-hooks.js. Edit the source, not this file.

// src/mods/auto-clear/controller.ts
var WORK_STATE_WRITE_TOOL = /(?:^|__)work_state_write$/;
var WORK_STATE_READ_TOOL = /(?:^|__)work_state_read$/;
var SAVED_RESULT = /^Saved to "/;
var CONTINUE_PROMPT = "continue";
var AutoClearController = class {
  constructor(host) {
    this.host = host;
  }
  host;
  phase = "idle";
  /** The latest main-loop tool call since Claude was asked was a successful work_state_write. */
  saved = false;
  /** Waiting for the first context reading of a conversation auto-clear started. */
  checkFreshStart = false;
  /** No more requests in this conversation (a save was refused or stopped); cleared by the next /clear. */
  pausedForConversation = false;
  /** Off until Claude Code restarts. */
  stopped = false;
  threshold = 0;
  /** Bumped when a conversation ends; a deferred action of an older conversation does nothing. */
  conversation = 0;
  /** Set from just before our own /clear runs until its conversation end is seen. */
  ownClearPending = false;
  /** Bumped when a main-loop turn starts. */
  turnsStarted = 0;
  /** Turn completion retires tool-hook reads even when the person stopped the turn. */
  readGeneration = 0;
  /** A main-loop or subagent tool result was stored; returns the reminder to append behind it, if any. */
  async onToolCallEnd(call) {
    if (call.agentId) return null;
    if (WORK_STATE_WRITE_TOOL.test(call.tool)) {
      if (this.phase !== "idle" && this.phase !== "clearing") {
        const text = (call.text ?? "").trim();
        if (!call.isError && text === "") {
          this.stopForUnreadableSave();
          return null;
        }
        this.saved = !call.isError && SAVED_RESULT.test(text);
      }
      return null;
    }
    if (!WORK_STATE_READ_TOOL.test(call.tool)) this.saved = false;
    if (this.phase !== "idle") return null;
    const isCurrent = this.readGuard();
    const percent = await this.thresholdCrossed(isCurrent);
    if (percent === null || !isCurrent()) return null;
    this.phase = "saving-in-turn";
    this.saved = false;
    this.host.note(`Context is at ${percent}% (auto-clear at ${this.threshold}%): Claude is saving the work state, then claude-mem clears and continues.`);
    return inTurnSaveRequest(percent, this.threshold);
  }
  /**
   * A main-loop turn started (subagent runs raise no turn start). A turn that
   * starts while the clear is still to come is the person's prompt typed
   * before the turn ended: its work is not in the save, so the clear waits
   * and the save is asked for again once that turn is past the threshold.
   */
  onTurnStart() {
    this.turnsStarted += 1;
    if (this.phase === "clearing" && !this.ownClearPending) {
      this.phase = "idle";
      this.saved = false;
    }
  }
  async onTurnEnd(turn) {
    if (turn.agentId) return;
    this.readGeneration += 1;
    const isCurrent = this.readGuard();
    switch (this.phase) {
      case "idle": {
        if (turn.isAborted || turn.reason !== "answer") return;
        const percent = await this.thresholdCrossed(isCurrent);
        if (percent === null || !isCurrent()) return;
        this.saved = false;
        this.host.note(`Context is at ${percent}% (auto-clear at ${this.threshold}%): asking Claude to save the work state, then claude-mem clears and continues.`);
        this.queueSavePrompt(percent);
        return;
      }
      case "saving-in-turn": {
        if (turn.isAborted || turn.reason !== "answer") return this.giveUp("The turn was stopped before the work state was saved, so the conversation was not cleared.");
        if (this.saved) return this.clearAndContinue();
        const percent = await this.host.contextPercent();
        if (!isCurrent()) return;
        this.queueSavePrompt(percent ?? this.threshold);
        return;
      }
      case "saving-in-prompt":
        if (turn.isAborted || turn.reason !== "answer") return this.giveUp("The save was stopped, so the conversation was not cleared.");
        if (this.saved) return this.clearAndContinue();
        return this.giveUp("Claude did not save the work state, so the conversation was not cleared.");
      case "save-prompt-queued":
        return;
      case "clearing":
        return;
    }
  }
  /** The conversation ended: /clear (ours or the person's), a resume, or exit. */
  onConversationEnd() {
    this.conversation += 1;
    this.pausedForConversation = false;
    if (this.ownClearPending) {
      this.ownClearPending = false;
      return;
    }
    this.phase = "idle";
    this.saved = false;
    this.checkFreshStart = false;
  }
  /** Async host reads belong to the conversation, turn and phase that requested them. */
  readGuard() {
    const conversation = this.conversation;
    const turn = this.turnsStarted;
    const phase = this.phase;
    const generation = this.readGeneration;
    return () => this.conversation === conversation && this.turnsStarted === turn && this.phase === phase && this.readGeneration === generation && !this.stopped && !this.pausedForConversation;
  }
  /** The context use when this conversation should be cleared now, else null. */
  async thresholdCrossed(isCurrent) {
    if (!isCurrent()) return null;
    const settings = await this.host.settings();
    if (!isCurrent() || !settings.enabled) return null;
    const percent = await this.host.contextPercent();
    if (!isCurrent() || percent === void 0) return null;
    if (this.checkFreshStart) {
      this.checkFreshStart = false;
      if (percent >= settings.percent) {
        this.stopped = true;
        this.host.note(
          `A fresh conversation already uses ${percent}% of the context window, at or past the ${settings.percent}% auto-clear point, so auto-clear is off until Claude Code restarts. Raise CLAUDE_MEM_AUTO_CLEAR_PERCENT in ~/.claude-mem/settings.json to keep using it.`
        );
        return null;
      }
    }
    if (percent < settings.percent) return null;
    if (!await this.host.isInteractive() || !isCurrent()) return null;
    this.threshold = settings.percent;
    return percent;
  }
  queueSavePrompt(percent) {
    this.phase = "save-prompt-queued";
    const conversation = this.conversation;
    const stillOurs = () => this.conversation === conversation && this.phase === "save-prompt-queued";
    this.host.defer(async () => {
      if (!stillOurs()) return;
      try {
        await this.host.submitPrompt(savePrompt(percent, this.threshold));
      } catch {
        if (stillOurs()) this.giveUp("The save prompt could not be sent, so the conversation was not cleared.");
        return;
      }
      if (stillOurs()) this.phase = "saving-in-prompt";
    });
  }
  clearAndContinue() {
    this.phase = "clearing";
    this.saved = false;
    const conversation = this.conversation;
    this.host.note("Work state saved. Clearing the conversation and continuing.");
    this.host.defer(async () => {
      if (this.conversation !== conversation || this.phase !== "clearing") return;
      const turnsBeforeClear = this.turnsStarted;
      this.ownClearPending = true;
      try {
        await this.host.clear();
      } catch {
        this.ownClearPending = false;
        if (this.conversation === conversation && this.phase === "clearing") this.giveUp("/clear could not run, so the conversation was not cleared.");
        return;
      }
      this.ownClearPending = false;
      if (this.phase !== "clearing") return;
      this.phase = "idle";
      this.checkFreshStart = true;
      if (this.turnsStarted !== turnsBeforeClear) {
        this.host.note("The conversation was cleared after your last message ran, so that turn is not in the saved work state. Tell Claude where to pick up.");
        return;
      }
      try {
        await this.host.submitAsUser(CONTINUE_PROMPT);
      } catch {
        this.host.note('The conversation was cleared, but "continue" could not be sent. Type it to pick the work back up.');
      }
    });
  }
  /** A save came back with no text, so it cannot be told from a refused one: clearing now could lose the work. */
  stopForUnreadableSave() {
    this.phase = "idle";
    this.saved = false;
    this.stopped = true;
    this.host.note(
      "This session runs tools from a script (Code Mode), so claude-mem cannot read the result of the work state save and did not clear the conversation. Auto-clear is off in this session until Claude Code restarts."
    );
  }
  giveUp(reason) {
    this.phase = "idle";
    this.saved = false;
    this.pausedForConversation = true;
    this.host.note(`${reason} Auto-clear waits until the next /clear.`);
  }
};
var SAVE_STEPS = [
  "- Update each list you are working from: mark finished items done and add what is still to do.",
  "- Record the goal, the decisions made and why, the files involved, and the exact next step."
].join("\n");
function inTurnSaveRequest(percent, threshold) {
  return [
    `claude-mem auto-clear: this conversation now uses ${percent}% of the context window, past the ${threshold}% point set in claude-mem. When this turn ends, claude-mem clears the conversation and sends "continue", and the fresh conversation starts with your open work state.`,
    "",
    "Wrap up now so the work carries over. Save where things stand with work_state_write:",
    SAVE_STEPS,
    "",
    "Then end your turn with a one-line note instead of starting new work."
  ].join("\n");
}
function savePrompt(percent, threshold) {
  return [
    `This conversation now uses ${percent}% of the context window, past the ${threshold}% auto-clear point set in claude-mem. When this turn ends, claude-mem clears the conversation and sends "continue", and the fresh conversation starts with your open work state.`,
    "",
    "Save where things stand with work_state_write so the work carries over:",
    SAVE_STEPS,
    "",
    "Only save state in this turn. A one-line confirmation is enough."
  ].join("\n");
}

// src/shared/settings-document-shape.ts
var isSettingsRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function classifySettingsDocument(document) {
  const env = document.env;
  return isSettingsRecord(env) && Object.keys(env).some((key) => key.startsWith("CLAUDE_MEM_")) ? "nested" : "flat";
}
function settingsTarget(document) {
  return classifySettingsDocument(document) === "nested" ? document.env : document;
}

// src/shared/work-state-setting.ts
function isWorkStateEnabled(value) {
  return String(value ?? "").trim().toLowerCase() !== "false";
}

// src/mods/auto-clear/settings.ts
var AUTO_CLEAR_DEFAULT_PERCENT = 33;
var AUTO_CLEAR_MIN_PERCENT = 1;
var AUTO_CLEAR_MAX_PERCENT = 95;
function parseSettingsJson(text) {
  try {
    const parsed = JSON.parse(text.replace(/^﻿/, ""));
    return isSettingsRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function settingValue(sources, key) {
  const fromEnv = sources.env[key];
  if (fromEnv !== void 0) return fromEnv;
  if (!sources.document) return void 0;
  const value = settingsTarget(sources.document)[key];
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : void 0;
}
function parseAutoClearPercent(value) {
  const percent = Number(String(value ?? "").trim());
  if (!Number.isFinite(percent) || percent < AUTO_CLEAR_MIN_PERCENT || percent > AUTO_CLEAR_MAX_PERCENT) {
    return AUTO_CLEAR_DEFAULT_PERCENT;
  }
  return percent;
}
function resolveAutoClearSettings(sources) {
  const autoClearOn = String(settingValue(sources, "CLAUDE_MEM_AUTO_CLEAR_ENABLED") ?? "false").trim().toLowerCase() === "true";
  const workStateOn = isWorkStateEnabled(settingValue(sources, "CLAUDE_MEM_WORK_STATE_ENABLED"));
  return {
    enabled: autoClearOn && workStateOn,
    percent: parseAutoClearPercent(settingValue(sources, "CLAUDE_MEM_AUTO_CLEAR_PERCENT"))
  };
}
function expandHomePath(path, home) {
  if (!home) return path;
  if (path === "~") return home;
  if (path.startsWith("~/") || path.startsWith("~\\")) return joinPath(home, path.slice(2));
  return path;
}
function joinPath(directory, name) {
  return `${directory.replace(/[\\/]+$/, "")}/${name}`;
}
function defaultDataDir(envDataDir, home) {
  if (envDataDir) return expandHomePath(envDataDir, home);
  return home ? joinPath(home, ".claude-mem") : null;
}
function redirectedDataDir(homeDocument, envDataDir, home) {
  if (envDataDir || !homeDocument) return null;
  const configured = settingsTarget(homeDocument).CLAUDE_MEM_DATA_DIR;
  if (typeof configured !== "string" || configured.trim() === "") return null;
  const expanded = expandHomePath(configured.trim(), home);
  const fallback = defaultDataDir(void 0, home);
  return fallback !== null && expanded.replace(/[\\/]+$/, "") === fallback ? null : expanded;
}

// src/mods/auto-clear/register.ts
var SETTINGS_TTL_MS = 3e4;
function resultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => block?.type === "text" && typeof block.text === "string" ? block.text : "").join("");
}
function toolCallEnd(e) {
  let isError = false;
  let text = "";
  for (const block of e.message.content) {
    if (block.type !== "tool_result") continue;
    if (block.is_error === true) isError = true;
    text += resultText(block.content);
  }
  return {
    tool: typeof e.origin.tool === "string" ? e.origin.tool : "unknown",
    agentId: e.agentId,
    isError,
    text
  };
}
function register(on) {
  let controller = null;
  on("session.start", async ($, e, next) => {
    if (!controller) {
      let cached = null;
      const readSettingsFile = async (path) => {
        if (!await $.fs.exists(path)) return null;
        const document = parseSettingsJson(await $.fs.read(path));
        if (!document) throw new Error(`${path} is not a JSON object`);
        return document;
      };
      const readSettings = async () => {
        const home = await $.env.get("HOME") || await $.env.get("USERPROFILE") || void 0;
        const envDataDir = await $.env.get("CLAUDE_MEM_DATA_DIR") || void 0;
        const env = {
          CLAUDE_MEM_AUTO_CLEAR_ENABLED: await $.env.get("CLAUDE_MEM_AUTO_CLEAR_ENABLED"),
          CLAUDE_MEM_AUTO_CLEAR_PERCENT: await $.env.get("CLAUDE_MEM_AUTO_CLEAR_PERCENT"),
          CLAUDE_MEM_WORK_STATE_ENABLED: await $.env.get("CLAUDE_MEM_WORK_STATE_ENABLED")
        };
        const dataDir = defaultDataDir(envDataDir, home);
        let document = dataDir ? await readSettingsFile(joinPath(dataDir, "settings.json")) : null;
        const redirected = redirectedDataDir(document, envDataDir, home);
        if (redirected) document = await readSettingsFile(joinPath(redirected, "settings.json"));
        return resolveAutoClearSettings({ env, document });
      };
      const host = {
        settings: async () => {
          const now = await $.clock.now();
          if (cached && now - cached.readAt < SETTINGS_TTL_MS) return cached.settings;
          let settings;
          try {
            settings = await readSettings();
          } catch {
            settings = cached?.settings ?? { enabled: false, percent: AUTO_CLEAR_DEFAULT_PERCENT };
          }
          cached = { settings, readAt: now };
          return settings;
        },
        contextPercent: async () => {
          const { context } = await $.session.usage();
          return typeof context.percent === "number" ? context.percent : void 0;
        },
        isInteractive: async () => (await $.session.surfaces()).length > 0,
        submitPrompt: async (text) => {
          await $.prompt.submit({ text });
        },
        clear: async () => {
          await $.command.run({ command: "clear" });
        },
        submitAsUser: async (text) => {
          try {
            await $.prompt.submit({ text, asUser: true });
          } catch {
            await $.prompt.submit({ text });
          }
        },
        note: (text) => {
          $.ui.log(text);
        },
        defer: (task) => {
          $.clock.after(0, () => {
            task().catch(() => {
            });
          });
        }
      };
      controller = new AutoClearController(host);
    }
    return next(e);
  });
  on("session.append", { door: "tool-result" }, async ($, e, next) => {
    const stored = await next(e);
    if (!controller) return stored;
    try {
      const note = await controller.onToolCallEnd(toolCallEnd(e));
      if (note) await $.session.append({ message: { type: "user", content: [{ type: "text", text: note }] } });
    } catch {
    }
    return stored;
  }).catch(async ($, e, next) => next(e));
  on("turn.start", async ($, e, next) => {
    controller?.onTurnStart();
    return next(e);
  });
  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    if (!controller) return result;
    try {
      await controller.onTurnEnd({ agentId: e.agentId, isAborted: e.isAborted, reason: e.reason });
    } catch {
    }
    return result;
  }).catch(async ($, e, next) => next(e));
  on("session.end", async ($, e, next) => {
    controller?.onConversationEnd();
    return next(e);
  });
}
export {
  register
};
