import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import * as realRuntimeSelector from '../../../src/services/hooks/runtime-selector.js';
import * as realWorkerUtils from '../../../src/shared/worker-utils.js';

const realRuntimeSelectorSnapshot = { ...realRuntimeSelector };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };

// The Stop hook spools and exits: no awaited worker call, only the nudge. The worker host is the
// real setting unless a test moves the worker to another machine.
let workerHostForTest: string | null = null;
mock.module('../../../src/shared/worker-utils.js', () => ({
  ...realWorkerUtilsSnapshot,
  workerHttpRequest: () => Promise.resolve(new Response('{"status":"draining"}', { status: 202 })),
  getWorkerHost: () => workerHostForTest ?? realWorkerUtilsSnapshot.getWorkerHost(),
}));
mock.module('../../../src/services/hooks/runtime-selector.js', () => ({
  ...realRuntimeSelectorSnapshot,
  resolveRuntimeContext: () => ({ runtime: 'worker' }),
}));

import { claudeCodeAdapter } from '../../../src/cli/adapters/claude-code.js';
import { logger } from '../../../src/utils/logger.js';
import { resolveDeliverablesDir } from '../../../src/shared/deliverables.js';
import { spooledEntries, useTempHookSpoolDataDir } from '../../helpers/temp-hook-spool.js';
import type { SpooledDeliverablesPayload } from '../../../src/shared/hook-spool.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];
let tempSpool: ReturnType<typeof useTempHookSpoolDataDir>;
let repo: string;
let outside: string;
let transcriptPath: string;
const savedEnabled = process.env.CLAUDE_MEM_DELIVERABLES_ENABLED;

const user = (content: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ type: 'user', message: { role: 'user', content }, ...extra });
const assistant = (content: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ type: 'assistant', timestamp: '2026-10-26T20:00:00.000Z', message: { role: 'assistant', content }, ...extra });
const toolUse = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input });
const toolResult = (id: string) => ({ type: 'tool_result', tool_use_id: id, content: 'ok' });

/**
 * A repository that ignores .scratch/, with this turn's files already on disk, and the transcript that wrote them.
 * `sidechain` writes the transcript the way Claude Code writes a subagent's own file: isSidechain on every entry.
 */
function makeTurn({ prompt = 'Make me a launch report', sidechain = false }: { prompt?: string; sidechain?: boolean } = {}): void {
  execFileSync('git', ['init', '-q'], { cwd: repo });
  writeFileSync(join(repo, '.gitignore'), '.scratch/\n');
  for (const folder of ['.scratch', 'src', 'out']) mkdirSync(join(repo, folder), { recursive: true });
  writeFileSync(join(repo, '.scratch', 'report.html'), '<h1>Launch report</h1>');
  writeFileSync(join(repo, 'src', 'page.html'), '<p>a component</p>');
  writeFileSync(join(repo, 'src', 'index.ts'), 'export {}');
  writeFileSync(join(repo, 'out', 'slides.pdf'), '%PDF-1.4 slides');
  writeFileSync(join(outside, 'notes.md'), '# Launch notes');
  const workState = {
    list: 'launch',
    fields: {
      task: 'report', status: 'done',
      work_product: JSON.stringify([{ title: 'Launch notes', path: join(outside, 'notes.md') }, { title: 'Spec', url: 'https://example.com/spec' }]),
      output_pdf: 'out/slides.pdf',
      source_doc: 'src/index.ts',
      summary: 'done',
    },
  };
  const extra = sidechain ? { isSidechain: true, agentId: 'agent-7' } : {};
  writeFileSync(transcriptPath, [
    user(prompt, extra),
    assistant([toolUse('toolu_1', 'Write', { file_path: join(repo, '.scratch', 'report.html'), content: '' })], extra),
    user([toolResult('toolu_1')], extra),
    assistant([toolUse('toolu_2', 'Write', { file_path: join(repo, 'src', 'page.html'), content: '' })], extra),
    user([toolResult('toolu_2')], extra),
    assistant([toolUse('toolu_3', 'Write', { file_path: join(repo, 'src', 'index.ts'), content: '' })], extra),
    user([toolResult('toolu_3')], extra),
    assistant([toolUse('toolu_4', 'mcp__plugin_claude-mem_mcp-search__work_state_write', workState)], extra),
    user([toolResult('toolu_4')], extra),
    assistant([{ type: 'text', text: 'Done.' }], extra),
    '',
  ].join('\n'));
}

