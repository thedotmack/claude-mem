/**
 * Check if plugin was updated after this process started
 * Returns warning message if restart needed, null otherwise
 */
import { readFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface PluginUpdateInfo {
  version: string;
  timestamp: number;
  date: string;
}

export function checkPluginUpdate(): string | null {
  try {
    const markerPath = join(homedir(), ".claude-mem", "last-plugin-update");

    // Check if marker file exists
    try {
      statSync(markerPath);
    } catch {
      // No marker file = no recent updates to warn about
      return null;
    }

    // Read update info
    const content = readFileSync(markerPath, "utf-8");
    const updateInfo: PluginUpdateInfo = JSON.parse(content);

    // Get process start time (seconds since epoch)
    const processStartTime = Math.floor((Date.now() - process.uptime() * 1000) / 1000);

    // If plugin was updated after this process started, warn
    if (updateInfo.timestamp > processStartTime) {
      const updateDate = new Date(updateInfo.timestamp * 1000);
      const updateTime = updateDate.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });

      return (
        `\n⚠️  Claude-mem plugin was updated to v${updateInfo.version} at ${updateTime}\n` +
        `   This session is using old hook code. Restart Claude Code to use the new version.\n` +
        `   (This warning will appear until you restart)\n`
      );
    }

    return null;
  } catch (error) {
    // Silently ignore errors - this is a non-critical feature
    return null;
  }
}
