import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, posix, win32 } from "node:path";
import { localWorkspaceRoot } from "../../utils/project-name.js";
import {
  stripMemoryTags,
  stripSystemReminderBlocks,
} from "../../utils/tag-stripping.js";
import { isProjectExcluded } from "../../utils/project-filter.js";
import {
  messageTime,
  plainTextBlocks,
  record,
  string,
  type RecordValue,
  type HistoricalChat,
  type HistoricalMessage,
} from "./chat-shape.js";

/** Local exports can originate from a different OS. Keep the absolute path out of observer prompts and saved metadata. */
function nativeProject(
  cwd: string,
  fallback: string,
  source: "claude-code" | "codex",
) {
  const paths = win32.isAbsolute(cwd) && !posix.isAbsolute(cwd) ? win32 : posix;
  if (cwd && paths.isAbsolute(cwd)) {
    let directory = paths.normalize(cwd).replace(/[\\/]+$/, "");
    if (isAbsolute(cwd)) {
      try {
        if (statSync(cwd).isDirectory())
          directory =
            localWorkspaceRoot(realpathSync(cwd)) ?? realpathSync(cwd);
      } catch {
        /* Exports from another machine retain their declared checkout identity. */
      }
    }
    const label = paths.basename(directory);
    if (label)
      return {
        project: label,
        projectId:
          "cwd:" + createHash("sha256").update(directory).digest("hex"),
        projectOrigin: "export" as const,
      };
  }
  return {
    project: fallback || `Unassigned ${source} chats`,
    projectOrigin: fallback ? ("user" as const) : ("unassigned" as const),
  };
}

function sourceCwd(value: unknown): string {
  // A native worktree name can contain leading/trailing spaces. Preserve it exactly for scope checks.
  return typeof value === "string" ? value : "";
}

export function visibleClaudeRole(
  row: RecordValue,
  sessionHasOrigins: boolean,
): "user" | "assistant" | null {
  if (row.isSidechain || row.isMeta || row.isCompactSummary) return null;
  if (row.type === "assistant") return "assistant";
  if (
    row.type !== "user" ||
    (sessionHasOrigins && record(row.origin).kind !== "human")
  )
    return null;
  return "user";
}

