import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { stripVTControlCharacters } from 'util';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { describeWorkerStart, workerStartProgressMessage } from '../../src/npx-cli/commands/install.js';

// With CLAUDE_MEM_WORKER_AUTOSTART=false and a remote CLAUDE_MEM_WORKER_HOST the
// installer launches nothing and only probes that host. Its lines must say so,
// not "Spawning worker" and "Worker ready at http://localhost" (#6419).
describe('installer worker wording', () => {
  let settings: ReturnType<typeof spyOn> | undefined;
  const useSettings = (overrides: Record<string, string>) => {
    settings = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_WORKER_PORT: '37700',
      ...overrides,
    }));
  };
  afterEach(() => settings?.mockRestore());

  it('checks, not spawns, an externally managed remote worker and names its host', () => {
    useSettings({ CLAUDE_MEM_WORKER_HOST: '10.0.0.5', CLAUDE_MEM_WORKER_AUTOSTART: 'false' });

    const progress = workerStartProgressMessage(true);
    const ready = stripVTControlCharacters(describeWorkerStart('ready'));

    expect(progress).not.toContain('Spawning');
    expect(progress).toContain('http://10.0.0.5:37700');
    expect(ready).toContain('http://10.0.0.5:37700');
    expect(ready).not.toContain('localhost');
  });

  it('names CLAUDE_MEM_WORKER_URL when that is the worker being checked', () => {
    useSettings({ CLAUDE_MEM_WORKER_URL: 'https://worker.example.com/' });

    expect(workerStartProgressMessage(true)).toContain('https://worker.example.com...');
    expect(stripVTControlCharacters(describeWorkerStart('ready'))).toContain('Worker ready at https://worker.example.com OK');
  });

  it('still says it spawns a worker it starts itself', () => {
    useSettings({ CLAUDE_MEM_WORKER_HOST: '127.0.0.1' });

    expect(workerStartProgressMessage(false)).toBe('Spawning worker on port 37700...');
    expect(stripVTControlCharacters(describeWorkerStart('ready'))).toContain('Worker ready at http://127.0.0.1:37700');
  });
});
