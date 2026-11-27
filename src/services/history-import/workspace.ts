import { lstatSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { isProjectExcluded } from '../../utils/project-filter.js';
import { localWorkspaceRoot } from '../../utils/project-name.js';
import {
  claudeConfigDirectory,
  createClaudeCodeReader,
  createCodexReader,
  readLines,
} from '../prompt-import/readers.js';
import { scanWindowStart } from '../prompt-import/index.js';
import { nativeChats } from './native-sources.js';
import { addMessage, type HistoricalChat, type HistoricalMessage } from './sources.js';

/** Only actual, existing paths inside this checkout are evidence of workspace membership. */
export function workspaceScope(path: string, excluded: string) {
  if (!isAbsolute(path) || !statSync(path).isDirectory())
    throw new Error('Open the project directory to import its chats.');
  const cwd = realpathSync(path);
  const root = realpathSync(localWorkspaceRoot(cwd) ?? cwd);
  if (
    root === parse(root).root ||
    root === realpathSync(homedir()) ||
    isProjectExcluded(cwd, excluded) ||
    isProjectExcluded(root, excluded)
  ) {
    throw new Error('Open a specific, non-excluded project directory to import its chats.');
  }
  const cache = new Map<string, boolean>();
  const accepts = (candidate: string): boolean => {
    if (!candidate || !isAbsolute(candidate) || isProjectExcluded(candidate, excluded)) return false;
    const previous = cache.get(candidate);
    if (previous !== undefined) return previous;
    let allowed = false;
    try {
      const dir = realpathSync(candidate);
      const diff = relative(root, dir);
      if (
        statSync(dir).isDirectory() &&
        diff !== '..' &&
        !diff.startsWith('..' + sep) &&
        !isAbsolute(diff) &&
        !isProjectExcluded(dir, excluded)
      ) {
        allowed = true;
        // A nested .git can also be a worktree pointer or an unreadable repository; either is a different scope.
        for (let parent = dir; parent !== root; parent = dirname(parent)) {
          const git = lstatSync(join(parent, '.git'), {
            throwIfNoEntry: false,
          });
          if (git) {
            allowed = false;
            break;
          }
        }
      }
    } catch {
      /* A missing or unreadable source directory cannot prove membership. */
    }
    cache.set(candidate, allowed);
    return allowed;
  };
  return { root, accepts };
}

export async function readWorkspaceChats(workspace: string, now = Date.now()) {
  const excluded =
    process.env.CLAUDE_MEM_EXCLUDED_PROJECTS ??
    SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH, true, {
      readOnly: true,
    }).CLAUDE_MEM_EXCLUDED_PROJECTS;
  const scope = workspaceScope(workspace, excluded);
  const groups = new Map<string, { chat: HistoricalChat; messages: Map<string, HistoricalMessage> }>();
  const since = scanWindowStart(now);
  let unreadable = 0,
    compressedSkipped = 0,
    skipped = 0;
  const home = homedir();
  for (const reader of [createClaudeCodeReader(), createCodexReader()]) {
    const profile =
      reader.id === 'claude-code'
        ? claudeConfigDirectory(home)
        : resolve(process.env.CODEX_HOME || join(home, '.codex'));
    for (const file of reader.locate(home).sources) {
      if (!file.holdsPrompts || file.mtimeMs < since || isProjectExcluded(file.path, excluded)) continue;
      // Reject symlinked profile files rather than following a transcript name outside the native storage tree.
      const rows: unknown[] = [];
      try {
        if (realpathSync(file.path) !== join(realpathSync(profile), relative(profile, file.path))) continue;
        if (!lstatSync(file.path).isFile() || file.bytes > 256 * 1024 * 1024) {
          unreadable++;
          continue;
        }
        for await (const line of readLines(file.path, 256 * 1024 * 1024)) {
          if (!line.trim()) continue;
          rows.push(JSON.parse(line));
        }
      } catch {
        if (file.path.endsWith('.zst')) compressedSkipped++;
        else unreadable++;
        continue;
      }
      const native = nativeChats(rows, '', excluded, scope.accepts);
      skipped += native.skipped;
      for (const chat of native.chats) {
        const key = JSON.stringify([chat.source, chat.id, chat.projectId]);
        const group = groups.get(key) ?? {
          chat,
          messages: new Map<string, HistoricalMessage>(),
        };
        for (const message of chat.messages) {
          if (message.timestampMs >= since && message.timestampMs <= now) addMessage(group.messages, message);
          else skipped++;
        }
        groups.set(key, group);
      }
    }
  }
  const chats: HistoricalChat[] = [];
  for (const group of groups.values()) {
    if (!group.messages.size) continue;
    group.chat.messages = [...group.messages.values()].sort((a, b) => a.timestampMs - b.timestampMs);
    chats.push(group.chat);
  }
  return { chats, skipped, unreadable, compressedSkipped };
}