export function nativeChats(
  value: unknown,
  fallback: string,
  excluded: string,
  acceptCwd?: (cwd: string) => boolean,
) {
  const rows = Array.isArray(value) ? value.map(record) : [];
  const meta = rows.find((row) => row.type === "session_meta");
  const source = meta ? "codex" : "claude-code";
  const grouped = new Map<string, HistoricalChat>();
  let skipped = 0;
  const projects = new Map<string, ReturnType<typeof nativeProject>>();
  function append(id: string, cwd: string, msg: HistoricalMessage): void {
    if (acceptCwd && !acceptCwd(cwd)) return;
    const context = projects.get(cwd) ?? nativeProject(cwd, fallback, source);
    projects.set(cwd, context);
    if (
      !id ||
      !Number.isSafeInteger(msg.timestampMs) ||
      !msg.text ||
      isProjectExcluded(cwd, excluded) ||
      isProjectExcluded(context.project, excluded)
    ) {
      skipped++;
      return;
    }
    const key = JSON.stringify([id, context.projectId]);
    const chat = grouped.get(key) ?? { id, source, ...context, messages: [] };
    chat.messages.push(msg);
    grouped.set(key, chat);
  }

  if (meta) {
    const header = record(meta.payload);
    const id = string(header.id);
    // Forks can start with copies of another thread's turns; exec and subagent runs are machine inputs.
    if (
      !id ||
      header.forked_from_id ||
      typeof header.source !== "string" ||
      header.source === "exec" ||
      header.originator === "codex_exec"
    ) {
      return { chats: [], recognized: true, skipped: 1 };
    }
    let importedTurn = "";
    let cwd = sourceCwd(header.cwd);
    for (const row of rows) {
      const p = record(row.payload);
      if (row.type === "turn_context") cwd = sourceCwd(p.cwd);
      if (row.type === "event_msg" && p.type === "task_started") {
        const turn = string(p.turn_id);
        importedTurn = turn.startsWith("external-import-turn-") ? turn : "";
      } else if (
        row.type === "event_msg" &&
        p.type === "task_complete" &&
        p.turn_id === importedTurn
      )
        importedTurn = "";
      if (
        importedTurn ||
        row.type !== "response_item" ||
        p.type !== "message" ||
        (p.role !== "assistant" && p.role !== "user")
      )
        continue;
      const role = p.role;
      const blocks = Array.isArray(p.content) ? p.content.map(record) : [];
      const visible = blocks
        .filter(
          (b) => b.type === (role === "user" ? "input_text" : "output_text"),
        )
        .map((b) => string(b.text))
        .join("\n");
      if (
        role === "user" &&
        /^(?:# AGENTS\.md|<environment_context|<user_instructions|<permissions|<INSTRUCTIONS|<turn_aborted)/.test(
          visible.trim(),
        )
      )
        continue;
      const text = stripMemoryTags(stripSystemReminderBlocks(visible));
      const timestampMs = messageTime(row.timestamp);
      // Some native rollouts have no message ID. The dated, role-qualified full native message has a stable digest.
      const messageId =
        string(p.id) ||
        createHash("sha256")
          .update(JSON.stringify([id, role, row.timestamp, visible]))
          .digest("hex");
      append(id, cwd, { id: messageId, role, text, timestampMs });
    }
    return { chats: [...grouped.values()], recognized: true, skipped };
  }

  // Claude Code appends events as they occur. Parent links also connect hook events,
  // parallel tool results and compaction segments, so graph leaves are not chat branches.
  // Explicit isSidechain markers distinguish subagent activity from this transcript.
  const recognized = rows.some(
    (row) => string(row.sessionId) && string(row.uuid),
  );
  const taggedSessions = new Set(
    rows
      .filter((row) => row.type === "user" && record(row.origin).kind)
      .map((row) => string(row.sessionId)),
  );
  const responseTexts = new Map<string, Set<string>>();
  for (const row of rows) {
    const session = string(row.sessionId);
    const messageId = string(row.uuid);
    const role = visibleClaudeRole(row, taggedSessions.has(session));
    if (!role || !session || !messageId) continue;
    const msg = record(row.message);
    const visible =
      typeof msg.content === "string"
        ? msg.content
        : plainTextBlocks(msg.content);
    // Legacy exports can lack origin.kind. Native command wrappers and system notifications
    // are machine events even when serialized with role=user.
    if (
      role === "user" &&
      /^(?:<command-(?:name|message)>|<local-command-(?:caveat|stdout)>|<task-notification>|<system-reminder>)/i.test(
        visible.trim(),
      ) &&
      !record(row.origin).kind
    )
      continue;
    let text = stripMemoryTags(stripSystemReminderBlocks(visible)).trim();
    const apiId = string(msg.id);
    if (text && role === "assistant" && apiId) {
      // One API reply can arrive as multiple dated JSONL rows. Keep the native UUID of
      // each genuinely new visible fragment, excluding repeated or cumulative snapshots.
      const key = JSON.stringify([session, apiId]);
      const seen = responseTexts.get(key) ?? new Set<string>();
      if (
        seen.has(text) ||
        [...seen].some((previous) => previous.startsWith(text))
      )
        continue;
      const prefix = [...seen]
        .filter((previous) => text.startsWith(previous))
        .sort((a, b) => b.length - a.length)[0];
      seen.add(text);
      responseTexts.set(key, seen);
      if (prefix) text = text.slice(prefix.length).trim();
    }
    append(session, sourceCwd(row.cwd), {
      id: messageId,
      role,
      text,
      timestampMs: messageTime(row.timestamp),
    });
  }
  return { chats: [...grouped.values()], recognized, skipped };
}