function stopInput(extra: Record<string, unknown> = {}) {
  const input = claudeCodeAdapter.normalizeInput({
    session_id: 'session-deliverables-1',
    cwd: repo,
    transcript_path: transcriptPath,
    last_assistant_message: 'Done.',
    ...extra,
  });
  input.platform = 'claude-code';
  return input;
}

beforeEach(() => {
  tempSpool = useTempHookSpoolDataDir();
  repo = mkdtempSync(join(tmpdir(), 'claude-mem-deliverables-repo-'));
  outside = mkdtempSync(join(tmpdir(), 'claude-mem-deliverables-outside-'));
  transcriptPath = join(outside, 'transcript.jsonl');
  delete process.env.CLAUDE_MEM_DELIVERABLES_ENABLED;
  workerHostForTest = null;
  loggerSpies = [
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  loggerSpies.forEach(spy => spy.mockRestore());
  tempSpool.restore();
  rmSync(repo, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  if (savedEnabled === undefined) delete process.env.CLAUDE_MEM_DELIVERABLES_ENABLED;
  else process.env.CLAUDE_MEM_DELIVERABLES_ENABLED = savedEnabled;
});

afterAll(() => {
  mock.module('../../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
  mock.module('../../../src/services/hooks/runtime-selector.js', () => realRuntimeSelectorSnapshot);
});

describe('Stop hook deliverables capture', () => {
  it('copies the turn\'s declared files and its human-openable files outside the source tree into the project bucket, then spools them', async () => {
    makeTurn();
    const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');

    const result = await summarizeHandler.execute(stopInput());
    expect(result.continue).toBe(true);

    const entries = spooledEntries('deliverables');
    expect(entries).toHaveLength(1);
    expect(spooledEntries('summarize')).toHaveLength(1);
    const payload = entries[0].payload as SpooledDeliverablesPayload;
    expect(payload.contentSessionId).toBe('session-deliverables-1');
    expect(payload.platformSource).toBe('claude');
    expect(payload.cwd).toBe(repo);
    expect(payload.project).toBeTruthy();
    expect(payload.errors).toBeUndefined();

    const bySource = new Map(payload.files.map(file => [file.sourcePath, file]));
    // Attached through work_product: any extension, with the agent's title.
    expect(bySource.get(join(outside, 'notes.md'))).toMatchObject({ title: 'Launch notes', kind: 'document', declared: true, list: 'launch', field: 'work_product' });
    // Attached through any field whose value is a file a person opens.
    expect(bySource.get(join(repo, 'out', 'slides.pdf'))).toMatchObject({ title: 'slides.pdf', kind: 'document', declared: true, field: 'output_pdf' });
    // Written into a git-ignored folder: inferred.
    expect(bySource.get(join(repo, '.scratch', 'report.html'))).toMatchObject({ title: 'report.html', kind: 'page', declared: false, toolUseId: 'toolu_1' });
    // A source file is never a deliverable by inference, nor by a field that is not work product.
    expect(bySource.has(join(repo, 'src', 'page.html'))).toBe(false);
    expect(bySource.has(join(repo, 'src', 'index.ts'))).toBe(false);
    expect(payload.files).toHaveLength(3);

    for (const file of payload.files) {
      expect(file.bucketPath.startsWith(resolveDeliverablesDir())).toBe(true);
      expect(file.bucketPath).toMatch(/-[a-f0-9]{8}\.(?:md|pdf|html)$/);
      expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(readFileSync(file.bucketPath)).toEqual(readFileSync(file.sourcePath));
    }
  });

  it('is a no-op for a turn that made nothing, and spools nothing when turned off', async () => {
    makeTurn();
    const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');

    process.env.CLAUDE_MEM_DELIVERABLES_ENABLED = 'false';
    await summarizeHandler.execute(stopInput());
    expect(spooledEntries('deliverables')).toHaveLength(0);
    expect(existsSync(resolveDeliverablesDir())).toBe(false);
    expect(spooledEntries('summarize')).toHaveLength(1);

    delete process.env.CLAUDE_MEM_DELIVERABLES_ENABLED;
    writeFileSync(transcriptPath, [user('Thanks'), assistant([{ type: 'text', text: 'You are welcome.' }]), ''].join('\n'));
    tempSpool.restore();
    tempSpool = useTempHookSpoolDataDir();
    await summarizeHandler.execute(stopInput());
    expect(spooledEntries('deliverables')).toHaveLength(0);
  });

  it('records a subagent\'s deliverables from its own transcript at SubagentStop, whose entries are all sidechain', async () => {
    makeTurn({ sidechain: true });
    const mainTranscript = join(outside, 'main.jsonl');
    writeFileSync(mainTranscript, [user('Have an agent make the launch report'), assistant([toolUse('toolu_a', 'Agent', { prompt: 'Make the launch report' })]), ''].join('\n'));
    const { subagentStopHandler } = await import('../../../src/cli/handlers/subagent-stop.js');
    const input = claudeCodeAdapter.normalizeInput({
      session_id: 'session-deliverables-1', cwd: repo, agent_id: 'agent-7', agent_type: 'general-purpose',
      transcript_path: mainTranscript, agent_transcript_path: transcriptPath,
    });
    input.platform = 'claude-code';

    await subagentStopHandler.execute(input);

    expect(spooledEntries('subagent_stop')).toHaveLength(1);
    const [entry] = spooledEntries('deliverables');
    const payload = entry.payload as SpooledDeliverablesPayload;
    expect(payload.agentId).toBe('agent-7');
    expect(payload.files.map(file => file.title).sort()).toEqual(['Launch notes', 'report.html', 'slides.pdf']);
  });

  it('copies nothing for a private turn, at Stop and for the turn\'s subagents', async () => {
    makeTurn({ prompt: '<private>Make me a launch report about the layoffs</private>' });
    const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');
    await summarizeHandler.execute(stopInput());
    expect(spooledEntries('deliverables')).toHaveLength(0);
    expect(existsSync(resolveDeliverablesDir())).toBe(false);

    // The session's current prompt is private; the subagent's own transcript is scanned only when it is not.
    makeTurn({ sidechain: true });
    const mainTranscript = join(outside, 'main.jsonl');
    writeFileSync(mainTranscript, [user('<private>Have an agent write the severance letters</private>'), assistant([{ type: 'text', text: 'On it.' }]), ''].join('\n'));
    const { subagentStopHandler } = await import('../../../src/cli/handlers/subagent-stop.js');
    const input = claudeCodeAdapter.normalizeInput({
      session_id: 'session-deliverables-1', cwd: repo, agent_id: 'agent-7', agent_type: 'general-purpose',
      transcript_path: mainTranscript, agent_transcript_path: transcriptPath,
    });
    input.platform = 'claude-code';
    await subagentStopHandler.execute(input);
    expect(spooledEntries('subagent_stop')).toHaveLength(1);
    expect(spooledEntries('deliverables')).toHaveLength(0);
    expect(existsSync(resolveDeliverablesDir())).toBe(false);
  });

  it('copies a declared file only from the checkout or the temp folders, never through a symlink that leads elsewhere', async () => {
    makeTurn();
    // This repository's own package.json: a readable file outside the test checkout and outside the temp folders.
    const elsewhere = join(import.meta.dir, '..', '..', '..', 'package.json');
    expect(existsSync(elsewhere)).toBe(true);
    let symlinked = false;
    try { symlinkSync(elsewhere, join(repo, '.scratch', 'leak.md')); symlinked = true; } catch { /* no symlinks on this host */ }
    const workState = { list: 'launch', fields: { task: 'report', status: 'done', work_product: JSON.stringify([{ title: 'Keys', path: elsewhere }, { title: 'Leak', path: '.scratch/leak.md' }, { title: 'Report', path: '.scratch/report.html' }]) } };
    writeFileSync(transcriptPath, [
      user('Make me a launch report'),
      assistant([toolUse('toolu_4', 'mcp__plugin_claude-mem_mcp-search__work_state_write', workState)]),
      user([toolResult('toolu_4')]),
      assistant([{ type: 'text', text: 'Done.' }]),
      '',
    ].join('\n'));
    const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');

    await summarizeHandler.execute(stopInput());

    const [entry] = spooledEntries('deliverables');
    const payload = entry.payload as SpooledDeliverablesPayload;
    expect(payload.files.map(file => file.title)).toEqual(['Report']);
    const refused = (logger.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .filter(call => String(call[1]).includes('outside the checkout and the temp folders'))
      .map(call => (call[2] as { path: string }).path);
    expect(refused).toEqual(symlinked ? [elsewhere, join(repo, '.scratch', 'leak.md')] : [elsewhere]);
  });

  it('copies nothing when the session transcript, which carries the turn\'s prompt, cannot be read', async () => {
    makeTurn({ sidechain: true });
    const { subagentStopHandler } = await import('../../../src/cli/handlers/subagent-stop.js');
    const input = claudeCodeAdapter.normalizeInput({
      session_id: 'session-deliverables-1', cwd: repo, agent_id: 'agent-7', agent_type: 'general-purpose',
      transcript_path: join(outside, 'missing-main.jsonl'), agent_transcript_path: transcriptPath,
    });
    input.platform = 'claude-code';
    await subagentStopHandler.execute(input);
    expect(spooledEntries('subagent_stop')).toHaveLength(1);
    expect(spooledEntries('deliverables')).toHaveLength(0);
    expect(existsSync(resolveDeliverablesDir())).toBe(false);
  });

  it('copies nothing when the worker runs on another host, which could not open the copy', async () => {
    makeTurn();
    workerHostForTest = 'memory.example.net';
    const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');
    await summarizeHandler.execute(stopInput());
    expect(spooledEntries('deliverables')).toHaveLength(0);
    expect(existsSync(resolveDeliverablesDir())).toBe(false);
    expect(spooledEntries('summarize')).toHaveLength(1);
  });

  it('copies the first 50 files of an over-full turn and reports the rest within the remote schema\'s bound', async () => {
    execFileSync('git', ['init', '-q'], { cwd: repo });
    writeFileSync(join(repo, '.gitignore'), '.scratch/\n');
    mkdirSync(join(repo, '.scratch'));
    const lines = [user('Render every slide as an image')];
    const total = 50 + 128 + 1;
    for (let i = 0; i < total; i++) {
      const file = join(repo, '.scratch', `slide-${String(i).padStart(3, '0')}.png`);
      writeFileSync(file, `png ${i}`);
      lines.push(assistant([toolUse(`toolu_${i}`, 'Write', { file_path: file, content: '' })]), user([toolResult(`toolu_${i}`)]));
    }
    lines.push(assistant([{ type: 'text', text: 'Done.' }]), '');
    writeFileSync(transcriptPath, lines.join('\n'));
    const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');

    await summarizeHandler.execute(stopInput());

    const [entry] = spooledEntries('deliverables');
    const payload = entry.payload as SpooledDeliverablesPayload;
    expect(payload.files).toHaveLength(50);
    expect(payload.files.map(file => file.title)).toEqual(Array.from({ length: 50 }, (_, i) => `slide-${String(i).padStart(3, '0')}.png`));
    expect(payload.errors).toHaveLength(128);
    expect(payload.errors!.slice(0, 127).every(failure => failure.error.includes('over the 50-file limit'))).toBe(true);
    expect(payload.errors!.at(-1)).toEqual({ sourcePath: '', error: '2 more files were not copied; the hook log names each one' });
    // The event is one a remote worker would accept, so the 50 records are never lost to the error list.
    const { remoteSpoolEnvelopeSchema } = await import('../../../src/shared/hook-spool-remote.js');
    expect(remoteSpoolEnvelopeSchema.safeParse({ protocolVersion: 1, entry }).success).toBe(true);
  });
});
