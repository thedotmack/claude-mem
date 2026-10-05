import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

// Exercise the production entry point in a child to isolate settings and mode
// state from the process-global mocks in other context tests.
const script = `
  import { mkdirSync, writeFileSync } from 'fs';
  import { join } from 'path';
  import { SessionStore } from './src/services/sqlite/SessionStore.ts';
  import { generateContextWithStats } from './src/services/context/ContextBuilder.ts';
  import { cwdToDashed } from './src/services/context/ObservationCompiler.ts';
  import { ModeManager } from './src/services/domain/ModeManager.ts';
  ModeManager.getInstance().loadMode('code');
  const store = new SessionStore(process.env.CLAUDE_MEM_DATA_DIR + '/claude-mem.db');
  const session = store.createSDKSession('preview-content', 'preview-test', 'prompt');
  store.ensureMemorySessionIdRegistered(session, 'preview-memory');
  for (let i = 0; i < Number(process.env.PREVIEW_COUNT); i++) {
    store.storeObservation('preview-memory', 'preview-test', {
      type: 'discovery', title: 'RECORD_' + String(i).padStart(3, '0') + ' ' + 'x'.repeat(Number(process.env.PREVIEW_TITLE_LENGTH)),
      subtitle: null, narrative: process.env.PREVIEW_NARRATIVE === 'true'
        ? 'DETAIL_' + String(i).padStart(3, '0') + '_START\\n#123 looks like a row\\nDETAIL_' + String(i).padStart(3, '0') + '_END'
        : 'narrative', facts: [], concepts: ['how-it-works'],
      files_read: [], files_modified: ['src/record-' + i + '.ts'],
    }, 1, 100, 1_700_000_000_000 + (process.env.PREVIEW_SAME_MINUTE === 'true' ? 0 : i * 60_000));
  }
  store.close();
  if (Number(process.env.PREVIEW_MESSAGE_LENGTH) > 0) {
    const dir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', cwdToDashed('/preview-test'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'preview-content.jsonl'), JSON.stringify({
      type: 'assistant', message: { content: [{ type: 'text', text: 'PRIOR_MESSAGE ' + 'm'.repeat(Number(process.env.PREVIEW_MESSAGE_LENGTH)) }] },
    }) + '\\n');
  }
  const input = { projects: ['preview-test'], cwd: process.env.PREVIEW_MESSAGE_LENGTH === '0' ? process.cwd() : '/preview-test' };
  const model = await generateContextWithStats(input);
  const preview = await generateContextWithStats(input, true);
  const fullPreview = await generateContextWithStats({ ...input, full: true }, true);
  console.log(JSON.stringify({ model, preview, fullPreview }));
`;

