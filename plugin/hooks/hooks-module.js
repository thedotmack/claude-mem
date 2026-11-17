// Built from src/mods/ by scripts/build-hooks.js. Edit the source, not this file.

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
function registerAutoClear(on) {
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
      const note = await controller.onToolCallEnd(toolCallEnd({ ...e, message: stored.message }));
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

// src/shared/session-start-card-slot.ts
var SESSION_START_CARD_FILE_KEY = "claude_mem_session_start_card_file";
var SESSION_START_CARD_FOLDER = "session-start-card";
var SESSION_START_CARD_SOURCES = ["startup", "clear", "compact"];
var FILE_NAME_SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/;
function isFileNameSafeSessionId(sessionId) {
  return typeof sessionId === "string" && FILE_NAME_SAFE_SESSION_ID.test(sessionId);
}
function sessionStartCardSlotPath(pluginDataDirectory, sessionId, startedAtEpochMs) {
  return `${pluginDataDirectory.replace(/[\\/]+$/, "")}/${SESSION_START_CARD_FOLDER}/${sessionId}.${startedAtEpochMs}.json`;
}

// src/mods/session-start-card/card.ts
var TERMINAL_ENTRYPOINT = "cli";
var SESSION_START_CARD_MINIMUM_VERSION = [2, 1, 326];
function supportsSessionStartCard(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
  if (!match) return false;
  for (let i = 0; i < SESSION_START_CARD_MINIMUM_VERSION.length; i += 1) {
    const part = Number(match[i + 1]);
    if (part !== SESSION_START_CARD_MINIMUM_VERSION[i]) return part > SESSION_START_CARD_MINIMUM_VERSION[i];
  }
  return true;
}
function isSessionStartCardSource(source) {
  return SESSION_START_CARD_SOURCES.includes(source);
}
var COMPACT_SOURCE = "compact";
var TERMINAL_SURFACE = "terminal";
function drawsSessionStartCard(source, isFullscreen) {
  if (!isSessionStartCardSource(source)) return false;
  return source !== COMPACT_SOURCE || isFullscreen === true;
}
var SGR_COLOR_NAMES = {
  "31": "red",
  "32": "green",
  "33": "yellow",
  "34": "blue",
  "35": "magenta",
  "36": "cyan",
  "90": "gray"
};
var SGR_SEQUENCE = /\x1b\[([0-9;]*)m/g;
var REFUSED_IN_DRAWN_TEXT = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\uD800-\uDFFF\u{10EEEE}]/gu;
var BRAILLE_BLANK = /⠀/g;
function drawableText(text) {
  return text.replace(REFUSED_IN_DRAWN_TEXT, "").replace(BRAILLE_BLANK, " ");
}
function parseAnsiLines(text) {
  let color;
  let isBold = false;
  let isDim = false;
  return text.split(/\r?\n/).map((line) => {
    const runs = [];
    const addRun = (raw) => {
      const runText = drawableText(raw);
      if (runText) runs.push({ text: runText, color, isBold, isDim });
    };
    let from = 0;
    for (const sequence of line.matchAll(SGR_SEQUENCE)) {
      addRun(line.slice(from, sequence.index));
      for (const code of (sequence[1] || "0").split(";")) {
        if (code === "0" || code === "") {
          color = void 0;
          isBold = false;
          isDim = false;
        } else if (code === "1") {
          isBold = true;
        } else if (code === "2") {
          isDim = true;
        } else if (SGR_COLOR_NAMES[code]) {
          color = SGR_COLOR_NAMES[code];
        }
      }
      from = sequence.index + sequence[0].length;
    }
    addRun(line.slice(from));
    return runs;
  });
}
function sessionStartCardLines(slotFileText) {
  let slot;
  try {
    slot = JSON.parse(slotFileText);
  } catch {
    return null;
  }
  if (!slot || typeof slot.text !== "string" || slot.text.trim() === "") return null;
  return parseAnsiLines(slot.text);
}

// src/mods/session-start-card/register.ts
var CARD_TITLE = "claude-mem";
function cardNotShownLine(error) {
  return `claude-mem: the session-start card is not shown: ${error instanceof Error ? error.message : String(error)}`;
}
function registerSessionStartCard(on) {
  let card = null;
  let isFullscreen = null;
  let waitingForHookRows = null;
  on("classic.SessionStart", async ($, e, next) => {
    waitingForHookRows = null;
    if (!drawsSessionStartCard(e.source, isFullscreen) || !isFileNameSafeSessionId(e.session_id)) return next(e);
    let addition = null;
    let slotPath = null;
    let startedAtEpochMs = 0;
    try {
      if (await $.env.get("CLAUDE_CODE_ENTRYPOINT") === TERMINAL_ENTRYPOINT) {
        const engine = await $.session.version();
        if (supportsSessionStartCard(engine.base ?? engine.version)) {
          const pluginDataDirectory = (await $.process.hookEnv()).CLAUDE_PLUGIN_DATA;
          if (!pluginDataDirectory) throw new Error("Claude Code named no plugin data folder");
          startedAtEpochMs = await $.clock.now();
          slotPath = sessionStartCardSlotPath(pluginDataDirectory, e.session_id, startedAtEpochMs);
        }
      }
    } catch (error) {
      addition = { notShownLine: cardNotShownLine(error) };
    }
    let result;
    if (slotPath === null) {
      result = await next(e);
    } else {
      const slotFile = slotPath;
      result = await next({ ...e, [SESSION_START_CARD_FILE_KEY]: slotFile });
      try {
        if (await $.fs.exists(slotFile)) {
          const lines = sessionStartCardLines(await $.fs.read(slotFile));
          if (!lines) throw new Error(`${slotFile} holds no banner`);
          addition = { card: { rowId: `session-start-${startedAtEpochMs}`, lines } };
        }
      } catch (error) {
        addition = { notShownLine: cardNotShownLine(error) };
      }
    }
    if (addition === null) return result;
    if (e.source !== COMPACT_SOURCE) {
      waitingForHookRows = addition;
      return result;
    }
    if ("notShownLine" in addition) {
      $.ui.log(addition.notShownLine);
      return result;
    }
    const cardBeforeThisCompaction = card;
    card = addition.card;
    try {
      const placed = await $.ui.place({ id: addition.card.rowId });
      if (!placed.isPlaced && placed.requestId === void 0) throw new Error(placed.reason);
      $.ui.invalidate("ui.render");
    } catch (error) {
      card = cardBeforeThisCompaction;
      $.ui.log(cardNotShownLine(error));
    }
    return result;
  }).catch(async ($, e, next) => next(e));
  on(
    "session.append",
    { door: "hook-context", origin: { kind: "hook", event: "SessionStart" }, message: { name: "hook_additional_context" } },
    async ($, e, next) => {
      const keptRow = await next(e);
      const addition = waitingForHookRows;
      waitingForHookRows = null;
      if (addition === null) return keptRow;
      if ("notShownLine" in addition) {
        $.ui.log(addition.notShownLine);
        return keptRow;
      }
      const cardBeforeThisStart = card;
      card = addition.card;
      try {
        const placed = await $.ui.place({ id: addition.card.rowId });
        if (!placed.isPlaced && placed.requestId === void 0) throw new Error(placed.reason);
        $.ui.invalidate("ui.render");
      } catch (error) {
        card = cardBeforeThisStart;
        $.ui.log(cardNotShownLine(error));
      }
      return keptRow;
    }
  );
  on("ui.render", { component: "Placed" }, async ($, e, next) => {
    if (e.surface === TERMINAL_SURFACE && typeof e.viewport?.isFullscreen === "boolean") isFullscreen = e.viewport.isFullscreen;
    if (!card || e.props.plugin !== $.plugin.name || e.props.id !== card.rowId) return next(e);
    const { Box, Text } = $.ui.resolve(e);
    return h(
      Box,
      { flexDirection: "column", borderStyle: "round", borderColor: "claude", paddingX: 1 },
      h(Text, { weight: "bold", color: "claude" }, CARD_TITLE),
      card.lines.map(
        (runs) => h(
          Text,
          null,
          // A Text with nothing in it takes no row; a space keeps the blank line.
          runs.length === 0 ? " " : runs.map((run) => h(Text, { color: run.color, dimColor: run.isDim, weight: run.isBold ? "bold" : void 0 }, run.text))
        )
      )
    );
  });
}

// src/mods/hooks-module.ts
function register(on) {
  registerAutoClear(on);
  registerSessionStartCard(on);
}
export {
  register
};
