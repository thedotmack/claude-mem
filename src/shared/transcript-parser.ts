import { readFileSync, existsSync } from "fs";
import { logger } from "../utils/logger.js";

/**
 * Extract last message of specified role from transcript JSONL file
 * @param transcriptPath Path to transcript file
 * @param role 'user' or 'assistant'
 * @param stripSystemReminders Whether to remove <system-reminder> tags (for assistant)
 */
export function extractLastMessage(
  transcriptPath: string,
  role: "user" | "assistant",
  stripSystemReminders: boolean = false,
): string {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    // When running in a git worktree, Claude Code derives the transcript path
    // from the worktree CWD, which encodes as a different project directory.
    // The actual transcript lives under the main project path.
    // Example: worktree path encodes as -project--claude-worktrees-name/session.jsonl
    //          but transcript lives at -project/session.jsonl
    // Try stripping the worktree segment from the encoded path.
    const worktreeFixed = transcriptPath?.replace(
      /(\/[^/]+)--claude-worktrees-[^/]+(\/)/,
      "$1$2",
    );
    if (
      worktreeFixed &&
      worktreeFixed !== transcriptPath &&
      existsSync(worktreeFixed)
    ) {
      logger.info("PARSER", "Transcript found via worktree path fallback", {
        original: transcriptPath,
        resolved: worktreeFixed,
      });
      return extractLastMessage(worktreeFixed, role, stripSystemReminders);
    }
    // Gracefully return empty instead of throwing — caller handles empty string
    logger.debug("PARSER", "Transcript not found, returning empty", {
      path: transcriptPath,
    });
    return "";
  }

  const content = readFileSync(transcriptPath, "utf-8").trim();
  if (!content) {
    throw new Error(`Transcript file exists but is empty: ${transcriptPath}`);
  }

  const lines = content.split("\n");
  let foundMatchingRole = false;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = JSON.parse(lines[i]);
    if (line.type === role) {
      foundMatchingRole = true;

      if (line.message?.content) {
        let text = "";
        const msgContent = line.message.content;

        if (typeof msgContent === "string") {
          text = msgContent;
        } else if (Array.isArray(msgContent)) {
          text = msgContent
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("\n");
        } else {
          // Unknown content format - throw error
          throw new Error(
            `Unknown message content format in transcript. Type: ${typeof msgContent}`,
          );
        }

        if (stripSystemReminders) {
          text = text.replace(
            /<system-reminder>[\s\S]*?<\/system-reminder>/g,
            "",
          );
          text = text.replace(/\n{3,}/g, "\n\n").trim();
        }

        // Return text even if empty - caller decides if that's an error
        return text;
      }
    }
  }

  // If we searched the whole transcript and didn't find any message of this role
  if (!foundMatchingRole) {
    return "";
  }

  return "";
}
