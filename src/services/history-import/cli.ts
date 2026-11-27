import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { loadDocument } from '../../shared/settings-document.js';
import { isProjectExcluded } from '../../utils/project-filter.js';
import { ModeManager } from '../domain/ModeManager.js';
import { SessionStore } from '../sqlite/SessionStore.js';
import { isCloudSyncConfigured } from '../sync/CloudSync.js';
import { readChatExports } from './sources.js';
import { readWorkspaceChats } from './workspace.js';
import { HistoryReplayStore } from './store.js';
import { localChatObserver } from './local-observer.js';
import { conversationKey, replayHistoricalChats } from './replay.js';

const HELP = [
  'claude-mem import chats (--workspace | <export file or folder> [--project <fallback>]) [--apply] [--model <local Ollama model>] [--limit <new turns>] [--proof]',
  '--workspace finds Claude Code and Codex chats for the current working directory.',
  'Preview the last 30 days without inference or database writes. --apply generates dated observations in the local Claude-Mem database.',
  'Replay uses a locally installed Ollama chat model. Saved observations follow your existing Cloud Sync settings. Completed turns are reused when you rerun. --proof prints local observation IDs, dates, projects and titles.',
].join('\n');

export async function runHistoricalChatImport(args: string[]): Promise<void> {
  const {values, positionals} = parseArgs({ args, allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, apply: { type: 'boolean' }, proof: { type: 'boolean' },
    workspace: { type: 'boolean' }, project: { type: 'string' }, model: { type: 'string' }, limit: { type: 'string' },
  } });
  if (values.help) { console.log(HELP); return; }
  if (positionals.length !== (values.workspace ? 0 : 1)) throw new Error(HELP);
  if (values.workspace && values.project !== undefined) throw new Error('--project is a fallback for exported chats. Use --workspace on its own for this directory.');
  const limit = values.limit === undefined ? Infinity : Number(values.limit);
  if (values.limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error('--limit must be a positive integer.');

  if (loadDocument(USER_SETTINGS_PATH).error) throw new Error('Could not read the local Claude-Mem settings.');
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH, true, { readOnly: true });
  const input = values.workspace ? process.cwd() : resolve(positionals[0]);
  const excluded = settings.CLAUDE_MEM_EXCLUDED_PROJECTS;
  if (isProjectExcluded(input, excluded) || isProjectExcluded(process.cwd(), excluded)) {
    throw new Error('This folder is excluded by CLAUDE_MEM_EXCLUDED_PROJECTS.');
  }
  const history = values.workspace ? await readWorkspaceChats(input) : await readChatExports(input, { project: values.project });
  const { chats, skipped } = history;
  if ('unreadable' in history && history.unreadable) console.log(`${history.unreadable} history files could not be read.`);
  if ('compressedSkipped' in history && history.compressedSkipped) console.log(`${history.compressedSkipped} compressed session files skipped.`);
  const turns = chats.reduce((sum, chat) => sum + chat.messages.length, 0);
  const conversations = new Set(chats.map(conversationKey));
  const projects = new Set(chats.map(chat => {
    // Both native clients can refer to the same cwd. Provider export IDs are scoped to their provider.
    const namespace = chat.source === 'claude-code' || chat.source === 'codex' ? 'workspace' : chat.source;
    return JSON.stringify([namespace, chat.projectId ?? chat.project]);
  }));
  console.log(`${conversations.size} chats across ${projects.size} projects; ${turns} dated turns in the last 30 days. ${skipped} source records skipped.`);
  if (turns) {
    // Both readers return messages ordered by source time within each project.
    let earliest = Infinity;
    let latest = -Infinity;
    for (const { messages } of chats) {
      if (!messages.length) continue;
      earliest = Math.min(earliest, messages[0].timestampMs);
      latest = Math.max(latest, messages[messages.length - 1].timestampMs);
    }
    console.log(`Source messages span ${new Date(earliest).toISOString()} to ${new Date(latest).toISOString()}.`);
  }
  if (!values.apply || !turns) {
    if (!values.apply) console.log('Preview complete. Add --apply to generate observations with a local Ollama model.');
    return;
  }
  if (settings.CLAUDE_MEM_RUNTIME !== 'worker' || settings.CLAUDE_MEM_WORKER_URL.trim()) {
    throw new Error('Historical import writes to a local SQLite worker. Run this command on the machine holding the local database.');
  }

  const mode = ModeManager.getInstance().loadMode(settings.CLAUDE_MEM_MODE);
  const store = new SessionStore(undefined, { syncOpsEnabled: isCloudSyncConfigured(settings) });
  const reportedIds = new Set<number>();
  try {
    const result = await replayHistoricalChats(chats, new HistoryReplayStore(store), async () => {
      const observer = await localChatObserver(values.model);
      console.log('Replaying transcript turns with local model ' + observer.model);
      return observer;
    }, mode, limit, (unit, receipt) => {
      if (values.proof) {
        for (const [index, id] of receipt.ids.entries()) {
          if (reportedIds.has(id)) continue;
          reportedIds.add(id);
          console.log(JSON.stringify({
            observationId: id, occurredAt: new Date(unit.at).toISOString(), project: unit.project,
            source: unit.source, messageId: unit.messageId, title: receipt.titles[index],
          }));
        }
      }
    });
    console.log(`${result.stored} new observations, ${result.existing} previously processed turns, ${result.skipped} turns without a new observation; ${result.calls} model calls.`);
    if (result.unverified) {
      console.log(`Partial import. ${result.unverified} turns lacked a verified observation and remain retryable. Rerun with --model NAME to fill the gaps with another installed local chat model.`);
      process.exitCode = 2;
    }
    if (result.limited) console.log('Reached --limit. Rerun to continue from the next unprocessed turn.');
  } finally {
    store.close();
  }
}