function generate(count: number, options: { narrative?: boolean; messageLength?: number; titleLength?: number; sameMinute?: boolean } = {}) {
  const dataDir = mkdtempSync(join(import.meta.dir, '.preview-4252-'));
  try {
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({
      CLAUDE_MEM_CONTEXT_OBSERVATIONS: '50',
      CLAUDE_MEM_CONTEXT_FULL_COUNT: options.narrative ? '50' : '0',
      CLAUDE_MEM_CONTEXT_SESSION_COUNT: '0',
      CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY: 'false',
      CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE: options.messageLength ? 'true' : 'false',
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
        PREVIEW_NARRATIVE: String(Boolean(options.narrative)),
        PREVIEW_SAME_MINUTE: String(Boolean(options.sameMinute)),
        PREVIEW_MESSAGE_LENGTH: String(options.messageLength ?? 0),
        PREVIEW_TITLE_LENGTH: String(options.titleLength ?? 120),
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
    expect(preview.text).toContain('additional observations are not shown here');
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
    const withoutRenderTime = (text: string) => text.replace(/(\[preview-test\] recent context, )[^\n]+/, '$1<rendered-at>');
    expect(withoutRenderTime(preview.text)).toBe(withoutRenderTime(fullPreview.text));
    expect(preview.text).not.toContain('Terminal preview truncated');
  }, 15_000);

  it('restores the date and file heading for the first retained observation', () => {
    const { preview } = generate(50);
    const first = records(preview.text)[0];
    const firstIndex = preview.text.indexOf(first);
    const preceding = preview.text.slice(preview.text.indexOf('Terminal preview truncated'), firstIndex);
    expect(preceding).toMatch(/[A-Z][a-z]{2} \d{1,2}, 20\d\d/);
    expect(preceding).toContain(`src/record-${Number(first.slice(-3))}.ts`);
    expect(firstIndex).toBeGreaterThan(preview.text.indexOf('Terminal preview truncated'));
  }, 15_000);

  it('shows the time on the first retained same-minute row without changing the full rendering', () => {
    for (const narrative of [false, true]) {
      const { model, preview, fullPreview } = generate(50, { narrative, sameMinute: true, titleLength: narrative ? 60 : 120 });
      const visible = records(preview.text);
      expect(visible.length).toBeGreaterThan(0);
      expect(visible.length).toBeLessThan(model.stats.observation_count);
      expect(visible).toEqual(records(model.text).slice(-visible.length));
      const first = visible[0];
      const firstRow = preview.text.split('\n').find(line => line.includes(first))!;
      const untruncatedRow = fullPreview.text.split('\n').find(line => line.includes(first))!;
      const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, '');
      expect(plain(firstRow)).toMatch(/\d{1,2}:\d{2} [AP]M/);
      expect(plain(untruncatedRow)).not.toMatch(/\d{1,2}:\d{2} [AP]M/);
      if (narrative) expect(preview.text).toContain(`DETAIL_${first.slice(-3)}_START`);
      expect(preview.text.length).toBeLessThanOrEqual(10_000);
    }
  }, 30_000);

  it('keeps full rows when a narrative line looks like an observation ID', () => {
    const { model, preview } = generate(50, { narrative: true, titleLength: 60 });
    const visible = records(preview.text);
    expect(preview.text).toContain('Terminal preview truncated');
    expect(visible.length).toBeGreaterThan(0);
    expect(visible).toEqual(records(model.text).slice(-visible.length));
    for (const record of visible) {
      const id = record.slice(-3);
      expect(preview.text).toContain(`DETAIL_${id}_START`);
      expect(preview.text).toContain(`DETAIL_${id}_END`);
    }
    expect(preview.text.indexOf('#123 looks like a row'))
      .toBeGreaterThan(preview.text.indexOf(visible[0]));
    expect(preview.text.length).toBeLessThanOrEqual(10_000);
  }, 15_000);

  it('gives newest observations space before a long prior message', () => {
    const { model, preview, fullPreview } = generate(10, { messageLength: 8_500, titleLength: 180 });
    expect(model.stats.observation_count).toBeGreaterThan(1);
    expect(fullPreview.text).toContain('PRIOR_MESSAGE');
    expect(fullPreview.text.length).toBeGreaterThan(10_000);
    expect(preview.text).toContain('Terminal preview truncated');
    expect(preview.text).toContain(`Loading: ${model.stats.observation_count} observations`);
    expect(preview.text.length).toBeLessThanOrEqual(10_000);
    expect(records(preview.text).length).toBeGreaterThan(0);
    expect(records(preview.text)).toEqual(records(model.text).slice(-records(preview.text).length));
    expect(preview.text).toContain('Previously');
    expect(preview.text).toContain('PRIOR_MESSAGE');
    expect(preview.text).not.toContain('m'.repeat(8_500));
    expect(preview.text).toContain('Access ');
  }, 15_000);

  it('reports presentation-only truncation when every selected observation remains visible', () => {
    const { model, preview, fullPreview } = generate(3, { messageLength: 9_000, titleLength: 80 });
    expect(model.stats.observation_count).toBe(3);
    expect(fullPreview.text.length).toBeGreaterThan(10_000);
    expect(preview.text.length).toBeLessThanOrEqual(10_000);
    expect(preview.text).toContain('Loading: 3 observations');
    expect(preview.text).toContain('Terminal preview truncated');
    expect(preview.text).toContain('some presentation text is not shown here');
    expect(preview.text).not.toContain('additional observations are not shown here');
    expect(records(preview.text)).toEqual(records(model.text));
    expect(preview.text).toContain('PRIOR_MESSAGE');
    expect(preview.text).not.toContain('m'.repeat(9_000));
    expect(preview.stats).toEqual(model.stats);
  }, 15_000);
});
