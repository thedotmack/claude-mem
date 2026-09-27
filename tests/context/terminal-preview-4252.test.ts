import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

// Exercise the production entry point in a child to isolate settings and mode
// state from the process-global mocks in other context tests.
const script = `
  import { SessionStore } from './src/services/sqlite/SessionStore.ts';
  import { generateContextWithStats } from './src/services/context/ContextBuilder.ts';
  import { ModeManager } from './src/services/domain/ModeManager.ts';
  ModeManager.getInstance().loadMode('code');
  const store = new SessionStore(process.env.CLAUDE_MEM_DATA_DIR + '/claude-mem.db');
  const session = store.createSDKSession('preview-content', 'preview-test', 'prompt');
  store.ensureMemorySessionIdRegistered(session, 'preview-memory');
  for (let i = 0; i < Number(process.env.PREVIEW_COUNT); i++) {
    store.storeObservation('preview-memory', 'preview-test', {
      type: 'discovery', title: 'RECORD_' + String(i).padStart(3, '0') + ' ' + 'x'.repeat(120),
      subtitle: null, narrative: 'narrative', facts: [], concepts: ['how-it-works'],
      files_read: [], files_modified: ['src/record-' + i + '.ts'],
    }, 1, 100, 1_700_000_000_000 + i * 60_000);
  }
  store.close();
  const input = { projects: ['preview-test'] };
  const model = await generateContextWithStats(input);
  const preview = await generateContextWithStats(input, true);
  const fullPreview = await generateContextWithStats({ ...input, full: true }, true);
  console.log(JSON.stringify({ model, preview, fullPreview }));
`;

function generate(count: number) {
  const dataDir = mkdtempSync(join(import.meta.dir, '.preview-4252-'));
  try {
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({
      CLAUDE_MEM_CONTEXT_OBSERVATIONS: '50',
      CLAUDE_MEM_CONTEXT_FULL_COUNT: '0',
      CLAUDE_MEM_CONTEXT_SESSION_COUNT: '0',
      CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY: 'false',
      CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE: 'false',
      CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS: 'true',
      CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS: 'true',
    }));
    const child = Bun.spawnSync([process.execPath, '-e', script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CLAUDE_MEM_DATA_DIR: dataDir,
        CLAUDE_CONFIG_DIR: dataDir,
        CLAUDE_MEM_MODES_DIR: join(process.cwd(), 'plugin', 'modes'),
        PREVIEW_COUNT: String(count),
      },
    });
    if (child.exitCode !== 0) throw new Error(child.stderr.toString());
    return JSON.parse(child.stdout.toString().trim());
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

const records = (text: string): string[] => text.match(/RECORD_\d{3}/g) ?? [];

describe('terminal preview shares the model selection (#4252)', () => {
  it('truncates verbose presentation without selecting fewer observations', () => {
    const { model, preview, fullPreview } = generate(50);
    expect(model.text.length).toBeLessThanOrEqual(10_000);
    expect(model.stats.observation_count).toBe(50);
    expect(records(model.text)).toHaveLength(50);
    expect(fullPreview.text.length).toBeGreaterThan(10_000);
    expect(records(fullPreview.text)).toEqual(records(model.text));
    expect(preview.stats).toEqual(model.stats);
    expect(preview.text).toContain('Loading: 50 observations');
    expect(preview.text.length).toBeLessThanOrEqual(10_000);
    expect(preview.text).toContain('Terminal preview truncated');
    expect(preview.text).toContain('model received the full selected context, including additional observations');
    expect(records(preview.text).length).toBeGreaterThan(0);
    expect(records(preview.text).length).toBeLessThan(50);
    const visible = records(preview.text);
    expect(visible).toEqual(records(model.text).slice(-visible.length));
    expect(visible).toContain('RECORD_049');
    expect(visible).not.toContain('RECORD_000');
    // Header count still describes the model selection, and trailing context
    // remains after the newest timeline entry.
    const noticeStart = preview.text.indexOf('\x1b[0m\n\n[Terminal preview truncated');
    expect(noticeStart).toBeGreaterThan(0);
    expect(fullPreview.text.startsWith(preview.text.slice(0, noticeStart))).toBe(true);
    expect(preview.text.indexOf('RECORD_049')).toBeGreaterThan(noticeStart);
    expect(preview.text).toContain('Access ');
    expect(preview.text.slice(preview.text.lastIndexOf('Access ')))
      .toBe(fullPreview.text.slice(fullPreview.text.lastIndexOf('Access ')));
    for (const line of preview.text.split('\n').filter(line => line.includes('RECORD_'))) {
      expect(fullPreview.text.split('\n')).toContain(line);
    }
    expect(model.text).not.toContain('Terminal preview truncated');
    expect(fullPreview.text).not.toContain('Terminal preview truncated');
  }, 15_000);

  it('shows the whole selected set with no disclaimer when the preview fits', () => {
    const { model, preview, fullPreview } = generate(3);
    expect(preview.text.length).toBeLessThanOrEqual(10_000);
    expect(preview.stats).toEqual(model.stats);
    expect(preview.text).toContain('Loading: 3 observations');
    expect(records(preview.text)).toEqual(records(model.text));
    expect(records(preview.text)).toHaveLength(3);
    expect(preview.text).toBe(fullPreview.text);
    expect(preview.text).not.toContain('Terminal preview truncated');
  }, 15_000);
});
