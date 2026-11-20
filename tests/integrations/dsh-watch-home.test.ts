import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installDshTranscriptWatch } from '../../src/services/integrations/DeepSeekHarnessInstaller.js';
import { TranscriptWatcher } from '../../src/services/transcripts/watcher.js';
import { TranscriptEventProcessor } from '../../src/services/transcripts/processor.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

describe('DSH reinstall follows the selected home for its managed watch', () => {
  let root: string;
  let configPath: string;
  let oldHome: string | undefined;
  let settings: ReturnType<typeof spyOn>;
  let dispatch: ReturnType<typeof spyOn>;
  let watcher: TranscriptWatcher | undefined;
  const source = join(process.cwd(), 'dsh');
  const readConfig = () => JSON.parse(readFileSync(configPath, 'utf8'));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dsh-watch-home-'));
    configPath = join(root, 'watch.json');
    oldHome = process.env.DSH_HOME;
    process.env.DSH_HOME = join(root, 'old-home');
    mkdirSync(join(process.env.DSH_HOME, 'sessions'), { recursive: true });
    settings = spyOn(SettingsDefaultsManager, 'loadFromFile').mockReturnValue({
      ...SettingsDefaultsManager.getAllDefaults(), CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH: configPath,
    });
    // Observe the real file watcher's dispatch boundary without invoking a host,
    // model or worker. All transcripts and checkpoint files are owned fixtures.
    dispatch = spyOn(TranscriptEventProcessor.prototype, 'processEntry').mockResolvedValue(undefined);
  });

  afterEach(async () => {
    const pending = watcher ? [...(watcher as any).tailers.values()].map((tailer: any) => tailer.readTask) : [];
    watcher?.stop();
    await Promise.all(pending);
    watcher = undefined;
    dispatch.mockRestore();
    settings.mockRestore();
    if (oldHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = oldHome;
    rmSync(root, { recursive: true, force: true });
  });

  it('captures appended events in the relocated home without replaying its existing transcript', async () => {
    installDshTranscriptWatch(source);
    process.env.DSH_HOME = join(root, 'new-home');
    const folder = join(process.env.DSH_HOME, 'sessions', 'owned-session');
    mkdirSync(folder, { recursive: true });
    const file = join(folder, 'session.jsonl');
    writeFileSync(file, JSON.stringify({ type: 'session', id: 'owned-session', cwd: root, createdAt: Date.now() }) + '\n'
      + JSON.stringify({ type: 'user/message', data: { content: [{ type: 'text', text: 'existing history' }] } }) + '\n');
    installDshTranscriptWatch(source);
    const config = readConfig();
    watcher = new TranscriptWatcher(config, join(root, 'state.json'));
    await watcher.start();
    const tailer = (watcher as any).tailers.get(file);
    await tailer?.readTask;
    expect(dispatch.mock.calls).toHaveLength(0);
    const next = { type: 'user/message', time: Date.now(), data: { content: [{ type: 'text', text: 'new work' }] } };
    appendFileSync(file, JSON.stringify(next) + '\n');
    // Drive the discovered tailer directly so the test does not depend on the
    // OS filesystem-notification timing. A stale watch never discovers it.
    tailer?.poke();
    await tailer?.readTask;
    expect(dispatch.mock.calls.map(call => call[0])).toEqual([next]);
    expect(config.watches).toHaveLength(1);
    expect(config.watches[0].startAtEnd).toBe(true);
  });

  it('preserves the managed watch settings when updating only its home', () => {
    const owned = { name: 'dsh', path: '/old/sessions', schema: 'dsh', managedBy: 'claude-mem',
      startAtEnd: false, project: 'custom-project', workspace: root };
    const other = { name: 'other', path: '/other', schema: 'custom' };
    writeFileSync(configPath, JSON.stringify({ version: 1, watches: [owned, other] }));
    installDshTranscriptWatch(source);
    expect(readConfig().watches).toEqual([{ ...owned, path: join(process.env.DSH_HOME!, 'sessions') }, other]);
  });

  it('leaves an explicitly user-managed DSH watch authoritative', () => {
    const watch = { name: 'dsh', path: '/user-selected/sessions', schema: 'dsh', startAtEnd: false };
    writeFileSync(configPath, JSON.stringify({ version: 1, watches: [watch] }));
    installDshTranscriptWatch(source);
    expect(readConfig().watches).toEqual([watch]);
  });
});
