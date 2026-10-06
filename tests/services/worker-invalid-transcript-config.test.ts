import { afterAll, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerService } from '../../src/services/worker-service.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { logger } from '../../src/utils/logger.js';

// Background init awaits startTranscriptWatcher before the Chroma backfill,
// CloudSync, the pull loop and the MCP self-check. A config the watcher cannot
// run must turn off transcript capture only, so the method has to resolve.
const root = mkdtempSync(join(tmpdir(), 'cm-worker-transcript-config-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('WorkerService.startTranscriptWatcher with an invalid transcript config', () => {
  const cases: Array<[label: string, fileName: string, contents: string]> = [
    ['a shape the validator rejects', 'rejected-shape.json', JSON.stringify({ version: 1, watches: {} })],
    ['unparseable JSON', 'unparseable.json', '{"version": 1, "watches": ['],
  ];

  for (const [label, fileName, contents] of cases) {
    it(`resolves without a watcher for ${label}`, async () => {
      const configPath = join(root, fileName);
      writeFileSync(configPath, contents);
      // Call the method without opening a database or starting a server.
      const worker = Object.create(WorkerService.prototype) as any;
      worker.transcriptWatcher = null;
      const loggedErrors = spyOn(logger, 'error').mockImplementation(() => {});
      try {
        await expect(worker.startTranscriptWatcher({
          ...SettingsDefaultsManager.getAllDefaults(),
          CLAUDE_MEM_TRANSCRIPTS_ENABLED: 'true',
          CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH: configPath,
        })).resolves.toBeUndefined();
        expect(worker.transcriptWatcher).toBeNull();
        expect(loggedErrors).toHaveBeenCalledWith(
          'TRANSCRIPT',
          'Invalid transcript watch config (continuing without transcript ingestion)',
          { configPath },
          expect.any(Error),
        );
      } finally {
        loggedErrors.mockRestore();
      }
    });
  }
});
