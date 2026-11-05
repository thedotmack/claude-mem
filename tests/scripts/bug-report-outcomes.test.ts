import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const entry = pathToFileURL(join(import.meta.dir, '../../scripts/bug-report/index.ts')).href;
const collector = pathToFileURL(join(import.meta.dir, '../../scripts/bug-report/collector.ts')).href;
const report = '# Fixture report\n\nComplete fixture body.';
const assistant = (text: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const success = (result = report) => ({ type: 'result', subtype: 'success', is_error: false, result });

// Keep SDK and diagnostics mocks in a child so they cannot leak into other suites.
// No real provider, host diagnostics, or credentials are read by this fixture.
function generate(messages: unknown[], throws = false) {
  const home = mkdtempSync(join(tmpdir(), 'cmem-bug-report-outcomes-'));
  try {
    const child = spawnSync(process.execPath, ['-e', `
      import { mock } from 'bun:test';
      const diagnosticCalls = [];
      mock.module(${JSON.stringify(collector)}, () => ({
        collectDiagnostics: async options => { diagnosticCalls.push(options); return {}; },
        formatDiagnostics: () => '## Environment\\n\\nSynthetic diagnostics.',
      }));
      mock.module('@anthropic-ai/claude-agent-sdk', () => ({
        query: async function* () {
          for (const message of ${JSON.stringify(messages)}) yield message;
          if (${throws}) throw new Error('fixture transport failure');
        },
      }));
      const { generateBugReport } = await import(${JSON.stringify(entry)});
      const result = await generateBugReport({
        issueDescription: 'Fixture worker fails to start',
        expectedBehavior: 'Worker starts',
        stepsToReproduce: 'Run fixture',
        includeLogs: false,
      });
      console.log('RESULT=' + JSON.stringify({ result, diagnosticCalls }));
    `], {
      cwd: join(import.meta.dir, '../..'),
      env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_MEM_DATA_DIR: join(home, 'data') },
      encoding: 'utf8', timeout: 10_000,
    });
    expect(child.status, child.stderr).toBe(0);
    return JSON.parse(child.stdout.split('RESULT=')[1]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function expectFallback(messages: unknown[], throws = false) {
  const { result, diagnosticCalls } = generate(messages, throws);
  expect(result.success).toBe(true);
  expect(result.title).toBe('Bug Report');
  expect(result.body).toContain('Fixture worker fails to start');
  expect(result.body).toContain('Worker starts');
  expect(result.body).toContain('Run fixture');
  expect(result.body).toContain('Synthetic diagnostics.');
  expect(result.body).not.toContain('Partial model answer');
  expect(diagnosticCalls.length).toBeGreaterThan(0);
  expect(diagnosticCalls.every((options: { includeLogs: boolean }) => options.includeLogs === false)).toBe(true);
}

describe('bug report formatter SDK outcomes', () => {
  for (const subtype of ['error_during_execution', 'error_max_turns', 'error_max_budget_usd', 'error_max_structured_output_retries']) {
    it(`uses the template for ${subtype} instead of accepting a partial answer`, () => {
      expectFallback([assistant('# Partial model answer'), { type: 'result', subtype, is_error: true, errors: ['fixture failure'] }]);
    });
  }

  it('uses the template for an error subtype even when is_error is false', () => {
    expectFallback([assistant('# Partial model answer'), { type: 'result', subtype: 'error_max_turns', is_error: false }]);
  });

  it('uses the template for an is_error result even with the success subtype', () => {
    expectFallback([{ ...success(), is_error: true }]);
  });

  it('uses the template when the stream ends without a terminal result', () => {
    expectFallback([assistant('# Partial model answer')]);
  });

  it('uses the template for an empty stream', () => { expectFallback([]); });
  it('uses the template for a successful result with no report text', () => { expectFallback([success('')]); });
  it('uses the template for whitespace-only report text', () => { expectFallback([assistant(' \n '), success('')]); });
  it('keeps the existing template fallback when the SDK throws', () => { expectFallback([], true); });

  it('keeps a successful terminal report', () => {
    expect(generate([success()]).result).toEqual({ title: 'Fixture report', body: report, success: true });
  });
  it('keeps assistant text followed by a successful terminal result', () => {
    expect(generate([assistant(report), success('')]).result.body).toBe(report);
  });
  it('keeps streamed text followed by a successful terminal result', () => {
    const chunks = [
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '# Fixture report\n\n' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Complete fixture body.' } } },
      success(''),
    ];
    expect(generate(chunks).result.body).toBe(report);
  });
});
